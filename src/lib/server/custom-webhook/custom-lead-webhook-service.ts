import "server-only";

import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { CustomLeadPayloadError, MAX_CUSTOM_WEBHOOK_BODY_BYTES, mapCustomWebhookLead } from "@/lib/server/custom-webhook/custom-lead-mapper";
import { checkCustomWebhookRate } from "@/lib/server/custom-webhook/webhook-rate-limit";

/** The URL token: 32 random bytes, base64url without padding (43 characters). */
export const CUSTOM_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the webhook route answers. 200 = saved (or already saved: `duplicate`). 4XX = a request we will never accept,
 * with a message the sender's tool shows. 429 = too many leads this minute (try again after `retryAfterSeconds`).
 * 500 = a failure on our side; the tool may retry, and a retry with the same lead_id is never saved twice.
 */
export type CustomWebhookResult =
  | { status: 200; duplicate: boolean }
  | { status: 400 | 404 | 413 | 415 | 500; message: string }
  | { status: 429; message: string; retryAfterSeconds: number };

type WebhookRow = { id: string; tenant_id: string; is_active: boolean };

const UNKNOWN_WEBHOOK = "Unknown webhook.";
const TEMPORARY_FAILURE = "Temporary failure, retry later.";

/** SHA-256 of the URL token, as stored in custom_lead_webhooks.url_token_hash. */
export function hashCustomWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class CustomLeadWebhookService {
  public async ingest(urlToken: string, contentType: string | null, rawBody: string): Promise<CustomWebhookResult> {
    if (!CUSTOM_WEBHOOK_TOKEN_PATTERN.test(urlToken)) return { status: 404, message: UNKNOWN_WEBHOOK };
    if (Buffer.byteLength(rawBody, "utf8") > MAX_CUSTOM_WEBHOOK_BODY_BYTES) return { status: 413, message: "Payload too large." };

    // The company comes only from the URL token; nothing in the body can choose it.
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("custom_lead_webhooks")
      .select("id,tenant_id,is_active")
      .eq("url_token_hash", hashCustomWebhookToken(urlToken))
      .maybeSingle();
    if (error) return failure("WEBHOOK_LOOKUP_FAILED");
    const webhook = data as WebhookRow | null;
    if (!webhook || !webhook.is_active) return { status: 404, message: UNKNOWN_WEBHOOK };

    const rate = await checkCustomWebhookRate(webhook.id);
    if (!rate.allowed) {
      log("RATE_LIMITED", webhook.tenant_id);
      return { status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: rate.retryAfterSeconds };
    }

    let lead;
    try {
      lead = mapCustomWebhookLead(contentType, rawBody);
    } catch (mapError) {
      if (mapError instanceof CustomLeadPayloadError) {
        log("INVALID_PAYLOAD", webhook.tenant_id);
        return { status: mapError.status, message: mapError.message };
      }
      throw mapError;
    }

    const { data: outcome, error: ingestError } = await db.rpc("ingest_custom_webhook_lead", {
      p_tenant_id: webhook.tenant_id,
      p_webhook_id: webhook.id,
      p_lead_ref: lead.leadRef,
      p_source_name: lead.sourceName,
      p_field_data: lead.fieldData,
      p_raw_payload: lead.rawPayload,
    });
    if (ingestError) {
      // The webhook was stopped or replaced between the lookup and the insert.
      if (ingestError.code === "P0002") return { status: 404, message: UNKNOWN_WEBHOOK };
      // The database's own check (no phone and no email, or an over-long source / lead_id).
      if (ingestError.code === "22023") {
        log("INVALID_PAYLOAD", webhook.tenant_id);
        return { status: 400, message: "Send phone or email. source and lead_id must be 200 characters or fewer." };
      }
      return failure("LEAD_INGEST_FAILED", webhook.tenant_id);
    }
    const duplicate = (outcome as { outcome?: unknown } | null)?.outcome === "duplicate";
    log(duplicate ? "DUPLICATE_LEAD" : "LEAD_STORED", webhook.tenant_id);
    return { status: 200, duplicate };
  }
}

function failure(code: string, tenantId?: string): CustomWebhookResult {
  log(code, tenantId);
  return { status: 500, message: TEMPORARY_FAILURE };
}

// Ids and codes only: never an answer, a phone number, an email or the URL token.
function log(code: string, tenantId?: string): void {
  const line = JSON.stringify({ operation: "custom_lead_webhook", code, ...(tenantId ? { tenant_id: tenantId } : {}) });
  if (code.endsWith("FAILED")) console.error(line);
  else console.info(line);
}
