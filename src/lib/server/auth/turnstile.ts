import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getAuthEnv, isTurnstileConfigured } from "@/lib/server/env";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerificationResult {
  verified: boolean;
  /** True only when Turnstile is unconfigured outside production and verification was skipped rather than evaluated. */
  bypassed: boolean;
}

interface TurnstileSiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
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
 */
export async function verifyTurnstileToken(token: string, remoteIp: string | null): Promise<TurnstileVerificationResult> {
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

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: requestBody });
  } catch {
    throw new AppError("Turnstile verification could not be completed.", {
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  }

  if (!response.ok) {
    throw new AppError("Turnstile verification could not be completed.", {
      status: 503,
      code: "TURNSTILE_VERIFICATION_UNAVAILABLE",
      retryable: true,
    });
  }

  const result = (await response.json()) as TurnstileSiteverifyResponse;
  return { verified: result.success === true, bypassed: false };
}
