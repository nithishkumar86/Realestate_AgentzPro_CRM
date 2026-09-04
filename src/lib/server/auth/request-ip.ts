import "server-only";

/**
 * Reads the source IP only from the hosting platform's trusted request
 * metadata (login_system_plan.md section 10.3) — never from a
 * client-controllable body field. `x-forwarded-for` is set by Vercel (and
 * effectively every reverse proxy/CDN) to a comma-separated list with the
 * original client IP first; `x-real-ip` is a common single-IP fallback.
 * "unknown" only occurs in local development with no proxy in front of
 * the server, and only ever shares one rate-limit bucket there — it is
 * never reachable in production.
 */
export function getRequestSourceIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
}
