import type { Metadata } from "next";
import { LoginPageClient } from "@/features/auth/login-page-client";
import { getAuthEnv } from "@/lib/server/env";

export const metadata: Metadata = {
  title: "Sign in",
};

// Reads server env config (Turnstile site key) on every request rather
// than at build time — this must never be statically prerendered, since
// the deployment's own auth configuration isn't known until runtime.
export const dynamic = "force-dynamic";

/**
 * An already-authenticated visit to /login is redirected to /leads by
 * src/proxy.ts before this page renders, so no server-side session check
 * is duplicated here.
 */
export default function LoginPage() {
  const turnstileSiteKey = getAuthEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;

  return <LoginPageClient turnstileSiteKey={turnstileSiteKey} />;
}
