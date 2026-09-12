import "server-only";

import { AppError, isAppError } from "@/lib/server/app-error";
import { MetaClient, MetaGraphRequestError, type RetrievedMetaLead } from "@/lib/server/meta-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken } from "@/lib/server/token-crypto";
import { AdNameResolutionService } from "@/lib/server/ad-name-resolution-service";

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
  claim_token: string;
};

type WorkerPageConnection = {
  id: string;
  tenant_id: string;
  facebook_page_id: string;
  page_access_token_encrypted: string;
  token_expires_at: string | null;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  token_status: "active" | "invalid" | "expired" | "reauthorization_required";
  connection_generation: string;
};

export class LeadRetrievalService {
  private readonly metaClient = new MetaClient();

  public async process(webhookNotificationEventId: string): Promise<void> {
    const event = await this.claimEvent(webhookNotificationEventId);
    if (!event) {
      return;
    }

    let connectionGeneration: string | null = null;
    let pageConnection: WorkerPageConnection | null = null;
    try {
      pageConnection = await this.loadPageConnection(event);
      // Captured before the expiry check so an expired token flags this exact connection for reauthorization.
      connectionGeneration = pageConnection.connection_generation;
      assertPageTokenNotExpired(pageConnection);
      const lead = await this.metaClient.retrieveLead(event.leadgen_id, decryptToken(pageConnection.page_access_token_encrypted));
      this.assertLeadMatchesEvent(lead, event);

      const { data, error } = await getSupabaseAdminClient().rpc("complete_meta_lead_retrieval_event", {
        p_event_id: event.id,
        p_claim_token: event.claim_token,
        p_ad_id: lead.ad_id ?? null,
        p_field_data: lead.field_data,
        p_custom_disclaimer_responses: lead.custom_disclaimer_responses ?? null,
        p_raw_lead_payload: lead.rawPayload,
        p_retrieved_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error("Lead retrieval completion could not be saved.");
      }
      if (data === true && validAdId(lead.ad_id ?? event.ad_id)) {
        try {
          await new AdNameResolutionService().resolveDue(1);
        } catch {
          console.error(JSON.stringify({ operation: "ad_name_resolution", code: "RESOLUTION_DISPATCH_FAILED" }));
        }
      }
    } catch (error) {
      await this.recordFailure(event, await this.confirmObjectAccessFailure(error, pageConnection), connectionGeneration);
    }
  }

  /**
   * GraphMethodException 100/33 means either the lead is gone or the token can no longer read it.
   * Only the second case needs the tenant to reconnect, so check the stored token before pausing the whole Page.
   */
  private async confirmObjectAccessFailure(error: unknown, pageConnection: WorkerPageConnection | null): Promise<unknown> {
    if (!(error instanceof MetaGraphRequestError) || !error.isObjectAccessDenied || !pageConnection) {
      return error;
    }
    try {
      const hasAccess = await this.metaClient.hasPageLeadAccess(pageConnection.facebook_page_id, decryptToken(pageConnection.page_access_token_encrypted));
      return hasAccess
        ? new AppError("Facebook lead is no longer available.", { status: 404, code: "META_LEAD_NOT_AVAILABLE" })
        : new AppError("Facebook Page authorization is required.", { status: 403, code: "META_REAUTHORIZATION_REQUIRED" });
    } catch {
      return new AppError("Facebook could not complete the request.", { status: 502, code: "META_TEMPORARY_FAILURE", retryable: true });
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
      .select("id,tenant_id,facebook_page_id,page_access_token_encrypted,token_expires_at,connection_status,token_status,connection_generation")
      .eq("id", event.facebook_page_record_id)
      .eq("tenant_id", event.tenant_id)
      .maybeSingle();
    const pageConnection = data as WorkerPageConnection | null;

    // A failed lookup and an absent row are different failures. Collapsing them meant a transient
    // database error dead-lettered the lead permanently on its first attempt, because AppError.retryable
    // defaults to false. A lookup that errored is retryable; a row that genuinely is not there is not.
    if (error) {
      throw new AppError("Stored Facebook Page connection could not be loaded.", {
        status: 503,
        code: "META_PAGE_CONNECTION_LOOKUP_FAILED",
        retryable: true,
      });
    }
    if (!pageConnection) {
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

  /**
   * Every mismatch below describes a Graph response that disagrees with the notification Meta already
   * signed. These are marked retryable: they carry HTTP 502 ("bad upstream response"), and with
   * AppError.retryable defaulting to false they previously dead-lettered the lead on its first attempt
   * with no second look. Retryable means the normal attempt budget applies, after which the event still
   * reaches dead_letter — so a genuinely wrong response is never stored, it is just no longer lost to a
   * single transient disagreement.
   */
  private assertLeadMatchesEvent(lead: RetrievedMetaLead, event: ClaimedWebhookEvent): void {
    if (lead.id !== event.leadgen_id || lead.form_id !== event.form_id) {
      throw new AppError("Facebook lead response did not match the notification.", { status: 502, code: "META_LEAD_RESPONSE_MISMATCH", retryable: true });
    }
    if (event.ad_id !== null && lead.ad_id !== event.ad_id) {
      throw new AppError("Facebook lead attribution did not match the notification.", { status: 502, code: "META_LEAD_ATTRIBUTION_MISMATCH", retryable: true });
    }
    const retrievedTime = new Date(lead.created_time).getTime();
    const notifiedTime = new Date(event.lead_created_time).getTime();
    if (retrievedTime !== notifiedTime) {
      // Logged as a second offset only. Meta documents no guarantee that the webhook's Unix created_time
      // and the Graph lead's created_time are identical, so the delta is the diagnostic that tells us
      // whether this is real drift. No lead field is logged.
      console.error(JSON.stringify({
        operation: "lead_retrieval_validation",
        code: "META_LEAD_TIME_MISMATCH",
        deltaSeconds: Number.isFinite(retrievedTime) && Number.isFinite(notifiedTime) ? Math.round((retrievedTime - notifiedTime) / 1000) : null,
      }));
      throw new AppError("Facebook lead time did not match the notification.", { status: 502, code: "META_LEAD_TIME_MISMATCH", retryable: true });
    }
  }

  private async recordFailure(event: ClaimedWebhookEvent, error: unknown, connectionGeneration: string | null): Promise<void> {
    const failure = classifyFailure(error);
    const nextAttempt = new Date(Date.now() + calculateRetryDelayMs(event.retrieval_attempt_count));
    const { error: persistenceError } = await getSupabaseAdminClient().rpc("schedule_meta_lead_retrieval_retry", {
      p_event_id: event.id,
      p_claim_token: event.claim_token,
      p_connection_generation: connectionGeneration,
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

function assertPageTokenNotExpired(pageConnection: WorkerPageConnection): void {
  if (pageConnection.token_expires_at !== null && new Date(pageConnection.token_expires_at).getTime() <= Date.now()) {
    throw new AppError("Facebook Page authorization has expired.", { status: 403, code: "META_REAUTHORIZATION_REQUIRED" });
  }
}

function validAdId(value: string | null | undefined): boolean {
  return typeof value === "string" && !!value.trim() && !/^0+$/.test(value.trim());
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
