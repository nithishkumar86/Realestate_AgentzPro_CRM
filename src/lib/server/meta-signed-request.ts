import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getMetaEnv } from "@/lib/server/env";

/**
 * Parses and verifies a Meta `signed_request`, as posted to the de-authorize and data-deletion callbacks.
 *
 * Format and verification follow Meta's reference implementation in
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/:
 * the value is `<base64url signature>.<base64url payload>`, and the signature is an HMAC-SHA256 of the
 * ENCODED payload string (not the decoded JSON) keyed by the app secret.
 *
 * Returns null for anything that does not verify. Callers must treat null as "not from Meta" and refuse
 * to act, because both callbacks are unauthenticated public endpoints whose only proof of origin is this
 * signature.
 */

export type MetaSignedRequest = {
  algorithm: string;
  issued_at?: number;
  user_id: string;
};

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function parseMetaSignedRequest(signedRequest: string | null | undefined): MetaSignedRequest | null {
  if (!signedRequest) {
    return null;
  }

  // Exactly two segments. A payload containing a "." would otherwise be silently truncated.
  const segments = signedRequest.split(".");
  if (segments.length !== 2) {
    return null;
  }
  const [encodedSignature, encodedPayload] = segments;
  if (!encodedSignature || !encodedPayload) {
    return null;
  }

  const suppliedSignature = decodeBase64Url(encodedSignature);
  const expectedSignature = createHmac("sha256", getMetaEnv().META_APP_SECRET).update(encodedPayload).digest();
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const { algorithm, issued_at: issuedAt, user_id: userId } = payload as Record<string, unknown>;
  // Meta documents HMAC-SHA256 as the algorithm; refusing anything else stops a future or forged payload
  // from downgrading the verification this function just performed.
  if (algorithm !== "HMAC-SHA256" || typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  return { algorithm, issued_at: typeof issuedAt === "number" ? issuedAt : undefined, user_id: userId };
}

/** Reads `signed_request` from either a form post (what Meta sends) or a JSON body. */
export async function readSignedRequestFromBody(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { signed_request?: unknown };
      return typeof body.signed_request === "string" ? body.signed_request : null;
    }
    const form = await request.formData();
    const value = form.get("signed_request");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
