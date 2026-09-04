import "server-only";

import { requireCrmAccess } from "@/lib/server/auth/access";

export interface TenantRequestContext {
  tenantId: string;
  userId: string;
}

/**
 * Resolves the current request's tenant and user from a verified Supabase
 * session, per login_system_plan.md sections 6 and 8. This composes
 * session verification, login-state resolution, and the subscription/
 * membership/tenant-status access predicate — throwing a typed AppError
 * (401 unauthenticated, 403 onboarding required / integrity error / access
 * denied) rather than ever falling back to an environment-variable tenant
 * or a null user, in development or production alike.
 *
 * Every tenant-scoped API route and server-side data access goes through
 * this function; nothing infers tenant identity from a request body or
 * header.
 */
export async function resolveTenantRequestContext(): Promise<TenantRequestContext> {
  const access = await requireCrmAccess();
  return { tenantId: access.tenantId, userId: access.userId };
}

export async function resolveTenantId(): Promise<string> {
  return (await resolveTenantRequestContext()).tenantId;
}
