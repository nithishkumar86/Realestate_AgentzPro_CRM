import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/server/auth/session";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { evaluateCrmAccess } from "@/lib/server/auth/access";

export const metadata: Metadata = {
  title: "Account",
};

/**
 * login_system_plan.md section 8.3: an expired/blocked account can read
 * only the minimum tenant and subscription information needed to
 * understand and resolve its own state — never CRM data. This page also
 * independently resolves the login state (rather than trusting the (crm)
 * layout's routing decision) so it can distinguish a genuine
 * integrity_error from an ordinary expired/blocked access denial in its
 * own messaging, without exposing which specific field caused the denial.
 */
export default async function BillingPage() {
  const session = await verifySession();
  if (!session) {
    redirect("/login");
  }

  const state = await resolveLoginState(session.userId);

  if (state.status === "needs_onboarding") {
    redirect("/onboarding");
  }

  if (state.status === "ready" && evaluateCrmAccess(state)) {
    redirect("/leads");
  }

  const isIntegrityError = state.status === "integrity_error";

  return (
    <div className="auth-card">
      <h1 className="auth-card__title">{isIntegrityError ? "We need to verify your account" : "CRM access is not currently available"}</h1>
      <p className="auth-card__subtitle">
        {isIntegrityError
          ? "Something doesn't look right with your account records. Our team has been notified — please contact support to continue."
          : "This may be due to your subscription, membership, or account status. Contact support if you believe this is a mistake."}
      </p>

      {!isIntegrityError && state.status === "ready" ? (
        <dl className="auth-billing-summary">
          <div>
            <dt>Subscription status</dt>
            <dd>{state.subscriptionStatus}</dd>
          </div>
          {state.trialEndsAt ? (
            <div>
              <dt>Trial ended</dt>
              <dd>{new Date(state.trialEndsAt).toLocaleDateString()}</dd>
            </div>
          ) : null}
          {state.currentPeriodEndsAt ? (
            <div>
              <dt>Billing period ended</dt>
              <dd>{new Date(state.currentPeriodEndsAt).toLocaleDateString()}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
