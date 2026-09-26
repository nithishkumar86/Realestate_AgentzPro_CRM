import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleRazorpayWebhook = vi.fn();
vi.mock("@/lib/server/billing-webhook-service", () => ({ handleRazorpayWebhook }));
vi.mock("@/lib/server/env", () => ({
  getRazorpayEnv: () => ({ RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "key-secret", RAZORPAY_WEBHOOK_SECRET: "webhook-secret" }),
  getMetaEnv: () => ({}),
}));

const { POST } = await import("@/app/api/webhooks/razorpay/route");

const BODY = '{"event":"payment.captured","payload":{}}';

function deliver(body: string, signature: string | null, eventId = "evt_1"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-razorpay-event-id": eventId };
  if (signature) headers["x-razorpay-signature"] = signature;
  return new Request("https://crm.example.com/api/webhooks/razorpay", { method: "POST", headers, body });
}

describe("POST /api/webhooks/razorpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleRazorpayWebhook.mockResolvedValue({ httpStatus: 200, processingStatus: "processed" });
  });

  it("rejects a delivery without a valid signature before any processing", async () => {
    expect((await POST(deliver(BODY, null))).status).toBe(400);
    expect((await POST(deliver(BODY, "0".repeat(64)))).status).toBe(400);
    expect(handleRazorpayWebhook).not.toHaveBeenCalled();
  });

  it("passes the exact raw body and event id on to the handler when signed correctly", async () => {
    const signature = createHmac("sha256", "webhook-secret").update(BODY).digest("hex");
    const response = await POST(deliver(BODY, signature, "evt_42"));

    expect(response.status).toBe(200);
    expect(handleRazorpayWebhook).toHaveBeenCalledWith(BODY, "evt_42");
  });

  it("returns the handler's status so Razorpay redelivers on transient failures", async () => {
    handleRazorpayWebhook.mockResolvedValue({ httpStatus: 500, processingStatus: "failed" });
    const signature = createHmac("sha256", "webhook-secret").update(BODY).digest("hex");
    expect((await POST(deliver(BODY, signature))).status).toBe(500);
  });
});
