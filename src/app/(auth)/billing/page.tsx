import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BillingPageClient } from "@/features/billing/billing-page-client";
import { isAppError } from "@/lib/server/app-error";
import { requireBillingMember } from "@/lib/server/auth/access";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { verifySession } from "@/lib/server/auth/session";
import { getBillingOverview } from "@/lib/server/billing-service";

export const metadata: Metadata = {
  title: "Billing",
};

/**
 * Billing for the active company. Deliberately outside the (crm) access gate: a company whose trial or
 * paid period has ended lands here (the (crm) layout redirects CRM_ACCESS_DENIED to /billing) and must
 * be able to pay. Companies that still have access can open it too, to see their plan and receipts.
 *
 * It shows only this company's plan, seats and receipts — never CRM data. An integrity_error keeps its
 * own message, without revealing which record caused it.
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

  // The owner removed this person from their company. One login belongs to one company, so there is
  // nothing to pay for or switch to here.
  if (state.status === "no_company") {
    return (
      <div className="auth-card">
        <h1 className="auth-card__title">You are no longer part of a company</h1>
        <p className="auth-card__subtitle">
          The company owner removed your access. Contact the company owner or support if you believe this is a mistake.
        </p>
      </div>
    );
  }

  // The owner blocked this employee. Nothing was deleted, so the owner can enable them again.
  if (state.status === "ready" && state.membershipStatus === "blocked") {
    return (
      <div className="auth-card">
        <h1 className="auth-card__title">Your access is disabled</h1>
        <p className="auth-card__subtitle">
          Your company owner has disabled your access. Contact your owner to get it enabled again.
        </p>
      </div>
    );
  }

  if (state.status === "integrity_error") {
    return (
      <div className="auth-card">
        <h1 className="auth-card__title">We need to verify your account</h1>
        <p className="auth-card__subtitle">
          Something doesn&apos;t look right with your account records. Our team has been notified — please contact support to continue.
        </p>
      </div>
    );
  }

  const overview = await loadOverview();

  // A suspended company or a blocked membership cannot buy its way back in; support resolves those.
  if (!overview) {
    return (
      <div className="auth-card">
        <h1 className="auth-card__title">CRM access is not currently available</h1>
        <p className="auth-card__subtitle">
          This may be due to your membership or account status. Contact support if you believe this is a mistake.
        </p>
      </div>
    );
  }

  return <BillingPageClient overview={overview} />;
}

async function loadOverview() {
  try {
    return await getBillingOverview(await requireBillingMember());
  } catch (error) {
    if (isAppError(error) && error.code === "BILLING_NOT_ALLOWED") {
      return null;
    }
    throw error;
  }
}
