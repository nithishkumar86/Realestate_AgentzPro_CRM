import "server-only";

import type { CookieOptions } from "@supabase/ssr";

/**
 * Explicit cookie options for the Supabase auth cookies (access token and
 * refresh token).
 *
 * These MUST be passed to every `createServerClient()` call in this
 * codebase. Without them, @supabase/ssr falls back to its own
 * DEFAULT_COOKIE_OPTIONS, which sets `httpOnly: false`, omits `secure`
 * entirely, and uses a 400-day `maxAge` — putting a long-lived refresh
 * token in a cookie that any script on the origin can read.
 *
 * `httpOnly: true` is free here: the browser never talks to Supabase
 * directly in this application (see the SUPABASE_PUBLISHABLE_KEY note in
 * src/lib/server/env.ts), so no client-side code needs to read these
 * cookies. Every auth operation goes through a server route.
 *
 * `sameSite: "lax"` is load-bearing, not cosmetic: it is the only thing
 * preventing CSRF against the auth POST routes, none of which carry a CSRF
 * token. Do not weaken it to "none" without adding one.
 *
 * `secure` is disabled only outside production, because local development
 * runs on http://localhost and a Secure cookie would never be stored
 * there. `NODE_ENV` is "production" for every deployed build.
 */
const isProduction = process.env.NODE_ENV === "production";

export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
};
