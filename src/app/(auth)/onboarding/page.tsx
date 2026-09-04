import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingFormClient } from "@/features/auth/onboarding-form-client";
import { verifySession } from "@/lib/server/auth/session";
import { resolveLoginState } from "@/lib/server/auth/login-state";
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

  const state = await resolveLoginState(session.userId);

  if (state.status === "needs_onboarding") {
    return <OnboardingFormClient />;
  }

  if (state.status === "integrity_error") {
    redirect("/billing");
  }

  redirect(evaluateCrmAccess(state) ? "/leads" : "/billing");
}
