import "server-only";

import { cache } from "react";
import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";

export interface AuthenticatedSession {
  userId: string;
}

/**
 * Resolves the current request's authenticated session from its cookies.
 *
 * Uses `getClaims()`, which verifies the JWT locally (against the cached
 * JWKS endpoint) rather than trusting the unverified user object embedded
 * in `getSession()`'s locally-stored tokens. Returns `null` for any
 * unauthenticated or invalid session rather than throwing, so callers
 * decide how to respond (redirect, 401, etc.).
 *
 * Wrapped in React's `cache()` so that, within a single render pass,
 * multiple call sites (layout guard, page, nested components) share one
 * verification instead of re-verifying the JWT repeatedly.
 */
export const verifySession = cache(async (): Promise<AuthenticatedSession | null> => {
  const supabase = await createAuthClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims?.sub) {
    return null;
  }

  return { userId: data.claims.sub };
});
