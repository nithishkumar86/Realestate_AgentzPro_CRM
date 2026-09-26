import "server-only";

import { AppError } from "@/lib/server/app-error";
import { readActiveTenantHint } from "@/lib/server/auth/active-tenant";
import { verifySession } from "@/lib/server/auth/session";
import { resolveLoginState, type LoginState } from "@/lib/server/auth/login-state";

export interface CrmAccessGranted {
  userId: string;
  tenantId: string;
  tenantName: string;
  fullName: string;
  membershipRole: string;
}

/**
 * login_system_plan.md section 5 CRM-access predicate. `blocked`, any
 * suspended tenant, and any blocked membership never grant access; a trial
 * or paid period only grants access while its own end timestamp is still
 * in the future.
 *
 * NOTE ON DEFENCE-IN-DEPTH: an equivalent `private.has_crm_access()`
 * Postgres function exists in the auth/tenancy migration, but nothing
 * currently calls it — no RLS policy references it and no query invokes
 * it. The CRM tables have RLS enabled with zero policies and are read
 * exclusively through the service-role client, which bypasses RLS
 * entirely. This predicate is therefore the ONLY enforcement of CRM
 * access, and tenant isolation rests entirely on every query carrying an
 * explicit `.eq("tenant_id", context.tenantId)` filter. Treat a missing
 * tenant filter as a data-leak bug, not a style issue — there is no
 * database-level backstop behind it.
 */
export function evaluateCrmAccess(state: LoginState): boolean {
  if (state.status !== "ready") {
    return false;
  }
  if (state.tenantStatus !== "active" || state.membershipStatus !== "active") {
    return false;
  }

  const now = Date.now();

  if (state.subscriptionStatus === "trialing") {
    return state.trialEndsAt !== null && new Date(state.trialEndsAt).getTime() > now;
  }

  if (state.subscriptionStatus === "active") {
    return state.currentPeriodEndsAt !== null && new Date(state.currentPeriodEndsAt).getTime() > now;
  }

  // subscription_status === "blocked", or any unrecognized value.
  return false;
}

/**
 * Composes session verification, login-state resolution, and the access
 * predicate into the one check every tenant-scoped server operation must
 * pass. Throws a typed AppError rather than returning a boolean so callers
 * cannot accidentally ignore a denial.
 */
export async function requireCrmAccess(): Promise<CrmAccessGranted> {
  const session = await verifySession();
  if (!session) {
    throw new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" });
  }

  // The active-tenant cookie only picks among this user's own memberships; resolveLoginState
  // re-verifies it against tenant_memberships on every call.
  const state = await resolveLoginState(session.userId, await readActiveTenantHint());

  if (state.status === "needs_onboarding") {
    throw new AppError("Onboarding must be completed before accessing the CRM.", {
      status: 403,
      code: "ONBOARDING_REQUIRED",
    });
  }

  if (state.status === "needs_workspace_selection") {
    throw new AppError("Choose a company to continue.", {
      status: 403,
      code: "WORKSPACE_SELECTION_REQUIRED",
    });
  }

  if (state.status === "integrity_error") {
    throw new AppError("Account access could not be verified.", {
      status: 403,
      code: "ACCOUNT_INTEGRITY_ERROR",
    });
  }

  if (!evaluateCrmAccess(state)) {
    throw new AppError("CRM access is not currently available for this account.", {
      status: 403,
      code: "CRM_ACCESS_DENIED",
    });
  }

  return {
    userId: session.userId,
    tenantId: state.tenantId,
    tenantName: state.tenantName,
    fullName: state.fullName,
    membershipRole: state.membershipRole,
  };
}

export interface BillingAccess {
  userId: string;
  tenantId: string;
  tenantName: string;
  membershipRole: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  hasCrmAccess: boolean;
}

/**
 * Billing sits OUTSIDE the CRM-access gate on purpose: a company whose trial or paid period has
 * ended is exactly the company that needs to pay. So this does not call evaluateCrmAccess(); it only
 * requires a verified session and an active membership in an active tenant.
 *
 * The tenant is the active tenant resolved by resolveLoginState (the cookie hint re-verified against
 * this user's own memberships), never anything from the request. With many memberships per user,
 * that is what keeps "pay for company A" from ever touching company B.
 */
export async function requireBillingMember(): Promise<BillingAccess> {
  const session = await verifySession();
  if (!session) {
    throw new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" });
  }

  const state = await resolveLoginState(session.userId, await readActiveTenantHint());

  if (state.status === "needs_onboarding") {
    throw new AppError("Onboarding must be completed first.", { status: 403, code: "ONBOARDING_REQUIRED" });
  }
  if (state.status === "needs_workspace_selection") {
    throw new AppError("Choose a company to continue.", { status: 403, code: "WORKSPACE_SELECTION_REQUIRED" });
  }
  if (state.status === "integrity_error") {
    throw new AppError("Account access could not be verified.", { status: 403, code: "ACCOUNT_INTEGRITY_ERROR" });
  }
  if (state.tenantStatus !== "active" || state.membershipStatus !== "active") {
    throw new AppError("Billing is not available for this account.", { status: 403, code: "BILLING_NOT_ALLOWED" });
  }

  return {
    userId: session.userId,
    tenantId: state.tenantId,
    tenantName: state.tenantName,
    membershipRole: state.membershipRole,
    subscriptionStatus: state.subscriptionStatus,
    trialEndsAt: state.trialEndsAt,
    currentPeriodEndsAt: state.currentPeriodEndsAt,
    hasCrmAccess: evaluateCrmAccess(state),
  };
}

/** Buying and cancelling are owner-only. Employees can see status, never change it. */
export async function requireBillingOwner(): Promise<BillingAccess> {
  const access = await requireBillingMember();
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the company owner can manage billing.", { status: 403, code: "BILLING_OWNER_REQUIRED" });
  }
  return access;
}
