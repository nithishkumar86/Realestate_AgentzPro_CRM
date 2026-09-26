import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const insertEvent = vi.fn();
const selectEvent = vi.fn();
const updateEvent = vi.fn();
const rpc = vi.fn();

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc,
    from: () => ({
      insert: insertEvent,
      select: () => ({ eq: () => ({ maybeSingle: selectEvent }) }),
      update: (values: unknown) => ({ eq: (column: string, value: unknown) => updateEvent(values, column, value) }),
    }),
  }),
}));

const fetchInvoice = vi.fn();
const fetchSubscription = vi.fn();

vi.mock("@/lib/server/razorpay-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/razorpay-client")>()),
  getRazorpayClient: () => ({ fetchInvoice, fetchSubscription }),
}));

const { handleRazorpayWebhook } = await import("@/lib/server/billing-webhook-service");

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const PERIOD_START = 1_790_000_000;
const PERIOD_END = 1_792_678_400;

function capturedBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: "event",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: "pay_ABC",
          entity: "payment",
          amount: 149700,
          currency: "INR",
          status: "captured",
          order_id: "order_X",
          invoice_id: "inv_ABC",
          method: "upi",
          fee: 3533,
          tax: 539,
          notes: [],
          created_at: PERIOD_START + 5,
          ...overrides,
        },
      },
    },
    created_at: PERIOD_START + 10,
  });
}

const INVOICE = {
  id: "inv_ABC",
  subscription_id: "sub_ABC",
  payment_id: "pay_ABC",
  status: "paid",
  billing_start: PERIOD_START,
  billing_end: PERIOD_END,
  short_url: "https://rzp.io/i/abc",
};

const SUBSCRIPTION = {
  id: "sub_ABC",
  plan_id: "plan_PRO",
  status: "active",
  quantity: 3,
  current_start: PERIOD_START,
  current_end: PERIOD_END,
  notes: { tenant_id: TENANT_ID },
};

describe("handleRazorpayWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertEvent.mockResolvedValue({ error: null });
    updateEvent.mockResolvedValue({ error: null });
    fetchInvoice.mockResolvedValue(INVOICE);
    fetchSubscription.mockResolvedValue(SUBSCRIPTION);
    rpc.mockResolvedValue({ data: [{ outcome: "APPLIED", tenant_id: TENANT_ID }], error: null });
  });

  it("applies a captured subscription payment through invoice -> subscription -> RPC", async () => {
    const result = await handleRazorpayWebhook(capturedBody(), "evt_1");

    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "processed" });
    expect(fetchInvoice).toHaveBeenCalledWith("inv_ABC");
    expect(fetchSubscription).toHaveBeenCalledWith("sub_ABC");
    expect(rpc).toHaveBeenCalledWith("apply_subscription_payment", {
      p_razorpay_subscription_id: "sub_ABC",
      p_notes_tenant_id: TENANT_ID,
      p_razorpay_status: "active",
      p_seat_quantity: 3,
      p_period_start: new Date(PERIOD_START * 1000).toISOString(),
      p_period_end: new Date(PERIOD_END * 1000).toISOString(),
      p_razorpay_payment_id: "pay_ABC",
      p_razorpay_invoice_id: "inv_ABC",
      p_amount_paise: 149700,
      p_currency: "INR",
      p_payment_method: "upi",
      p_fee_paise: 3533,
      p_tax_paise: 539,
      p_invoice_url: "https://rzp.io/i/abc",
      p_paid_at: new Date((PERIOD_START + 5) * 1000).toISOString(),
    });
    expect(updateEvent).toHaveBeenCalledWith(expect.objectContaining({ processing_status: "processed" }), "razorpay_event_id", "evt_1");
  });

  it("acknowledges a redelivered event that was already processed without doing anything", async () => {
    insertEvent.mockResolvedValue({ error: { code: "23505" } });
    selectEvent.mockResolvedValue({ data: { processing_status: "processed" }, error: null });

    const result = await handleRazorpayWebhook(capturedBody(), "evt_1");

    expect(result).toEqual({ httpStatus: 200, processingStatus: "duplicate" });
    expect(fetchInvoice).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reprocesses a redelivered event whose earlier attempt failed", async () => {
    insertEvent.mockResolvedValue({ error: { code: "23505" } });
    selectEvent.mockResolvedValue({ data: { processing_status: "failed" }, error: null });

    const result = await handleRazorpayWebhook(capturedBody(), "evt_1");

    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "processed" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("ignores a captured payment that is not a subscription charge (no invoice_id)", async () => {
    const result = await handleRazorpayWebhook(capturedBody({ invoice_id: null }), "evt_2");

    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "ignored", reason: "NOT_SUBSCRIPTION_PAYMENT" });
    expect(fetchInvoice).not.toHaveBeenCalled();
  });

  it("ignores events other than payment.captured", async () => {
    const body = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: {} } } });
    const result = await handleRazorpayWebhook(body, "evt_3");
    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "ignored", reason: "EVENT_NOT_HANDLED" });
  });

  it("never grants access when the subscription was not started from our app, and does not ask for a resend", async () => {
    rpc.mockResolvedValue({ data: [{ outcome: "SUBSCRIPTION_UNKNOWN", tenant_id: null }], error: null });
    const result = await handleRazorpayWebhook(capturedBody(), "evt_4");
    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "failed", reason: "SUBSCRIPTION_UNKNOWN" });
  });

  it("passes a null tenant when notes.tenant_id is missing or malformed, so the RPC refuses the mapping", async () => {
    fetchSubscription.mockResolvedValue({ ...SUBSCRIPTION, notes: { tenant_id: "not-a-uuid" } });
    rpc.mockResolvedValue({ data: [{ outcome: "TENANT_MISMATCH", tenant_id: TENANT_ID }], error: null });

    const result = await handleRazorpayWebhook(capturedBody(), "evt_5");

    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_notes_tenant_id: null });
    expect(result).toMatchObject({ httpStatus: 200, processingStatus: "failed", reason: "TENANT_MISMATCH" });
  });

  it("asks Razorpay to redeliver when the Razorpay API is unavailable", async () => {
    fetchInvoice.mockRejectedValue(new AppError("Razorpay could not be reached.", { status: 502, code: "RAZORPAY_UNAVAILABLE", retryable: true }));
    const result = await handleRazorpayWebhook(capturedBody(), "evt_6");
    expect(result).toMatchObject({ httpStatus: 500, processingStatus: "failed", reason: "RAZORPAY_LOOKUP_FAILED" });
    expect(updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ processing_status: "failed", processing_error: "RAZORPAY_LOOKUP_FAILED" }),
      "razorpay_event_id",
      "evt_6",
    );
  });

  it("asks Razorpay to redeliver when the database write fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "40001" } });
    const result = await handleRazorpayWebhook(capturedBody(), "evt_7");
    expect(result).toMatchObject({ httpStatus: 500, reason: "APPLY_PAYMENT_FAILED" });
  });

  it("falls back to the subscription's cycle when the invoice has no billing window", async () => {
    fetchInvoice.mockResolvedValue({ ...INVOICE, billing_start: null, billing_end: null });
    await handleRazorpayWebhook(capturedBody(), "evt_8");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_period_start: new Date(PERIOD_START * 1000).toISOString(),
      p_period_end: new Date(PERIOD_END * 1000).toISOString(),
    });
  });

  it("retries later when no billing period is known yet", async () => {
    fetchInvoice.mockResolvedValue({ ...INVOICE, billing_start: null, billing_end: null });
    fetchSubscription.mockResolvedValue({ ...SUBSCRIPTION, current_start: null, current_end: null });
    const result = await handleRazorpayWebhook(capturedBody(), "evt_9");
    expect(result).toMatchObject({ httpStatus: 500, reason: "PERIOD_NOT_AVAILABLE" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("de-duplicates by a body hash when the event-id header is missing", async () => {
    await handleRazorpayWebhook(capturedBody(), null);
    expect(insertEvent.mock.calls[0]?.[0]).toMatchObject({ razorpay_event_id: expect.stringMatching(/^body_sha256:[0-9a-f]{64}$/) });
  });

  it("acknowledges a signed but unparseable body instead of looping on retries", async () => {
    const result = await handleRazorpayWebhook("{not json", "evt_10");
    expect(result).toMatchObject({ httpStatus: 200, reason: "PAYLOAD_UNPARSEABLE" });
    expect(insertEvent).not.toHaveBeenCalled();
  });
});
