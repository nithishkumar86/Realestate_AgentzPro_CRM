import "server-only";

import { getTrustedProxyHopCount } from "@/lib/server/env";

/**
 * Resolves the client IP used to key OTP brute-force and abuse limits.
 *
 * SECURITY: `x-forwarded-for` is append-only and client-controllable. A
 * caller can send `x-forwarded-for: <anything>` and every proxy in front
 * of us appends to it rather than replacing it, so the LEFTMOST entry is
 * whatever the client claimed — it is attacker-chosen, not observed.
 * Keying a rate limit on it means an attacker gets a fresh, empty limit
 * bucket per request simply by varying the header, which defeats the
 * 5-attempt OTP verify block entirely and turns a 6-digit code into an
 * unbounded guessing game.
 *
 * The only trustworthy entries are the RIGHTMOST ones, appended by
 * infrastructure we control. We therefore:
 *
 * 1. Prefer `x-vercel-forwarded-for`, which Vercel's edge overwrites on
 *    every request and a client cannot inject through it.
 * 2. Otherwise index into `x-forwarded-for` from the right by the number
 *    of trusted proxies in front of this app (TRUSTED_PROXY_HOP_COUNT,
 *    default 1 — a single reverse proxy/CDN).
 * 3. Otherwise fall back to `x-real-ip`, which reverse proxies set rather
 *    than append (so it cannot be extended by the client, though it can
 *    be forged with no proxy in front at all).
 *
 * Any candidate that is not a syntactically valid IP address is rejected
 * rather than used, so a junk header cannot mint unlimited distinct
 * rate-limit keys.
 *
 * "unknown" is returned when nothing trustworthy is available. It shares a
 * single rate-limit bucket, which is the correct fail-closed behaviour:
 * requests we cannot attribute are limited together rather than each
 * getting a free bucket.
 */

const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isValidIp(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return true;
  }

  // IPv6, including the IPv4-mapped and zone-id forms proxies emit. Kept
  // deliberately permissive on shape but strict on character set, so it
  // accepts real addresses and rejects arbitrary attacker-supplied text.
  if (value.includes(":") && /^[0-9a-fA-F:.%\]\[]+$/.test(value) && value.length <= 45) {
    return true;
  }

  return false;
}

function normalizeCandidate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  // Proxies may emit an IPv6 address in bracketed and/or port-suffixed
  // form; strip both so the same client always maps to the same key.
  let candidate = value.trim();
  if (candidate.startsWith("[")) {
    candidate = candidate.slice(1, candidate.indexOf("]") === -1 ? undefined : candidate.indexOf("]"));
  } else if (candidate.split(":").length === 2) {
    candidate = candidate.split(":")[0] ?? candidate;
  }

  return isValidIp(candidate) ? candidate : undefined;
}

export function getRequestSourceIp(request: Request): string {
  const vercelForwardedFor = normalizeCandidate(
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0],
  );
  if (vercelForwardedFor) {
    return vercelForwardedFor;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    // Count back from the right: the last entry was appended by the proxy
    // nearest to us, so hop count 1 selects the address that proxy
    // observed as its peer.
    const trustedIndex = entries.length - getTrustedProxyHopCount();
    const candidate = normalizeCandidate(entries[trustedIndex]);
    if (candidate) {
      return candidate;
    }
  }

  const realIp = normalizeCandidate(request.headers.get("x-real-ip") ?? undefined);
  if (realIp) {
    return realIp;
  }

  return "unknown";
}
