import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { redactLeadFieldsForAi, type LeadField } from "@/lib/server/lead-redaction";
import { AiClassificationError, classifyLead } from "@/lib/server/label-ai-client";

const RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
// Stop claiming new work once a sweep has run this long. One AI call is capped
// at 20s (label-ai-client REQUEST_TIMEOUT_MS), so the sweep always finishes well
// inside Vercel's 300s function limit instead of being killed mid-batch and
// paying for AI calls whose results are then thrown away.
const SWEEP_TIME_BUDGET_MS = 240_000;

type ClaimedClassification = {
  lead_id: string;
  tenant_id: string;
  claim_token: string;
  retry_count: number;
};

type ClassifiableLead = {
  id: string;
  tenant_id: string;
  field_data: LeadField[];
  ad_name: string | null;
  status: string;
};

export class LabelClassificationService {
  /**
   * Runs one sweep of the periodic worker: repairs any classification row
   * that's missing or whose claim lease expired, then claims and processes
   * up to `limit` due jobs one at a time. Never throws for an individual
   * lead's classification failure — that is always recorded as a retry via
   * schedule_label_classification_retry instead, so one bad lead (or a
   * total AI outage) can never stop the sweep or affect any other lead.
   */
  public async processDue(limit = 25, now: () => number = Date.now): Promise<void> {
    const startedAt = now();
    const db = getSupabaseAdminClient();
    // Queue repair failures are logged, not thrown: already-queued due work
    // can still be processed below, and the next sweep retries the repair.
    const { error: recoverError } = await db.rpc("recover_label_classifications");
    if (recoverError) logWorkerIssue("QUEUE_RECOVERY_FAILED");
    const { error: backfillError } = await db.rpc("backfill_missing_label_classifications");
    if (backfillError) logWorkerIssue("QUEUE_BACKFILL_FAILED");

    for (let processed = 0; processed < limit; processed += 1) {
      if (now() - startedAt >= SWEEP_TIME_BUDGET_MS) return;
      const { data, error } = await db.rpc("claim_due_label_classification");
      if (error) throw new Error("Label classification could not claim pending work.");
      const claimed = data as ClaimedClassification | null;
      if (!claimed?.claim_token) return;
      await this.processClaim(claimed);
    }
  }

  private async processClaim(claimed: ClaimedClassification): Promise<void> {
    try {
      const lead = await this.loadLead(claimed);
      const redactedFields = redactLeadFieldsForAi(lead.field_data);
      const classification = await classifyLead({ redactedFields, adName: lead.ad_name, status: lead.status });
      const { error } = await getSupabaseAdminClient().rpc("complete_label_classification", {
        p_lead_id: claimed.lead_id,
        p_tenant_id: claimed.tenant_id,
        p_claim_token: claimed.claim_token,
        p_ai_label: classification.label,
        p_ai_confidence: classification.confidence,
        p_ai_reason: classification.reason,
      });
      if (error) throw new Error("Label classification completion could not be saved.");
    } catch (error) {
      await this.recordFailure(claimed, error);
    }
  }

  private async loadLead(claimed: ClaimedClassification): Promise<ClassifiableLead> {
    const { data, error } = await getSupabaseAdminClient()
      .from("lead_data")
      .select("id,tenant_id,field_data,ad_name,status")
      .eq("id", claimed.lead_id)
      .eq("tenant_id", claimed.tenant_id)
      .maybeSingle();
    if (error || !data) {
      throw new Error("The lead to classify could not be loaded.");
    }
    return data as ClassifiableLead;
  }

  private async recordFailure(claimed: ClaimedClassification, error: unknown): Promise<void> {
    const outcome = classifyFailure(error);
    const nextRetryAt = new Date(Date.now() + calculateClassificationRetryDelayMs(claimed.retry_count)).toISOString();
    const { error: persistenceError } = await getSupabaseAdminClient().rpc("schedule_label_classification_retry", {
      p_lead_id: claimed.lead_id,
      p_tenant_id: claimed.tenant_id,
      p_claim_token: claimed.claim_token,
      p_status: "retry_scheduled",
      p_next_retry_at: nextRetryAt,
      p_error_code: outcome.code,
      p_error_message: outcome.message,
    });
    if (persistenceError) throw new Error("Label classification failure could not be recorded.");
  }
}

function logWorkerIssue(code: string): void {
  console.error(JSON.stringify({ operation: "label_classification_worker", code }));
}

function classifyFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AiClassificationError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "LABEL_CLASSIFICATION_UNEXPECTED_FAILURE", message: error.message };
  }
  return { code: "LABEL_CLASSIFICATION_UNEXPECTED_FAILURE", message: "The lead could not be classified." };
}

export function calculateClassificationRetryDelayMs(attemptCount: number, randomValue = Math.random()): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  const delay = RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return Math.floor(Math.min(Math.max(randomValue, 0), 1) * delay);
}
