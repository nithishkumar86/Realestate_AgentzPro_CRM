import "server-only";

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

/**
 * The company a person is currently working in, when they belong to more than one.
 *
 * This cookie is only a HINT. It is never trusted on its own: resolveLoginState looks the tenant up
 * in tenant_memberships by (user_id, tenant_id) on every request, so a stale, tampered, or foreign
 * tenant id simply fails that lookup and the person is sent to pick a company again. Without that
 * re-check a hand-edited cookie would be an IDOR into another company's data.
 *
 * It holds nothing but a tenant UUID, and uses the same flags as the auth cookies
 * (src/lib/server/auth/cookie-options.ts): httpOnly, sameSite lax, secure in production.
 */
export const ACTIVE_TENANT_COOKIE = "agentz_active_tenant";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isProduction = process.env.NODE_ENV === "production";

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** The active-tenant hint from this request's cookies, or null when absent or malformed. */
export async function readActiveTenantHint(): Promise<string | null> {
  const value = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value;
  return isTenantId(value) ? value.toLowerCase() : null;
}

/**
 * Call only after the caller's membership in `tenantId` has been verified. Pass the response the
 * route is returning so the Set-Cookie header travels with it.
 */
export function setActiveTenant(response: NextResponse, tenantId: string): void {
  response.cookies.set(ACTIVE_TENANT_COOKIE, tenantId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}

export function clearActiveTenant(response: NextResponse): void {
  response.cookies.set(ACTIVE_TENANT_COOKIE, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
