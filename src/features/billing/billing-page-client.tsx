"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PLAN_FEATURES } from "@/features/billing/plan-features";
import type { BillingOverview } from "@/lib/server/billing-service";
import { cancelSubscriptionAtPeriodEnd, getBillingStatus, startCheckout } from "@/services/billing-api-client";

/**
 * Billing screen. The browser's only jobs: collect the plan + seats, open Razorpay Checkout for the
 * subscription our server created, and then WAIT for the webhook — it never unlocks anything itself.
 */

const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;
const MAX_SEATS = 500;

interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  handler: (response: RazorpayCheckoutResponse) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "activating" }
  | { kind: "activation_delayed" }
  | { kind: "error"; message: string };

function formatRupees(paise: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits }).format(paise / 100);
}

/** "Pro Monthly" → "Pro": the period is shown by the Monthly / Yearly switch instead. */
function tierName(planName: string): string {
  return planName.replace(/\s*(monthly|yearly)\s*$/i, "") || planName;
}

function PlanFeatures({ heading }: Readonly<{ heading: string }>) {
  return (
    <div className="billing-offer__features">
      <p>{heading}</p>
      <ul>
        {PLAN_FEATURES.map((feature) => (
          <li key={feature}>
            <Check size={16} aria-hidden="true" />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

const STATUS_LABELS: Record<string, string> = {
  trialing: "Free trial",
  active: "Active",
  blocked: "Inactive",
};

export interface BillingPageClientProps {
  overview: BillingOverview;
  /**
   * Rendered inside Settings → Billing instead of the standalone /billing page: no card, title or
   * page links, and no payment history (Settings has its own Invoices section).
   */
  embedded?: boolean;
  /** Embedded only: reload the overview after a change (the page reloads itself with router.refresh). */
  onChanged?: () => void;
}

export function BillingPageClient({ overview, embedded = false, onChanged }: Readonly<BillingPageClientProps>) {
  const router = useRouter();
  const reload = () => (onChanged ? onChanged() : router.refresh());
  const minimumSeats = Math.max(1, overview.seats.activeMembers);
  const [planCode, setPlanCode] = useState<string | null>(overview.plans[0]?.planCode ?? null);
  const [seats, setSeats] = useState(minimumSeats);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelState, setCancelState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => () => pollAbort.current?.abort(), []);

  const selectedPlan = useMemo(() => overview.plans.find((plan) => plan.planCode === planCode) ?? null, [overview.plans, planCode]);
  const totalPaise = selectedPlan ? selectedPlan.pricePerSeatPaise * seats : 0;
  const isYearly = selectedPlan?.billingPeriod === "yearly";
  // Monthly first, then yearly: the order of the switch.
  const periodPlans = useMemo(
    () => [...overview.plans].sort((a, b) => (a.billingPeriod === b.billingPeriod ? 0 : a.billingPeriod === "monthly" ? -1 : 1)),
    [overview.plans],
  );

  async function waitForActivation(): Promise<void> {
    setPhase({ kind: "activating" });
    const controller = new AbortController();
    pollAbort.current = controller;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const status = await getBillingStatus(controller.signal);
        // Activated = the webhook has written a paid period that differs from what we started with.
        if (status.subscriptionStatus === "active" && status.hasCrmAccess && status.currentPeriodEndsAt !== overview.currentPeriodEndsAt) {
          if (embedded) {
            // Already inside the CRM: just show the new plan.
            setPhase({ kind: "idle" });
            reload();
          } else {
            router.replace("/leads");
            router.refresh();
          }
          return;
        }
      } catch {
        // A failed poll is not a failed payment; keep waiting until the deadline.
      }
    }

    if (!controller.signal.aborted) {
      setPhase({ kind: "activation_delayed" });
    }
  }

  async function handlePay(): Promise<void> {
    if (!selectedPlan) {
      return;
    }
    setPhase({ kind: "starting" });
    try {
      const [session] = await Promise.all([startCheckout(selectedPlan.planCode, seats), loadCheckoutScript()]);
      if (!window.Razorpay) {
        throw new Error("Razorpay Checkout could not be loaded. Check your connection and try again.");
      }
      const checkout = new window.Razorpay({
        key: session.keyId,
        subscription_id: session.subscriptionId,
        name: "AgentzPro CRM",
        description: `${session.planName} · ${session.seats} ${session.seats === 1 ? "seat" : "seats"} · ${session.companyName}`,
        handler: () => {
          void waitForActivation();
        },
        modal: { ondismiss: () => setPhase({ kind: "idle" }) },
        theme: { color: "#1f6feb" },
      });
      checkout.open();
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Checkout could not be started." });
    }
  }

  async function handleCancel(): Promise<void> {
    setCancelState({ busy: true, error: null });
    try {
      await cancelSubscriptionAtPeriodEnd();
      setConfirmingCancel(false);
      setCancelState({ busy: false, error: null });
      reload();
    } catch (error) {
      setCancelState({ busy: false, error: error instanceof Error ? error.message : "The subscription could not be cancelled." });
    }
  }

  if (phase.kind === "activating" || phase.kind === "activation_delayed") {
    return (
      <div className={embedded ? "billing-panel" : "auth-card billing-card"} aria-live="polite">
        <h1 className="auth-card__title">{phase.kind === "activating" ? "Activating your plan…" : "Payment received"}</h1>
        <p className="auth-card__subtitle">
          {phase.kind === "activating"
            ? "We are confirming your payment with Razorpay. This usually takes a few seconds."
            : "Your plan is being activated and will be ready in a few minutes. You can refresh this page; there is no need to pay again."}
        </p>
        {phase.kind === "activation_delayed" ? (
          <button className="button" type="button" onClick={reload}>
            Refresh
          </button>
        ) : null}
      </div>
    );
  }

  const currentPlan = overview.currentPlan;
  const periodLabel = currentPlan?.cancelAtPeriodEnd ? "Access ends on" : "Renews on";

  return (
    <div className={embedded ? "billing-panel" : "auth-card billing-card"}>
      {embedded ? null : (
        <>
          <h1 className="auth-card__title">Billing</h1>
          <p className="auth-card__subtitle">{overview.companyName}</p>
        </>
      )}

      {!overview.hasCrmAccess ? (
        <p className="auth-error" role="status">
          CRM access for this company is paused. {overview.isOwner ? "Subscribe below to continue." : "Ask your company owner to subscribe."}
        </p>
      ) : null}

      <dl className="auth-billing-summary">
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABELS[overview.subscriptionStatus] ?? overview.subscriptionStatus}</dd>
        </div>
        {overview.subscriptionStatus === "trialing" ? (
          <div>
            <dt>{overview.hasCrmAccess ? "Trial ends" : "Trial ended"}</dt>
            <dd>{formatDate(overview.trialEndsAt)}</dd>
          </div>
        ) : null}
        {currentPlan ? (
          <>
            <div>
              <dt>Seats</dt>
              <dd>
                {overview.seats.activeMembers + overview.seats.pendingInvitations} of {currentPlan.seatQuantity} used
              </dd>
            </div>
            <div>
              <dt>{periodLabel}</dt>
              <dd>{formatDate(overview.currentPeriodEndsAt)}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {overview.isOwner && currentPlan && currentPlan.razorpayStatus === "active" && !currentPlan.cancelAtPeriodEnd ? (
        <div className="billing-cancel">
          {confirmingCancel ? (
            <>
              <p className="auth-card__subtitle">
                Your plan will not renew. The company keeps access until {formatDate(overview.currentPeriodEndsAt)}.
              </p>
              <div className="billing-cancel__actions">
                <button className="button button--secondary" type="button" onClick={() => setConfirmingCancel(false)} disabled={cancelState.busy}>
                  Keep plan
                </button>
                <button className="button billing-cancel__confirm" type="button" onClick={() => void handleCancel()} disabled={cancelState.busy}>
                  {cancelState.busy ? "Cancelling…" : "Cancel at period end"}
                </button>
              </div>
            </>
          ) : (
            <button className="button button--secondary" type="button" onClick={() => setConfirmingCancel(true)}>
              Cancel subscription
            </button>
          )}
          {cancelState.error ? (
            <p className="auth-error" role="alert">
              {cancelState.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {currentPlan ? (
        <section className="billing-offer billing-offer--current" aria-labelledby="billing-current-title">
          <div className="billing-offer__top">
            <div className="billing-offer__head">
              <h2 id="billing-current-title" className="billing-offer__name">
                {tierName(currentPlan.planName)}
              </h2>
              <span className="billing-offer__badge">{currentPlan.cancelAtPeriodEnd ? "Ending" : "Your plan"}</span>
            </div>
            <p className="billing-offer__unit">
              {formatRupees(currentPlan.pricePerSeatPaise)} / seat / {currentPlan.billingPeriod === "yearly" ? "year" : "month"} ·{" "}
              {currentPlan.seatQuantity} {currentPlan.seatQuantity === 1 ? "seat" : "seats"}
            </p>
          </div>
          <PlanFeatures heading={`Included in ${tierName(currentPlan.planName)}:`} />
        </section>
      ) : null}

      {overview.canSubscribe ? (
        !selectedPlan ? (
          <p className="auth-error" role="status">
            Plans are not available right now. Please contact support.
          </p>
        ) : (
          <section className="billing-offer" aria-labelledby="billing-offer-title">
            <div className="billing-offer__top">
              <div className="billing-offer__head">
                <h2 id="billing-offer-title" className="billing-offer__name">
                  {tierName(selectedPlan.planName)}
                </h2>
                {periodPlans.length > 1 ? (
                  <div className="billing-period-toggle" role="radiogroup" aria-label="Billing period">
                    {periodPlans.map((plan) => (
                      <label
                        key={plan.planCode}
                        className={plan.planCode === planCode ? "billing-period-toggle__option billing-period-toggle__option--on" : "billing-period-toggle__option"}
                      >
                        <input
                          type="radio"
                          name="billing-plan"
                          value={plan.planCode}
                          checked={plan.planCode === planCode}
                          onChange={() => setPlanCode(plan.planCode)}
                        />
                        {plan.billingPeriod === "yearly" ? "Yearly" : "Monthly"}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
              <p className="billing-offer__tagline">Capture, qualify and follow up every Meta lead</p>

              {/* key= replays the fade-in whenever the period (and so the price) changes. */}
              <div className="billing-offer__price" key={selectedPlan.planCode}>
                <span className="billing-offer__amount">
                  {formatRupees(isYearly ? selectedPlan.pricePerSeatPaise / 12 : selectedPlan.pricePerSeatPaise, 0)}
                </span>
                <span className="billing-offer__unit">
                  INR / seat / month{isYearly ? ` · ${formatRupees(selectedPlan.pricePerSeatPaise)} per seat billed yearly` : ""}
                </span>
              </div>

              <div className="billing-seats">
                <label htmlFor="billing-seat-count">Seats</label>
                <div className="billing-seats__row">
                  <div className="billing-seats__stepper">
                    <button type="button" aria-label="Remove a seat" onClick={() => setSeats((value) => Math.max(minimumSeats, value - 1))} disabled={seats <= minimumSeats}>
                      −
                    </button>
                    <input
                      id="billing-seat-count"
                      type="number"
                      inputMode="numeric"
                      min={minimumSeats}
                      max={MAX_SEATS}
                      value={seats}
                      onChange={(event) => {
                        const next = Number.parseInt(event.target.value, 10);
                        setSeats(Number.isFinite(next) ? Math.min(MAX_SEATS, Math.max(minimumSeats, next)) : minimumSeats);
                      }}
                    />
                    <button type="button" aria-label="Add a seat" onClick={() => setSeats((value) => Math.min(MAX_SEATS, value + 1))} disabled={seats >= MAX_SEATS}>
                      +
                    </button>
                  </div>
                  {/* aria-live: screen readers hear the new total as seats or the period change. */}
                  <p className="billing-total" aria-live="polite">
                    Total <strong>{formatRupees(totalPaise)}</strong> / {isYearly ? "year" : "month"}
                  </p>
                </div>
                <p className="billing-seats__hint">
                  One seat per person, including you. Your company has {overview.seats.activeMembers}{" "}
                  {overview.seats.activeMembers === 1 ? "member" : "members"}.
                </p>
              </div>

              {phase.kind === "error" ? (
                <p className="auth-error" role="alert">
                  {phase.message}
                </p>
              ) : null}

              <button className="button billing-offer__cta" type="button" onClick={() => void handlePay()} disabled={phase.kind === "starting"}>
                {phase.kind === "starting" ? "Opening checkout…" : `Get ${tierName(selectedPlan.planName)} plan · Pay ${formatRupees(totalPaise)}`}
              </button>
              <p className="billing-offer__fineprint">Renews automatically. Cancel anytime from Billing.</p>
            </div>
            <PlanFeatures heading={`Everything in ${tierName(selectedPlan.planName)}:`} />
          </section>
        )
      ) : null}

      {!overview.isOwner ? <p className="auth-card__subtitle">Only the company owner can manage billing.</p> : null}

      {!embedded && overview.isOwner && overview.payments.length > 0 ? (
        <section className="billing-history" aria-labelledby="billing-history-title">
          <h2 id="billing-history-title" className="billing-checkout__title">
            Payment history ({overview.payments.length})
          </h2>
          {/* Newest first; the list scrolls inside its own box so the page stays short. */}
          <ul className="billing-history__list" tabIndex={0} aria-label="Payments, newest first">
            {overview.payments.map((payment) => (
              <li key={payment.paymentId} className="billing-history__row">
                <span>
                  <strong>{formatRupees(payment.amountPaise)}</strong>
                  <span className="billing-history__meta">
                    {formatDate(payment.paidAt)} · {formatDate(payment.periodStart)} – {formatDate(payment.periodEnd)}
                    {payment.paymentMethod ? ` · ${payment.paymentMethod.toUpperCase()}` : ""}
                  </span>
                </span>
                {payment.invoiceUrl ? (
                  <a href={payment.invoiceUrl} target="_blank" rel="noopener noreferrer">
                    Receipt
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {embedded || !overview.hasCrmAccess ? null : (
        <p className="auth-card__subtitle billing-links">
          <Link href="/leads">Back to CRM</Link>
        </p>
      )}
    </div>
  );
}
