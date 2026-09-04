import "server-only";

import { createAuthClient } from "@/lib/server/auth/supabase-auth-client";
import { normalizeEmail } from "@/lib/server/auth/otp-identifiers";
import { checkOtpSendCooldown, checkOtpSendEmailWindow, checkOtpSendIpWindow, isOtpVerifyBlocked, recordFailedOtpVerification } from "@/lib/server/auth/rate-limit";
import { verifyTurnstileToken } from "@/lib/server/auth/turnstile";

/**
 * Orchestrates the OTP-send and OTP-verify pipelines
 * (login_system_plan.md sections 6.1, 6.2, 10.4). Both entry points always
 * report a generic outcome to their caller — "OTP requested" or "OTP
 * verification failed" — regardless of which internal check produced that
 * outcome, so the HTTP response can never be used to enumerate whether an
 * email address is already registered. The specific reason is logged
 * server-side by `operation` and `reason` code only; the raw email, IP,
 * and OTP value are never written to logs.
 */

export interface OtpRequestParams {
  email: string;
  turnstileToken: string;
  sourceIp: string;
}

function logOtpEvent(operation: "otp_send" | "otp_verify", reason: string): void {
  console.warn(JSON.stringify({ operation, reason }));
}

/**
 * Requests an OTP for the given email. Never throws for an expected
 * rejection (failed CAPTCHA, rate limit exceeded, Supabase Auth's own
 * limit, or a transient Turnstile outage) — every one of those is logged
 * and swallowed so the caller always returns the same generic response.
 */
export async function requestOtp(params: OtpRequestParams): Promise<void> {
  const normalizedEmail = normalizeEmail(params.email);

  let turnstileVerified: boolean;
  try {
    turnstileVerified = (await verifyTurnstileToken(params.turnstileToken, params.sourceIp)).verified;
  } catch {
    // Turnstile's own service is unreachable. Treated the same as a failed
    // verification from the caller's perspective — the response must stay
    // generic regardless of cause.
    logOtpEvent("otp_send", "TURNSTILE_UNAVAILABLE");
    return;
  }

  if (!turnstileVerified) {
    logOtpEvent("otp_send", "TURNSTILE_FAILED");
    return;
  }

  const cooldown = await checkOtpSendCooldown(normalizedEmail);
  if (!cooldown.allowed) {
    logOtpEvent("otp_send", "EMAIL_COOLDOWN_EXCEEDED");
    return;
  }

  const emailWindow = await checkOtpSendEmailWindow(normalizedEmail);
  if (!emailWindow.allowed) {
    logOtpEvent("otp_send", "EMAIL_HOURLY_WINDOW_EXCEEDED");
    return;
  }

  const ipWindow = await checkOtpSendIpWindow(params.sourceIp);
  if (!ipWindow.allowed) {
    logOtpEvent("otp_send", "IP_HOURLY_WINDOW_EXCEEDED");
    return;
  }

  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      // The same verified email continues to use the same auth.users.id on
      // later logins; a previously unknown email is signed up automatically
      // (login_system_plan.md section 4), so this is left at its true
      // default and stated explicitly rather than left implicit.
      shouldCreateUser: true,
      // Passed through for Supabase Auth's own native CAPTCHA protection
      // (configured separately in the Supabase dashboard against the same
      // Turnstile site) as a second, independent verification of the same
      // token — this application's own verifyTurnstileToken() check above
      // already ran regardless of whether that dashboard setting is on.
      captchaToken: params.turnstileToken,
    },
  });

  if (error) {
    logOtpEvent("otp_send", "SUPABASE_SEND_FAILED");
  }
}

export interface OtpVerifyParams {
  email: string;
  otp: string;
  sourceIp: string;
}

export interface OtpVerificationResult {
  verified: boolean;
  userId?: string;
  /** True when this email/IP is currently within its 30-minute post-threshold block; distinguished so the route can apply the documented block response. */
  blocked?: boolean;
}

/**
 * Verifies an OTP for the given email. A wrong attempt is recorded against
 * the shared email+IP rate-limit counter regardless of the specific
 * Supabase Auth error, per login_system_plan.md section 10.2.
 */
export async function verifyOtp(params: OtpVerifyParams): Promise<OtpVerificationResult> {
  const normalizedEmail = normalizeEmail(params.email);

  const blockCheck = await isOtpVerifyBlocked(normalizedEmail, params.sourceIp);
  if (!blockCheck.allowed) {
    logOtpEvent("otp_verify", "VERIFY_BLOCKED");
    return { verified: false, blocked: true };
  }

  const supabase = await createAuthClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: normalizedEmail,
    token: params.otp,
    type: "email",
  });

  if (error || !data.user) {
    await recordFailedOtpVerification(normalizedEmail, params.sourceIp);
    logOtpEvent("otp_verify", "OTP_INVALID_OR_EXPIRED");
    return { verified: false };
  }

  return { verified: true, userId: data.user.id };
}
