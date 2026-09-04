import "server-only";

import { AppError, isAppError } from "@/lib/server/app-error";
import { MetaClient, MetaGraphRequestError, type RetrievedMetaLead } from "@/lib/server/meta-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken } from "@/lib/server/token-crypto";

const MAX_RETRIEVAL_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1_000;

type ClaimedWebhookEvent = {
  id: string;
  tenant_id: string;
  facebook_page_record_id: string;
  facebook_page_id: string;
  leadgen_id: string;
  form_id: string;
  ad_id: string | null;
  lead_created_time: string;
  retrieval_attempt_count: number;
};

type WorkerPageConnection = {
  id: string;
  tenant_id: string;
  facebook_page_id: string;
  page_access_token_encrypted: string;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  token_status: "active" | "invalid" | "expired" | "reauthorization_required";
};

export class LeadRetrievalService {
  private readonly metaClient = new MetaClient();

  public async process(webhookNotificationEventId: string): Promise<void> {
    const event = await this.claimEvent(webhookNotificationEventId);
    if (!event) {
      return;
    }

    try {
      const pageConnection = await this.loadPageConnection(event);
      const lead = await this.metaClient.retrieveLead(event.leadgen_id, decryptToken(pageConnection.page_access_token_encrypted));
      this.assertLeadMatchesEvent(lead, event);

      const { error } = await getSupabaseAdminClient().rpc("complete_meta_lead_retrieval_event", {
        p_event_id: event.id,
        p_field_data: lead.field_data,
        p_custom_disclaimer_responses: lead.custom_disclaimer_responses ?? null,
        p_raw_lead_payload: lead.rawPayload,
        p_retrieved_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error("Lead retrieval completion could not be saved.");
      }
    } catch (error) {
      await this.recordFailure(event, error);
    }
  }

  private async claimEvent(eventId: string): Promise<ClaimedWebhookEvent | null> {
    const { data, error } = await getSupabaseAdminClient().rpc("claim_meta_webhook_notification_event", { p_event_id: eventId });
    if (error) {
      throw new Error("Lead retrieval event could not be claimed.");
    }
    return (data as ClaimedWebhookEvent | null) ?? null;
  }

  private async loadPageConnection(event: ClaimedWebhookEvent): Promise<WorkerPageConnection> {
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .select("id,tenant_id,facebook_page_id,page_access_token_encrypted,connection_status,token_status")
      .eq("id", event.facebook_page_record_id)
      .eq("tenant_id", event.tenant_id)
      .maybeSingle();
    const pageConnection = data as WorkerPageConnection | null;

    if (error || !pageConnection) {
      throw new AppError("Stored Facebook Page connection was not found.", { status: 500, code: "META_PAGE_CONNECTION_MISSING" });
    }
    if (pageConnection.facebook_page_id !== event.facebook_page_id) {
      throw new AppError("Stored Facebook Page connection did not match the notification.", { status: 500, code: "META_PAGE_CONNECTION_MISMATCH" });
    }
    if (pageConnection.connection_status !== "active" || pageConnection.token_status !== "active") {
      throw new AppError("Facebook Page authorization is required.", { status: 403, code: "META_REAUTHORIZATION_REQUIRED" });
    }
    return pageConnection;
  }

  private assertLeadMatchesEvent(lead: RetrievedMetaLead, event: ClaimedWebhookEvent): void {
    if (lead.id !== event.leadgen_id || lead.form_id !== event.form_id) {
      throw new AppError("Facebook lead response did not match the notification.", { status: 502, code: "META_LEAD_RESPONSE_MISMATCH" });
    }
    if (event.ad_id !== null && lead.ad_id !== event.ad_id) {
      throw new AppError("Facebook lead attribution did not match the notification.", { status: 502, code: "META_LEAD_ATTRIBUTION_MISMATCH" });
    }
    if (new Date(lead.created_time).getTime() !== new Date(event.lead_created_time).getTime()) {
      throw new AppError("Facebook lead time did not match the notification.", { status: 502, code: "META_LEAD_TIME_MISMATCH" });
    }
  }

  private async recordFailure(event: ClaimedWebhookEvent, error: unknown): Promise<void> {
    const failure = classifyFailure(error);
    const nextAttempt = new Date(Date.now() + calculateRetryDelayMs(event.retrieval_attempt_count));
    const { error: persistenceError } = await getSupabaseAdminClient().rpc("schedule_meta_lead_retrieval_retry", {
      p_event_id: event.id,
      p_next_retrieval_attempt_at: nextAttempt.toISOString(),
      p_error_code: failure.code,
      p_error_message: failure.message,
      p_requires_reauthorization: failure.requiresReauthorization,
      p_force_dead_letter: failure.forceDeadLetter || event.retrieval_attempt_count >= MAX_RETRIEVAL_ATTEMPTS,
    });

    if (persistenceError) {
      throw new Error("Lead retrieval failure could not be recorded.");
    }
  }
}

function classifyFailure(error: unknown): { code: string; message: string; requiresReauthorization: boolean; forceDeadLetter: boolean } {
  if (error instanceof MetaGraphRequestError) {
    return {
      code: error.requiresReauthorization ? "META_REAUTHORIZATION_REQUIRED" : error.code,
      message: error.message,
      requiresReauthorization: error.requiresReauthorization,
      forceDeadLetter: !error.retryable,
    };
  }
  if (isAppError(error)) {
    return {
      code: error.code,
      message: error.message,
      requiresReauthorization: error.code === "META_REAUTHORIZATION_REQUIRED",
      forceDeadLetter: !error.retryable,
    };
  }
  return {
    code: "LEAD_RETRIEVAL_UNEXPECTED_FAILURE",
    message: "The lead retrieval worker encountered an unexpected failure.",
    requiresReauthorization: false,
    forceDeadLetter: false,
  };
}

export function calculateRetryDelayMs(attemptCount: number, randomValue = Math.random()): number {
  const cappedDelay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(attemptCount - 1, 0));
  return Math.floor(Math.min(Math.max(randomValue, 0), 1) * cappedDelay);
}
