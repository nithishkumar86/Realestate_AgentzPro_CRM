import { describe, expect, it, vi } from "vitest";
import { RazorpayClient, unixSecondsToIso } from "@/lib/server/razorpay-client";

const SUBSCRIPTION = {
  id: "sub_ABC123",
  entity: "subscription",
  plan_id: "plan_PRO",
  status: "created",
  quantity: 3,
  current_start: null,
  current_end: null,
  charge_at: 1770000000,
  notes: { tenant_id: "10000000-0000-0000-0000-000000000001" },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(fetchImplementation: typeof fetch): RazorpayClient {
  return new RazorpayClient({ keyId: "rzp_test_key", keySecret: "secret", fetchImplementation });
}

describe("RazorpayClient", () => {
  it("creates a subscription with Basic auth and the documented body fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SUBSCRIPTION));
    const subscription = await clientWith(fetchMock).createSubscription({
      planId: "plan_PRO",
      quantity: 3,
      totalCount: 120,
      expireBy: 1770000000,
      notes: { tenant_id: SUBSCRIPTION.notes.tenant_id },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("rzp_test_key:secret").toString("base64")}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ plan_id: "plan_PRO", quantity: 3, total_count: 120, expire_by: 1770000000 });
    expect(subscription).toMatchObject({ id: "sub_ABC123", status: "created", quantity: 3 });
  });

  it("normalises Razorpay's empty-array notes to an empty object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ...SUBSCRIPTION, notes: [] }));
    const subscription = await clientWith(fetchMock).fetchSubscription("sub_ABC123");
    expect(subscription.notes).toEqual({});
  });

  it("marks 5xx and 429 as retryable and other 4xx as not", async () => {
    await expect(clientWith(vi.fn().mockResolvedValue(jsonResponse(503, {}))).fetchInvoice("inv_1")).rejects.toMatchObject({
      code: "RAZORPAY_REQUEST_FAILED",
      retryable: true,
    });
    await expect(clientWith(vi.fn().mockResolvedValue(jsonResponse(429, {}))).fetchInvoice("inv_1")).rejects.toMatchObject({ retryable: true });
    await expect(
      clientWith(vi.fn().mockResolvedValue(jsonResponse(400, { error: { code: "BAD_REQUEST_ERROR" } }))).fetchInvoice("inv_1"),
    ).rejects.toMatchObject({ retryable: false, details: { httpStatus: 400, razorpayCode: "BAD_REQUEST_ERROR" } });
  });

  it("treats a network failure as retryable", async () => {
    await expect(clientWith(vi.fn().mockRejectedValue(new TypeError("fetch failed"))).fetchInvoice("inv_1")).rejects.toMatchObject({
      code: "RAZORPAY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("rejects a response whose shape it does not understand", async () => {
    await expect(clientWith(vi.fn().mockResolvedValue(jsonResponse(200, { id: "not-a-sub" }))).fetchSubscription("sub_X")).rejects.toMatchObject({
      code: "RAZORPAY_UNEXPECTED_RESPONSE",
    });
  });

  it("sends cancel_at_cycle_end on cancel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ...SUBSCRIPTION, status: "active" }));
    await clientWith(fetchMock).cancelSubscription("sub_ABC123", { atCycleEnd: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions/sub_ABC123/cancel");
    expect(JSON.parse(init.body as string)).toEqual({ cancel_at_cycle_end: true });
  });
});

describe("unixSecondsToIso", () => {
  it("converts Razorpay seconds to an ISO timestamp", () => {
    expect(unixSecondsToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
