import "server-only";

import { AppError } from "@/lib/server/app-error";

/**
 * Rejects cross-site POSTs to the auth and Meta connection routes.
 *
 * These routes are protected against CSRF only by the auth cookies'
 * `sameSite: "lax"` attribute (see cookie-options.ts) — none of them carry
 * a CSRF token. That single control is worth backing up, because it is one
 * cookie-option edit away from being silently removed, and `lax` still
 * permits some cross-site request shapes.
 *
 * The check is deliberately permissive when the browser sends no origin
 * information at all: `Origin` is absent on some same-origin navigations
 * and on non-browser callers, and failing those closed would break
 * legitimate traffic for no security gain (an attacker's browser always
 * sends `Origin` on a cross-site fetch/form POST — it cannot suppress it).
 * A present-but-mismatched origin, on the other hand, is unambiguous.
 */
export function assertSameOrigin(request: Request): void {
  const target = request.headers.get("host");
  if (!target) {
    return;
  }

  const claimed = request.headers.get("origin") ?? request.headers.get("referer");
  if (!claimed) {
    return;
  }

  let claimedHost: string;
  try {
    claimedHost = new URL(claimed).host;
  } catch {
    throw new AppError("Request origin is invalid.", { status: 403, code: "CROSS_ORIGIN_REQUEST" });
  }

  if (claimedHost !== target) {
    throw new AppError("Cross-origin requests are not permitted on this endpoint.", {
      status: 403,
      code: "CROSS_ORIGIN_REQUEST",
    });
  }
}
