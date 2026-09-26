import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { isAppError } from "@/lib/server/app-error";
import { getRazorpayClient, unixSecondsToIso } from "@/lib/server/razorpay-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Handles a signature-verified Razorpay webhook. We subscribe to `payment.captured` only.
 *
 *   1. record the event once (billing_webhook_events.razorpay_event_id is unique) — a redelivery of an
 *      event we already finished is acknowledged without doing anything
 *   2. ignore anything that is not a captured SUBSCRIPTION payment (no invoice_id = not ours to handle)
 *   3. payment -> invoice -> subscription, read from the Razorpay API with our secret key. The payload
 *      alone carries no tenant, plan, seats or period; the API lookup is also a second, independent
 *      confirmation that the payment is real
 *   4. apply_subscription_payment(): receipt + subscription state + tenant access in one transaction
 *
 * Returned HTTP status is what Razorpay sees. 200 = done, do not resend (also for events we will never
 * be able to process — resending cannot fix them). 500 = something that may work later (Razorpay API,
 * database), so Razorpay redelivers.
 */

const paymentEntitySchema = z.object({
  id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.string(),
  invoice_id: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
  fee: z.number().int().nullable().optional(),
  tax: z.number().int().nullable().optional(),
  created_at: z.number().int(),
});

const webhookSchema = z.object({
  event: z.string().min(1),
  payload: z
    .object({
      payment: z.object({ entity: z.unknown() }).optional(),
    })
    .passthrough(),
});

type ProcessingStatus = "processed" | "ignored" | "failed";

export interface WebhookResult {
  httpStatus: 200 | 500;
  processingStatus: ProcessingStatus | "duplicate";
  reason?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(code: string, extra: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ operation: "razorpay_webhook", code, ...extra }));
}

export async function handleRazorpayWebhook(rawBody: string, suppliedEventId: string | null): Promise<WebhookResult> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Signed by Razorpay yet unparseable: a resend would be identical.
    log("PAYLOAD_UNPARSEABLE");
    return { httpStatus: 200, processingStatus: "ignored", reason: "PAYLOAD_UNPARSEABLE" };
  }

  const envelope = webhookSchema.safeParse(body);
  if (!envelope.success) {
    log("PAYLOAD_UNEXPECTED_SHAPE");
    return { httpStatus: 200, processingStatus: "ignored", reason: "PAYLOAD_UNEXPECTED_SHAPE" };
  }

  const payment = paymentEntitySchema.safeParse(envelope.data.payload.payment?.entity);
  // The header is documented as unique per event; a body hash is only a fallback so a delivery
  // without it is still de-duplicated.
  const eventId = suppliedEventId?.trim() || `body_sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
  const db = getSupabaseAdminClient();

  const { error: insertError } = await db.from("billing_webhook_events").insert({
    razorpay_event_id: eventId,
    event_type: envelope.data.event,
    razorpay_payment_id: payment.success ? payment.data.id : null,
    payload: body,
  });

  if (insertError) {
    if (insertError.code !== "23505") {
      log("EVENT_RECORD_FAILED", { eventId });
      return { httpStatus: 500, processingStatus: "failed", reason: "EVENT_RECORD_FAILED" };
    }

    const { data: existing, error: existingError } = await db
      .from("billing_webhook_events")
      .select("processing_status")
      .eq("razorpay_event_id", eventId)
      .maybeSingle<{ processing_status: string }>();

    if (existingError) {
      return { httpStatus: 500, processingStatus: "failed", reason: "EVENT_LOOKUP_FAILED" };
    }
    if (existing?.processing_status === "processed" || existing?.processing_status === "ignored") {
      return { httpStatus: 200, processingStatus: "duplicate" };
    }
    // 'received' or 'failed': an earlier attempt did not finish. Processing again is safe — every
    // write below is idempotent.
  }

  const result = await processEvent(envelope.data.event, payment.success ? payment.data : null, payment.success);
  await markEvent(eventId, result.processingStatus, result.reason);
  return result;
}

async function processEvent(
  event: string,
  payment: z.infer<typeof paymentEntitySchema> | null,
  paymentParsed: boolean,
): Promise<WebhookResult & { processingStatus: ProcessingStatus }> {
  if (event !== "payment.captured") {
    return { httpStatus: 200, processingStatus: "ignored", reason: "EVENT_NOT_HANDLED" };
  }
  if (!paymentParsed || !payment) {
    log("PAYMENT_ENTITY_UNEXPECTED_SHAPE");
    return { httpStatus: 200, processingStatus: "failed", reason: "PAYMENT_ENTITY_UNEXPECTED_SHAPE" };
  }
  if (payment.status !== "captured") {
    return { httpStatus: 200, processingStatus: "ignored", reason: "PAYMENT_NOT_CAPTURED" };
  }
  // payment.captured fires for every payment on the account; only subscription charges have an invoice.
  if (!payment.invoice_id) {
    return { httpStatus: 200, processingStatus: "ignored", reason: "NOT_SUBSCRIPTION_PAYMENT" };
  }

  try {
    const razorpay = getRazorpayClient();
    const invoice = await razorpay.fetchInvoice(payment.invoice_id);
    if (!invoice.subscription_id) {
      return { httpStatus: 200, processingStatus: "ignored", reason: "INVOICE_NOT_FOR_SUBSCRIPTION" };
    }

    const subscription = await razorpay.fetchSubscription(invoice.subscription_id);

    // The period this payment pays for: the invoice's billing window when present, otherwise the
    // subscription's current cycle.
    const periodStart = invoice.billing_start ?? subscription.current_start;
    const periodEnd = invoice.billing_end ?? subscription.current_end;
    if (periodStart == null || periodEnd == null || periodEnd <= periodStart) {
      // Razorpay may not have advanced the cycle yet; a redelivery later will see it.
      log("PERIOD_NOT_AVAILABLE", { paymentId: payment.id, subscriptionId: subscription.id });
      return { httpStatus: 500, processingStatus: "failed", reason: "PERIOD_NOT_AVAILABLE" };
    }

    const notesTenantId = subscription.notes.tenant_id;

    const { data, error } = await getSupabaseAdminClient().rpc("apply_subscription_payment", {
      p_razorpay_subscription_id: subscription.id,
      p_notes_tenant_id: notesTenantId && UUID_PATTERN.test(notesTenantId) ? notesTenantId : null,
      p_razorpay_status: subscription.status,
      p_seat_quantity: subscription.quantity,
      p_period_start: unixSecondsToIso(periodStart),
      p_period_end: unixSecondsToIso(periodEnd),
      p_razorpay_payment_id: payment.id,
      p_razorpay_invoice_id: invoice.id,
      p_amount_paise: payment.amount,
      p_currency: payment.currency,
      p_payment_method: payment.method ?? null,
      p_fee_paise: payment.fee ?? null,
      p_tax_paise: payment.tax ?? null,
      p_invoice_url: invoice.short_url ?? null,
      p_paid_at: unixSecondsToIso(payment.created_at),
    });

    if (error) {
      log("APPLY_PAYMENT_FAILED", { paymentId: payment.id, dbCode: error.code });
      return { httpStatus: 500, processingStatus: "failed", reason: "APPLY_PAYMENT_FAILED" };
    }

    const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; tenant_id: string | null } | null | undefined;
    switch (row?.outcome) {
      case "APPLIED":
      case "ALREADY_APPLIED":
        return { httpStatus: 200, processingStatus: "processed", reason: row.outcome };
      case "SUBSCRIPTION_UNKNOWN":
      case "TENANT_MISMATCH":
        // Money arrived that we cannot attribute. Never guess a tenant; alert and investigate by hand.
        log("BILLING_SUBSCRIPTION_UNMAPPED", { outcome: row.outcome, paymentId: payment.id, subscriptionId: subscription.id });
        return { httpStatus: 200, processingStatus: "failed", reason: row.outcome };
      default:
        log("APPLY_PAYMENT_UNEXPECTED_RESULT", { paymentId: payment.id });
        return { httpStatus: 500, processingStatus: "failed", reason: "APPLY_PAYMENT_UNEXPECTED_RESULT" };
    }
  } catch (error) {
    if (isAppError(error) && error.code === "RAZORPAY_UNEXPECTED_RESPONSE") {
      log("RAZORPAY_UNEXPECTED_RESPONSE", { paymentId: payment.id, ...(error.details ?? {}) });
      return { httpStatus: 200, processingStatus: "failed", reason: "RAZORPAY_UNEXPECTED_RESPONSE" };
    }
    // Razorpay unreachable or refusing (including a key/mode misconfiguration we can fix): let Razorpay
    // redeliver so the payment is applied once the cause is fixed.
    log("RAZORPAY_LOOKUP_FAILED", {
      paymentId: payment.id,
      ...(isAppError(error) ? { errorCode: error.code, ...(error.details ?? {}) } : { errorMessage: String(error) }),
    });
    return { httpStatus: 500, processingStatus: "failed", reason: "RAZORPAY_LOOKUP_FAILED" };
  }
}

async function markEvent(eventId: string, status: ProcessingStatus, reason: string | undefined): Promise<void> {
  const { error } = await getSupabaseAdminClient()
    .from("billing_webhook_events")
    .update({
      processing_status: status,
      processing_error: status === "failed" ? (reason ?? null) : null,
      processed_at: new Date().toISOString(),
    })
    .eq("razorpay_event_id", eventId);

  if (error) {
    // The payment itself is already applied (or not) transactionally; only the log row is stale.
    log("EVENT_STATUS_WRITE_FAILED", { eventId });
  }
}
