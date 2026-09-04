import "server-only";

import { createHmac } from "node:crypto";
import { getAuthEnv } from "@/lib/server/env";

/**
 * Non-reversible Redis key identifiers for OTP rate limiting
 * (login_system_plan.md section 10.3). Raw email addresses and raw IP
 * addresses must never appear in a Redis key name; HMAC-SHA-256 with a
 * server-only secret produces a stable, non-reversible identifier instead.
 */

/**
 * Normalizes an email address the same way for every call site so that the
 * same address always hashes to the same identifier, regardless of
 * incidental casing or surrounding whitespace from the input form.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hmacHex(value: string): string {
  return createHmac("sha256", getAuthEnv().OTP_IDENTIFIER_HMAC_SECRET).update(value, "utf8").digest("hex");
}

export function buildOtpSendEmailKey(email: string): string {
  return `otp:send:email:${hmacHex(normalizeEmail(email))}`;
}

export function buildOtpSendIpKey(sourceIp: string): string {
  return `otp:send:ip:${hmacHex(sourceIp)}`;
}

export function buildOtpVerifyKey(email: string, sourceIp: string): string {
  return `otp:verify:${hmacHex(`${normalizeEmail(email)}:${sourceIp}`)}`;
}
