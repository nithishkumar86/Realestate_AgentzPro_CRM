import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getMetaEnv } from "@/lib/server/env";

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
