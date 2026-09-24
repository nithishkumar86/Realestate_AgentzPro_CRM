import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingFormClient } from "@/features/auth/onboarding-form-client";
import { InvitationOnboardingFormClient } from "@/features/auth/invitation-onboarding-form-client";
import { InvitationWithdrawnClient } from "@/features/auth/invitation-withdrawn-client";
import { findPendingInvitationForUser, findWithdrawnInvitationForUser } from "@/lib/server/member-invitation-service";
import { verifySession } from "@/lib/server/auth/session";
import { resolveLoginState } from "@/lib/server/auth/login-state";
import { readActiveTenantHint } from "@/lib/server/auth/active-tenant";
import { evaluateCrmAccess } from "@/lib/server/auth/access";

export const metadata: Metadata = {
  title: "Get started",
};

/**
 * Server-guarded per login_system_plan.md section 6.4: only a caller
 * whose login state is genuinely needs_onboarding sees this form. Every
 * other state redirects away rather than letting onboarding be
 * re-submitted for an account that already has one.
 */
export default async function OnboardingPage() {
  const session = await verifySession();
  if (!session) {
    redirect("/login");
  }

  const state = await resolveLoginState(session.userId, await readActiveTenantHint());

  if (state.status === "needs_onboarding") {
    // An invited member joins the inviting company's existing tenant with the role the owner
    // chose, so they get the invitation form (personal details only), never the owner form.
    const invitation = await findPendingInvitationForUser(session.userId);
    if (invitation) {
      return (
        <InvitationOnboardingFormClient
          invitationId={invitation.invitationId}
          tenantName={invitation.tenantName}
          role={invitation.role}
        />
      );
    }
    // Opened an invite email after the owner withdrew it: explain that, never offer a new company.
    const withdrawn = await findWithdrawnInvitationForUser(session.userId);
    if (withdrawn) {
      return <InvitationWithdrawnClient tenantName={withdrawn.tenantName} />;
    }
    return <OnboardingFormClient />;
  }

  // Already has a profile: further companies are joined or created from /workspaces, never here.
  if (state.status === "needs_workspace_selection") {
    redirect("/workspaces");
  }

  if (state.status === "integrity_error") {
    redirect("/billing");
  }

  redirect(evaluateCrmAccess(state) ? "/" : "/billing");
}
