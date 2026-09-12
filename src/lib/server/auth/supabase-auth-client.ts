import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/server/env";
import { AUTH_COOKIE_OPTIONS } from "@/lib/server/auth/cookie-options";

/**
 * Creates a request-scoped, cookie-bound Supabase Auth client for use in
 * Server Components, Server Actions, and Route Handlers.
 *
 * A new client must be created for every request — it is never cached or
 * shared across requests, since it is bound to that request's cookie jar.
 *
 * `setAll` is wrapped in try/catch because Server Components are not
 * permitted to mutate cookies: Next.js throws when `cookieStore.set()` is
 * called from that context. That failure is safe to ignore here because
 * `src/proxy.ts` is responsible for refreshing the session cookie on every
 * request (see its own cookie handler, which does have a NextResponse to
 * write to and does not need this fallback).
 *
 * Any OTHER failure is not safe to ignore: in a Route Handler a cookie
 * write is legal, and swallowing a failure there would let
 * /api/auth/otp/verify report a successful login while never actually
 * establishing the session — the user is bounced straight back to /login
 * by the proxy with no server-side signal. Those are logged loudly and
 * rethrown so the route fails visibly instead of lying about success.
 */

/**
 * Next.js throws this when cookies are mutated from a Server Component.
 * Matched on the error name it sets, with a message fallback for versions
 * that only set the message.
 */
function isReadonlyCookieStoreError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "ReadonlyRequestCookiesError") {
    return true;
  }

  return error.message.includes("Cookies can only be modified in a Server Action or Route Handler");
}

export async function createAuthClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const environment = getSupabaseEnv();

  return createServerClient(environment.SUPABASE_URL, environment.SUPABASE_PUBLISHABLE_KEY, {
    // Without this the library's DEFAULT_COOKIE_OPTIONS apply, which leave
    // the access and refresh tokens readable by client-side JavaScript for
    // 400 days. See cookie-options.ts.
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS });
          }
        } catch (error) {
          if (isReadonlyCookieStoreError(error)) {
            // Called from a Server Component, where cookies cannot be
            // mutated. src/proxy.ts refreshes the session cookie instead.
            return;
          }

          console.error(
            JSON.stringify({
              operation: "auth_cookie_write",
              reason: "SESSION_COOKIE_WRITE_FAILED",
            }),
          );
          throw error;
        }
      },
    },
  });
}
