"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
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

export function BillingPageClient({ overview }: Readonly<{ overview: BillingOverview }>) {
  const router = useRouter();
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
          router.replace("/leads");
          router.refresh();
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
      router.refresh();
    } catch (error) {
      setCancelState({ busy: false, error: error instanceof Error ? error.message : "The subscription could not be cancelled." });
    }
  }

  if (phase.kind === "activating" || phase.kind === "activation_delayed") {
    return (
      <div className="auth-card billing-card" aria-live="polite">
        <h1 className="auth-card__title">{phase.kind === "activating" ? "Activating your plan…" : "Payment received"}</h1>
        <p className="auth-card__subtitle">
          {phase.kind === "activating"
            ? "We are confirming your payment with Razorpay. This usually takes a few seconds."
            : "Your plan is being activated and will be ready in a few minutes. You can refresh this page; there is no need to pay again."}
        </p>
        {phase.kind === "activation_delayed" ? (
          <button className="button" type="button" onClick={() => router.refresh()}>
            Refresh
          </button>
        ) : null}
      </div>
    );
  }

  const currentPlan = overview.currentPlan;
  const periodLabel = currentPlan?.cancelAtPeriodEnd ? "Access ends on" : "Renews on";

  return (
    <div className="auth-card billing-card">
      <h1 className="auth-card__title">Billing</h1>
      <p className="auth-card__subtitle">{overview.companyName}</p>

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
              <dt>Plan</dt>
              <dd>{currentPlan.planName}</dd>
            </div>
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

      {overview.canSubscribe ? (
        overview.plans.length === 0 ? (
          <p className="auth-error" role="status">
            Plans are not available right now. Please contact support.
          </p>
        ) : (
          <section className="billing-checkout" aria-labelledby="billing-checkout-title">
            <h2 id="billing-checkout-title" className="billing-checkout__title">
              Choose a plan
            </h2>
            <div className="billing-plans" role="radiogroup" aria-label="Billing period">
              {overview.plans.map((plan) => (
                <label key={plan.planCode} className={plan.planCode === planCode ? "billing-plan billing-plan--selected" : "billing-plan"}>
                  <input
                    type="radio"
                    name="billing-plan"
                    value={plan.planCode}
                    checked={plan.planCode === planCode}
                    onChange={() => setPlanCode(plan.planCode)}
                  />
                  <span className="billing-plan__name">{plan.planName}</span>
                  <span className="billing-plan__price">
                    {formatRupees(plan.pricePerSeatPaise)} / seat / {plan.billingPeriod === "yearly" ? "year" : "month"}
                  </span>
                </label>
              ))}
            </div>

            <div className="billing-seats">
              <label htmlFor="billing-seat-count">Seats</label>
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
              <p className="billing-seats__hint">
                One seat per person, including you. Your company has {overview.seats.activeMembers}{" "}
                {overview.seats.activeMembers === 1 ? "member" : "members"}.
              </p>
            </div>

            <p className="billing-total">
              Total <strong>{formatRupees(totalPaise)}</strong> per {selectedPlan?.billingPeriod === "yearly" ? "year" : "month"}, renews automatically
            </p>

            {phase.kind === "error" ? (
              <p className="auth-error" role="alert">
                {phase.message}
              </p>
            ) : null}

            <button className="button" type="button" onClick={() => void handlePay()} disabled={!selectedPlan || phase.kind === "starting"}>
              {phase.kind === "starting" ? "Opening checkout…" : `Pay ${formatRupees(totalPaise)}`}
            </button>
          </section>
        )
      ) : null}

      {!overview.isOwner ? <p className="auth-card__subtitle">Only the company owner can manage billing.</p> : null}

      {overview.isOwner && overview.payments.length > 0 ? (
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

      <p className="auth-card__subtitle billing-links">
        {overview.hasCrmAccess ? <Link href="/leads">Back to CRM</Link> : null}
        {/* Access is decided per company: one company's billing never locks the others. */}
        <Link href="/workspaces">Switch company</Link>
      </p>
    </div>
  );
}
