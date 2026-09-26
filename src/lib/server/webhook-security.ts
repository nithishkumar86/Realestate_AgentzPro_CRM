import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getMetaEnv, getRazorpayEnv } from "@/lib/server/env";

const META_SIGNATURE_PREFIX = "sha256=";

export function isConstantTimeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyMetaWebhookSignature(rawBody: Buffer, suppliedSignature: string | null): boolean {
  return verifyMetaWebhookSignatureWithSecret(rawBody, suppliedSignature, getMetaEnv().META_APP_SECRET);
}

export function verifyMetaWebhookSignatureWithSecret(rawBody: Buffer, suppliedSignature: string | null, appSecret: string): boolean {
  if (!suppliedSignature?.startsWith(META_SIGNATURE_PREFIX)) {
    return false;
  }

  const expectedSignature = `${META_SIGNATURE_PREFIX}${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return isConstantTimeMatch(expectedSignature, suppliedSignature);
}

/**
 * Razorpay webhook: `X-Razorpay-Signature` is the hex HMAC-SHA256 of the raw request body keyed with
 * the webhook secret (razorpay.com/docs/webhooks/validate-test/). The body must be the exact bytes
 * received — re-serialising parsed JSON changes them and breaks the match.
 */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, suppliedSignature: string | null): boolean {
  return verifyRazorpayWebhookSignatureWithSecret(rawBody, suppliedSignature, getRazorpayEnv().RAZORPAY_WEBHOOK_SECRET);
}

export function verifyRazorpayWebhookSignatureWithSecret(rawBody: Buffer, suppliedSignature: string | null, webhookSecret: string): boolean {
  if (!suppliedSignature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return isConstantTimeMatch(expectedSignature, suppliedSignature);
}

/**
 * Razorpay Checkout success for a subscription: `razorpay_signature` is
 * hmac_sha256(razorpay_payment_id + "|" + subscription_id, key_secret)
 * (razorpay.com/docs/payments/subscriptions/integration-guide/).
 */
export function verifyRazorpayCheckoutSignature(paymentId: string, subscriptionId: string, suppliedSignature: string, keySecret: string): boolean {
  const expectedSignature = createHmac("sha256", keySecret).update(`${paymentId}|${subscriptionId}`).digest("hex");
  return isConstantTimeMatch(expectedSignature, suppliedSignature);
}
