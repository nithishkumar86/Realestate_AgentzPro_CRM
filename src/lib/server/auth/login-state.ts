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
  // The person finished account setup but no longer belongs to a company: the owner removed them.
  // One login belongs to one company, so they cannot join or create another.
  | { status: "no_company" }
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
 *
 * One login belongs to exactly one company: tenant_memberships is unique on
 * user_id, so there is at most one membership row to read.
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

  if (!profile) {
    // A membership without a profile can only come from a failure outside
    // the onboarding/accept RPCs' own transactions — never paper over it.
    logIntegrityError(userId, "PARTIAL_ONBOARDING_STATE");
    return { status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" };
  }

  // A profile with no membership: the owner removed this person from their company. The profile is
  // kept (remove_tenant_member deletes only the membership), so this is a known state, not an error.
  if (!membership) {
    return { status: "no_company" };
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
