import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isConstantTimeMatch, verifyMetaWebhookSignatureWithSecret } from "@/lib/server/webhook-security";

describe("Meta webhook security", () => {
  it("accepts only the SHA-256 signature for the original raw bytes", () => {
    const secret = "application-secret";
    const rawBody = Buffer.from('{"object":"page","name":"Ravi"}', "utf8");
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyMetaWebhookSignatureWithSecret(rawBody, signature, secret)).toBe(true);
    expect(verifyMetaWebhookSignatureWithSecret(Buffer.from('{"object":"page","name":"Maya"}', "utf8"), signature, secret)).toBe(false);
    expect(verifyMetaWebhookSignatureWithSecret(rawBody, null, secret)).toBe(false);
  });

  it("does not treat different-length values as equal", () => {
    expect(isConstantTimeMatch("same", "same")).toBe(true);
    expect(isConstantTimeMatch("same", "short")).toBe(false);
  });
});
