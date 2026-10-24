"use client";

import { Check, CircleCheck, Clock, LoaderCircle, ShieldCheck } from "lucide-react";
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
const MAX_SEATS = 500;
/**
 * A paid checkout can take several minutes to be confirmed and reach our webhook. Keep the customer on
 * the "payment received" screen (and away from the Pay button) for this long, even across reloads.
 */
const ACTIVATION_WINDOW_MS = 30 * 60_000;
const PENDING_ACTIVATION_KEY = "agentzpro:billing:pending-activation";

/** Check quickly at first (most payments confirm in seconds), then back off. */
function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) {
    return 2_000;
  }
  return elapsedMs < 5 * 60_000 ? 5_000 : 15_000;
}

/**
 * Remembered in this browser between Razorpay's success callback and activation, so a reload keeps the
 * processing screen instead of offering Pay again (a second checkout would replace the paid one).
 */
interface PendingActivation {
  tenantId: string;
  paymentId: string;
  startedAt: number;
  /** The period end before this payment: activation = the webhook wrote a different one. */
  previousPeriodEndsAt: string | null;
}

function readPendingActivation(tenantId: string): PendingActivation | null {
  try {
    const raw = window.localStorage.getItem(PENDING_ACTIVATION_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<PendingActivation> | null;
    if (value?.tenantId !== tenantId) {
      // Another company's payment (shared browser): leave it for that owner.
      return null;
    }
    const valid =
      typeof value.paymentId === "string" &&
      typeof value.startedAt === "number" &&
      (typeof value.previousPeriodEndsAt === "string" || value.previousPeriodEndsAt === null);
    if (!valid || Date.now() - value.startedAt! > ACTIVATION_WINDOW_MS) {
      clearPendingActivation();
      return null;
    }
    return value as PendingActivation;
  } catch {
    return null;
  }
}

function savePendingActivation(pending: PendingActivation): void {
  try {
    window.localStorage.setItem(PENDING_ACTIVATION_KEY, JSON.stringify(pending));
  } catch {
    // Storage blocked (private mode): the screen still works until the tab is reloaded.
  }
}

function clearPendingActivation(): void {
  try {
    window.localStorage.removeItem(PENDING_ACTIVATION_KEY);
  } catch {
    // Nothing to clear.
  }
}

function isActivated(
  status: { subscriptionStatus: string; hasCrmAccess: boolean; currentPeriodEndsAt: string | null },
  previousPeriodEndsAt: string | null,
): boolean {
  return status.subscriptionStatus === "active" && status.hasCrmAccess && status.currentPeriodEndsAt !== previousPeriodEndsAt;
}

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
  | { kind: "activating"; pending: PendingActivation }
  | { kind: "activation_delayed"; pending: PendingActivation; checking: boolean; stillPending: boolean }
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

function ProcessingStep({ state, title, detail }: Readonly<{ state: "done" | "active" | "pending"; title: string; detail: string }>) {
  return (
    <li className={`billing-processing__step billing-processing__step--${state}`} aria-current={state === "active" ? "step" : undefined}>
      <span className="billing-processing__dot" aria-hidden="true">
        {state === "done" ? <Check size={14} strokeWidth={3} /> : null}
        {state === "active" ? <LoaderCircle className="spin" size={16} strokeWidth={2.5} /> : null}
      </span>
      <span className="billing-processing__step-text">
        <span className="billing-processing__step-title">{title}</span>
        <span className="billing-processing__step-detail">{detail}</span>
      </span>
    </li>
  );
}

function PaymentReference({ paymentId }: Readonly<{ paymentId: string }>) {
  return (
    <p className="billing-processing__reference">
      <span>Payment reference</span>
      <code>{paymentId}</code>
    </p>
  );
}

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
  // Pay stays disabled until we have checked this browser for a payment that is still being activated.
  const [pendingChecked, setPendingChecked] = useState(false);
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

  function finishActivation(): void {
    clearPendingActivation();
    if (embedded) {
      // Already inside the CRM: just show the new plan.
      setPhase({ kind: "idle" });
      reload();
    } else {
      router.replace("/leads");
      router.refresh();
    }
  }

  async function waitForActivation(pending: PendingActivation): Promise<void> {
    pollAbort.current?.abort();
    const controller = new AbortController();
    pollAbort.current = controller;
    setPhase({ kind: "activating", pending });
    const deadline = pending.startedAt + ACTIVATION_WINDOW_MS;

    while (Date.now() < deadline && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs(Date.now() - pending.startedAt)));
      if (controller.signal.aborted) {
        return;
      }
      try {
        const status = await getBillingStatus(controller.signal);
        if (isActivated(status, pending.previousPeriodEndsAt)) {
          finishActivation();
          return;
        }
      } catch {
        // A failed poll is not a failed payment; keep waiting until the deadline.
      }
    }

    if (!controller.signal.aborted) {
      clearPendingActivation();
      setPhase({ kind: "activation_delayed", pending, checking: false, stillPending: false });
    }
  }

  /** "Check again" on the delayed screen: never falls back to the Pay button by itself. */
  async function checkActivationAgain(pending: PendingActivation): Promise<void> {
    setPhase({ kind: "activation_delayed", pending, checking: true, stillPending: false });
    try {
      if (isActivated(await getBillingStatus(), pending.previousPeriodEndsAt)) {
        finishActivation();
        return;
      }
    } catch {
      // Treated as "not yet": the customer can try again.
    }
    setPhase({ kind: "activation_delayed", pending, checking: false, stillPending: true });
  }

  function handlePaymentSuccess(paymentId: string): void {
    const pending: PendingActivation = {
      tenantId: overview.tenantId,
      paymentId,
      startedAt: Date.now(),
      previousPeriodEndsAt: overview.currentPeriodEndsAt,
    };
    savePendingActivation(pending);
    void waitForActivation(pending);
  }

  // Resume a payment made before a reload (or in an earlier visit) that is still being activated.
  // Storage is read after mount (the server has no localStorage), and the cancel flag keeps a remount
  // from starting a second wait.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      const pending = overview.isOwner ? readPendingActivation(overview.tenantId) : null;
      if (pending && isActivated(overview, pending.previousPeriodEndsAt)) {
        clearPendingActivation();
      } else if (pending) {
        void waitForActivation(pending);
      }
      setPendingChecked(true);
    });
    return () => {
      cancelled = true;
    };
    // Once per company: the overview refreshes while we wait and must not restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.tenantId]);

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
        handler: (response) => handlePaymentSuccess(response.razorpay_payment_id),
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

  if (phase.kind === "activating") {
    return (
      <div className={embedded ? "billing-panel" : "auth-card billing-card"}>
        <div className="billing-processing" role="status" aria-live="polite">
          <div className="billing-processing__badge">
            <CircleCheck size={34} strokeWidth={2.25} aria-hidden="true" />
          </div>
          <div className="billing-processing__intro">
            <h1 className="auth-card__title">Your payment is processing</h1>
            <p className="auth-card__subtitle">
              Thank you! Your payment is being processed, and we will activate your plan for{" "}
              <strong>{overview.companyName}</strong> as soon as it is confirmed.
            </p>
          </div>
          <ol className="billing-processing__steps" aria-label="Activation progress">
            <ProcessingStep state="done" title="Payment submitted" detail="Thank you, we have your payment." />
            <ProcessingStep state="active" title="Activating your plan" detail="This usually takes a few minutes." />
            <ProcessingStep state="pending" title="Ready to use" detail="We will open your CRM automatically." />
          </ol>
          <div className="billing-processing__note">
            <ShieldCheck size={20} aria-hidden="true" />
            <p>
              <strong>Your payment is safe, so please do not pay again.</strong> You can stay on this page or come back later;
              your plan turns on automatically.
            </p>
          </div>
          <PaymentReference paymentId={phase.pending.paymentId} />
        </div>
      </div>
    );
  }

  if (phase.kind === "activation_delayed") {
    const { pending } = phase;
    return (
      <div className={embedded ? "billing-panel" : "auth-card billing-card"}>
        <div className="billing-processing" role="status" aria-live="polite">
          <div className="billing-processing__badge billing-processing__badge--calm">
            <ShieldCheck size={34} strokeWidth={2.25} aria-hidden="true" />
          </div>
          <div className="billing-processing__intro">
            <h1 className="auth-card__title">Your payment is safe</h1>
            <p className="auth-card__subtitle">
              Activation is taking a little longer than usual. You do not need to pay again: your plan turns on as soon as
              the payment is confirmed.
            </p>
          </div>
          <div className="billing-processing__note billing-processing__note--calm">
            <Clock size={20} aria-hidden="true" />
            <p>
              If it is still not active soon, contact us with the payment reference below and we will sort it out right
              away.
            </p>
          </div>
          <PaymentReference paymentId={pending.paymentId} />
          {phase.stillPending ? (
            <p className="billing-processing__hint">Still being confirmed. Please check again in a few minutes.</p>
          ) : null}
          <div className="billing-processing__actions">
            <button className="button" type="button" onClick={() => void checkActivationAgain(pending)} disabled={phase.checking}>
              {phase.checking ? "Checking…" : "Check again"}
            </button>
            <Link className="button button--secondary" href="/contact">
              Contact us
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const currentPlan = overview.currentPlan;
  // Autopay has stopped (cancelled here, on the customer's phone, or halted after failed charges).
  const planEnding =
    currentPlan !== null &&
    (currentPlan.cancelAtPeriodEnd || currentPlan.razorpayStatus === "halted" || currentPlan.razorpayStatus === "cancelled");
  const periodLabel = planEnding ? "Access ends on" : "Renews on";

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
                Your plan will not renew, and the company keeps access until {formatDate(overview.currentPeriodEndsAt)}. Payments
                already made are not refunded.
              </p>
              <div className="billing-cancel__actions">
                <button className="button button--secondary" type="button" onClick={() => setConfirmingCancel(false)} disabled={cancelState.busy}>
                  Keep plan
                </button>
                <button className="button billing-cancel__confirm" type="button" onClick={() => void handleCancel()} disabled={cancelState.busy}>
                  {cancelState.busy ? "Cancelling…" : "Yes, cancel auto-renewal"}
                </button>
              </div>
            </>
          ) : (
            <button className="button button--secondary" type="button" onClick={() => setConfirmingCancel(true)}>
              Cancel auto-renewal
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
              <span className="billing-offer__badge">{planEnding ? "Ending" : "Your plan"}</span>
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

              <button className="button billing-offer__cta" type="button" onClick={() => void handlePay()} disabled={!pendingChecked || phase.kind === "starting"}>
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
