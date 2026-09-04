import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/server/env";

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
 */
export async function createAuthClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const environment = getSupabaseEnv();

  return createServerClient(environment.SUPABASE_URL, environment.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies cannot be
          // mutated. src/proxy.ts refreshes the session cookie instead.
        }
      },
    },
  });
}
