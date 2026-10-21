import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getAuthEnv, isTurnstileConfigured } from "@/lib/server/env";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Upper bound on the siteverify round trip. Without it a hung Cloudflare
 * response holds the login request open until the platform kills the
 * function; with it the call aborts and takes the existing
 * TURNSTILE_VERIFICATION_UNAVAILABLE path.
 */
const TURNSTILE_VERIFY_TIMEOUT_MS = 10_000;

export interface TurnstileVerificationResult {
  verified: boolean;
  /** True only when Turnstile is unconfigured outside production and verification was skipped rather than evaluated. */
  bypassed: boolean;
}

interface TurnstileSiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
  hostname?: string;
  metadata?: { result_with_testing_key?: boolean };
}

/** Lowercases and drops any port, so a Host header like `localhost:3000` compares equal to siteverify's `localhost`. */
function normalizeHostname(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (lowered.startsWith("[")) {
    const closingBracket = lowered.indexOf("]");
    return closingBracket === -1 ? lowered : lowered.slice(0, closingBracket + 1);
  }
  return lowered.split(":")[0] ?? lowered;
}

/**
 * A valid token only proves a challenge was solved on SOME site that uses
 * this sitekey. Requiring the hostname Cloudflare observed to equal the
 * host this request was served on rejects a token solved elsewhere.
 *
 * Cloudflare's dummy testing keys always report `example.com`, so a result
 * flagged `result_with_testing_key` (set by Cloudflare from the secret key,
 * never by the client) skips the comparison; otherwise local development
 * with testing keys could never log in. Fails closed when either side is
 * missing.
 */
function matchesExpectedHostname(result: TurnstileSiteverifyResponse, expectedHostname: string | null): boolean {
  if (result.metadata?.result_with_testing_key === true) {
    return true;
  }

  if (!expectedHostname || !result.hostname) {
    console.warn(JSON.stringify({ operation: "otp_send", reason: "TURNSTILE_HOSTNAME_MISSING" }));
    return false;
  }

  const expected = normalizeHostname(expectedHostname);
  const observed = normalizeHostname(result.hostname);
  if (expected !== observed) {
    console.warn(JSON.stringify({ operation: "otp_send", reason: "TURNSTILE_HOSTNAME_MISMATCH", expected, observed }));
    return false;
  }

  return true;
}

/**
 * Every caller of this function must have already checked
 * isTurnstileConfigured(). It still fails loudly on its own rather than
 * trusting that discipline silently: a missing secret here is a
 * programming error, not a configuration state a caller should ever reach.
 */
function getTurnstileSecretKey(): string {
  const secretKey = getAuthEnv().TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    throw new AppError("Turnstile verification was requested without Turnstile being configured.", {
      status: 503,
      code: "TURNSTILE_CONFIGURATION_ERROR",
    });
  }
  return secretKey;
}

/**
 * Verifies a Cloudflare Turnstile token server-side
 * (login_system_plan.md section 10, 10.1). In production,
 * getAuthEnv() already fails closed if Turnstile is unconfigured (see
 * src/lib/server/env.ts), so production never silently bypasses this
 * check. In development without Turnstile credentials, verification is
 * skipped and reported via `bypassed: true` so login can be exercised
 * locally without a Cloudflare account.
 *
 * `expectedHostname` is the Host header of the incoming request; a
 * successful token is only accepted when Cloudflare saw it solved on that
 * same hostname (see matchesExpectedHostname).
 */
export async function verifyTurnstileToken(
  token: string,
  remoteIp: string | null,
  expectedHostname: string | null,
): Promise<TurnstileVerificationResult> {
  if (!isTurnstileConfigured()) {
    return { verified: true, bypassed: true };
  }

  if (!token) {
    return { verified: false, bypassed: false };
  }

  const requestBody = new URLSearchParams();
  requestBody.set("secret", getTurnstileSecretKey());
  requestBody.set("response", token);
  if (remoteIp) {
    requestBody.set("remoteip", remoteIp);
  }

  // The body is read inside the same try: the timeout signal also covers
  // reading it, so an abort mid-body must map to the same 503 rather than
  // escape as a raw TimeoutError.
  let response: Response;
  let result: TurnstileSiteverifyResponse;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: requestBody,
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Turnstile siteverify returned HTTP ${response.status}.`);
    }
    result = (await response.json()) as TurnstileSiteverifyResponse;
  } catch {
    throw new AppError("Turnstile verification could not be completed.", {
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  }

  if (result.success !== true) {
    return { verified: false, bypassed: false };
  }

  return { verified: matchesExpectedHostname(result, expectedHostname), bypassed: false };
}
