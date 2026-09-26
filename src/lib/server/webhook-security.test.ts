import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isConstantTimeMatch,
  verifyMetaWebhookSignatureWithSecret,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignatureWithSecret,
} from "@/lib/server/webhook-security";

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

describe("Razorpay webhook security", () => {
  const secret = "razorpay-webhook-secret";
  const rawBody = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}', "utf8");
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  it("accepts the hex HMAC of the exact raw bytes", () => {
    expect(verifyRazorpayWebhookSignatureWithSecret(rawBody, signature, secret)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a missing header", () => {
    const tampered = Buffer.from(rawBody.toString("utf8").replace("pay_1", "pay_2"), "utf8");
    expect(verifyRazorpayWebhookSignatureWithSecret(tampered, signature, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignatureWithSecret(rawBody, signature, "another-secret")).toBe(false);
    expect(verifyRazorpayWebhookSignatureWithSecret(rawBody, null, secret)).toBe(false);
  });

  it("rejects a re-serialised body even when the JSON is equivalent", () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8")), null, 2), "utf8");
    expect(verifyRazorpayWebhookSignatureWithSecret(reserialised, signature, secret)).toBe(false);
  });
});

describe("Razorpay checkout signature", () => {
  it("is the HMAC of payment_id|subscription_id with the key secret", () => {
    const keySecret = "key-secret";
    const expected = createHmac("sha256", keySecret).update("pay_A|sub_B").digest("hex");

    expect(verifyRazorpayCheckoutSignature("pay_A", "sub_B", expected, keySecret)).toBe(true);
    expect(verifyRazorpayCheckoutSignature("pay_A", "sub_C", expected, keySecret)).toBe(false);
  });
});
