import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/server/env";
import { AUTH_COOKIE_OPTIONS } from "@/lib/server/auth/cookie-options";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`; functionality is
 * unchanged and it defaults to the Node.js runtime.
 *
 * This proxy has exactly two jobs (login_system_plan.md section 10 /
 * the Next.js authentication guide's "optimistic checks" pattern):
 *
 * 1. Refresh the Supabase session cookie. `getClaims()` verifies the
 *    access token locally against the cached JWKS and triggers a refresh
 *    when the token is near expiry; the refreshed cookie is written back
 *    via `setAll` below. This must run before any response is generated,
 *    and the returned response object must be the one `setAll` produced
 *    (or a copy carrying its cookies), or the browser and server session
 *    state fall out of sync.
 * 2. Cheap, optimistic redirects based only on whether a session exists —
 *    no database access here. The deeper subscription/membership/tenant
 *    check (requireCrmAccess) runs in `(crm)/layout.tsx`, never in proxy.
 */

const CRM_PATH_PREFIXES = ["/leads", "/dashboard", "/connection", "/settings"];
const LOGIN_PATH = "/login";

/** Matches a path exactly, tolerating a trailing slash. */
function isPath(pathname: string, target: string): boolean {
  return pathname === target || pathname === `${target}/`;
}

function isCrmPath(pathname: string): boolean {
  return CRM_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const environment = getSupabaseEnv();
  const supabase = createServerClient(environment.SUPABASE_URL, environment.SUPABASE_PUBLISHABLE_KEY, {
    // Without this the library's DEFAULT_COOKIE_OPTIONS apply, which leave
    // the access and refresh tokens readable by client-side JavaScript for
    // 400 days. See src/lib/server/auth/cookie-options.ts.
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // Mirror the cookies onto the request so any code reading
        // request.cookies further down this same invocation sees the
        // refreshed values, then rebuild the response from that request.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS });
        }
        // Responses that set auth cookies must not be cached by CDNs or
        // reverse proxies, or one user's session token can be served to a
        // different user.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const hasSession = Boolean(data?.claims?.sub);

  const pathname = request.nextUrl.pathname;

  if (!hasSession && isCrmPath(pathname)) {
    return redirectPreservingCookies(request, LOGIN_PATH, response);
  }

  if (hasSession && isPath(pathname, LOGIN_PATH)) {
    return redirectPreservingCookies(request, "/leads", response);
  }

  return response;
}

/**
 * A redirect built from scratch carries none of the cookies `setAll` wrote
 * onto `response`. If the session was refreshed during this invocation and
 * we then redirect, dropping those cookies leaves the browser holding the
 * old (possibly now-rotated) refresh token, desynchronising it from
 * Supabase. Carry them, and the no-cache headers, onto the redirect.
 */
function redirectPreservingCookies(
  request: NextRequest,
  destination: string,
  source: NextResponse,
): NextResponse {
  const redirect = NextResponse.redirect(new URL(destination, request.url));

  for (const cookie of source.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  for (const [key, value] of source.headers.entries()) {
    if (key.toLowerCase() === "cache-control" || key.toLowerCase() === "pragma" || key.toLowerCase() === "expires") {
      redirect.headers.set(key, value);
    }
  }

  return redirect;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/queues|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
