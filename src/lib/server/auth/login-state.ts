import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * login_system_plan.md section 6.3: after OTP verification, exactly one of
 * these three states must result. A partial or contradictory record set is
 * never silently repaired by creating another tenant — it blocks access
 * and is logged for backend investigation instead.
 */
export type LoginState =
  | { status: "needs_onboarding" }
  | {
      status: "ready";
      tenantId: string;
      tenantName: string;
      fullName: string;
      membershipRole: string;
      membershipStatus: string;
      tenantStatus: string;
      subscriptionStatus: string;
      trialEndsAt: string | null;
      currentPeriodEndsAt: string | null;
    }
  | { status: "integrity_error"; reason: string };

function logIntegrityError(userId: string, reason: string): void {
  console.error(JSON.stringify({ operation: "resolve_login_state", code: "LOGIN_STATE_INTEGRITY_ERROR", userId, reason }));
}

/**
 * Resolves the current login state for a verified `userId` by reading the
 * profile / membership / tenant / subscription chain with the trusted
 * service-role client (bypassing RLS, since this check itself determines
 * what the user is authorized to see).
 */
export async function resolveLoginState(userId: string): Promise<LoginState> {
  const db = getSupabaseAdminClient();

  const { data: membership, error: membershipError } = await db
    .from("tenant_memberships")
    .select("tenant_id, membership_role, membership_status")
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    logIntegrityError(userId, "MEMBERSHIP_QUERY_FAILED");
    return { status: "integrity_error", reason: "MEMBERSHIP_QUERY_FAILED" };
  }

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("user_id, full_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError) {
    logIntegrityError(userId, "PROFILE_QUERY_FAILED");
    return { status: "integrity_error", reason: "PROFILE_QUERY_FAILED" };
  }

  if (!membership && !profile) {
    return { status: "needs_onboarding" };
  }

  if (!membership || !profile) {
    // One of the two application rows exists without the other. This can
    // only happen from a failure mode outside the onboarding RPC's own
    // transaction (which never commits one without the other) — never
    // silently create a second tenant to paper over it.
    logIntegrityError(userId, "PARTIAL_ONBOARDING_STATE");
    return { status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" };
  }

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("tenant_name, tenant_status")
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    logIntegrityError(userId, "TENANT_MISSING");
    return { status: "integrity_error", reason: "TENANT_MISSING" };
  }

  const { data: subscription, error: subscriptionError } = await db
    .from("tenants_subscriptions")
    .select("subscription_status, trial_ends_at, current_period_ends_at")
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (subscriptionError || !subscription) {
    logIntegrityError(userId, "SUBSCRIPTION_MISSING");
    return { status: "integrity_error", reason: "SUBSCRIPTION_MISSING" };
  }

  return {
    status: "ready",
    tenantId: membership.tenant_id,
    tenantName: tenant.tenant_name,
    fullName: profile.full_name,
    membershipRole: membership.membership_role,
    membershipStatus: membership.membership_status,
    tenantStatus: tenant.tenant_status,
    subscriptionStatus: subscription.subscription_status,
    trialEndsAt: subscription.trial_ends_at,
    currentPeriodEndsAt: subscription.current_period_ends_at,
  };
}
