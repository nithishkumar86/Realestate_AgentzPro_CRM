import "server-only";

import { decryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { isConstantTimeMatch } from "@/lib/server/webhook-security";
import { GoogleLeadPayloadError, mapGoogleWebhookLead } from "@/lib/server/google/google-lead-mapper";

export const URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * What the webhook route answers. Google's rules
 * (https://developers.google.com/google-ads/webhook/docs/implementation): 200 `{}` = success, 4XX with a
 * `message` = request error and is never retried, 5XX = retried. So only a failure on our side is 5XX.
 */
export type GoogleWebhookResult = { status: 200 | 400 | 403 | 404 | 413 | 500; message?: string; outcome?: "stored" | "duplicate" | "test" };

type WebhookRow = { id: string; tenant_id: string; encrypted_google_key: string; is_active: boolean };

export class GoogleLeadWebhookService {
  public async ingest(urlToken: string, rawBody: string): Promise<GoogleWebhookResult> {
    if (!URL_TOKEN_PATTERN.test(urlToken)) return { status: 404, message: "Unknown webhook." };
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) return { status: 413, message: "Payload too large." };

    let lead;
    try {
      lead = mapGoogleWebhookLead(rawBody);
    } catch (error) {
      if (error instanceof GoogleLeadPayloadError) return { status: 400, message: "Invalid lead payload." };
      throw error;
    }

    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("google_lead_webhooks")
      .select("id,tenant_id,encrypted_google_key,is_active")
      .eq("url_token", urlToken)
      .maybeSingle();
    if (error) return failure("WEBHOOK_LOOKUP_FAILED");
    const webhook = data as WebhookRow | null;
    if (!webhook || !webhook.is_active) return { status: 404, message: "Unknown webhook." };

    let expectedKey: string;
    try {
      expectedKey = decryptToken(webhook.encrypted_google_key);
    } catch {
      return failure("WEBHOOK_KEY_UNREADABLE", webhook.tenant_id);
    }
    if (!lead.googleKey || !isConstantTimeMatch(expectedKey, lead.googleKey)) {
      log("GOOGLE_KEY_MISMATCH", webhook.tenant_id);
      return { status: 403, message: "Invalid google_key." };
    }

    const { data: outcome, error: ingestError } = await db.rpc("ingest_google_lead", {
      p_tenant_id: webhook.tenant_id,
      p_webhook_id: webhook.id,
      p_google_lead_id: lead.googleLeadId,
      p_is_test: lead.isTest,
      p_form_id: lead.formId,
      p_campaign_id: lead.campaignId,
      p_adgroup_id: lead.adgroupId,
      p_creative_id: lead.creativeId,
      p_asset_group_id: lead.assetGroupId,
      p_gcl_id: lead.gclId,
      p_submit_time: lead.submitTime,
      p_field_data: lead.fieldData,
      p_raw_payload: lead.rawPayload,
    });
    if (ingestError) {
      // The webhook was deactivated between the lookup and the insert.
      if (ingestError.code === "P0002") return { status: 404, message: "Unknown webhook." };
      return failure("LEAD_INGEST_FAILED", webhook.tenant_id);
    }
    log(outcome === "test" ? "TEST_LEAD_RECEIVED" : outcome === "duplicate" ? "DUPLICATE_LEAD" : "LEAD_STORED", webhook.tenant_id);
    return { status: 200, outcome: outcome as GoogleWebhookResult["outcome"] };
  }
}

function failure(code: string, tenantId?: string): GoogleWebhookResult {
  log(code, tenantId);
  return { status: 500, message: "Temporary failure, retry later." };
}

// Ids and codes only: never an answer (string_value) or the google_key.
function log(code: string, tenantId?: string): void {
  const line = JSON.stringify({ operation: "google_lead_webhook", code, ...(tenantId ? { tenant_id: tenantId } : {}) });
  if (code.endsWith("FAILED") || code.endsWith("UNREADABLE") || code === "GOOGLE_KEY_MISMATCH") console.error(line);
  else console.info(line);
}
