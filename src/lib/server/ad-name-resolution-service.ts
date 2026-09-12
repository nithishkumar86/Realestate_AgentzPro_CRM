import "server-only";

import { AppError, isAppError } from "@/lib/server/app-error";
import { MetaClient, MetaGraphRequestError } from "@/lib/server/meta-client";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken } from "@/lib/server/token-crypto";

const MAX_RESOLUTION_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

type ClaimedAd = {
  tenant_id: string;
  ad_id: string;
  source_facebook_page_record_id: string | null;
  claim_token: string;
  retry_count: number;
};

type AuthorizedConnection = {
  tenant_id: string;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  token_status: "active" | "invalid" | "expired" | "reauthorization_required";
  meta_connections: { long_lived_user_access_token_encrypted: string; connection_status: string; user_token_status: string; user_token_expires_at: string | null } | null;
};

export class AdNameResolutionService {
  private readonly metaClient = new MetaClient();

  public async resolveDue(limit = 25): Promise<void> {
    for (let processed = 0; processed < limit; processed += 1) {
      const { data, error } = await getSupabaseAdminClient().rpc("claim_due_meta_ad_name_resolution");
      if (error) throw new Error("Ad-name resolution could not claim pending work.");
      const claimed = data as ClaimedAd | null;
      if (!claimed?.claim_token) return;
      await this.resolveClaim(claimed);
    }
  }

  private async resolveClaim(claimed: ClaimedAd): Promise<void> {
    try {
      const connection = await this.loadConnection(claimed);
      const name = await this.metaClient.retrieveAdName(
        claimed.ad_id,
        decryptToken(connection.meta_connections!.long_lived_user_access_token_encrypted),
      );
      const { error } = await getSupabaseAdminClient().rpc("complete_meta_ad_name_resolution", {
        p_tenant_id: claimed.tenant_id,
        p_ad_id: claimed.ad_id,
        p_claim_token: claimed.claim_token,
        p_ad_name: name,
      });
      if (error) throw new Error("Ad-name resolution completion could not be saved.");
    } catch (error) {
      await this.recordFailure(claimed, error);
    }
  }

  private async loadConnection(claimed: ClaimedAd): Promise<AuthorizedConnection> {
    if (!claimed.source_facebook_page_record_id) {
      throw new AppError("A source Page connection is required to resolve an advertisement name.", { status: 403, code: "META_AD_CONNECTION_MISSING" });
    }
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .select("tenant_id,connection_status,token_status,meta_connections!facebook_pages_connection_tenant_fk(long_lived_user_access_token_encrypted,connection_status,user_token_status,user_token_expires_at)")
      .eq("id", claimed.source_facebook_page_record_id)
      .eq("tenant_id", claimed.tenant_id)
      .maybeSingle();
    const connection = data as AuthorizedConnection | null;
    const userTokenExpiresAt = connection?.meta_connections?.user_token_expires_at;
    const userTokenExpired = userTokenExpiresAt != null && new Date(userTokenExpiresAt).getTime() <= Date.now();
    if (error || !connection || connection.connection_status !== "active" || connection.token_status !== "active"
      || connection.meta_connections?.connection_status !== "active" || connection.meta_connections.user_token_status !== "active"
      || userTokenExpired) {
      throw new AppError("Facebook advertisement access is required.", { status: 403, code: "META_AD_ACCESS_REQUIRED" });
    }
    return connection;
  }

  private async recordFailure(claimed: ClaimedAd, error: unknown): Promise<void> {
    const outcome = classifyResolutionFailure(error);
    const nextRetryAt = outcome.status === "transient_error"
      ? new Date(Date.now() + calculateAdResolutionRetryDelayMs(claimed.retry_count)).toISOString()
      : null;
    const { error: persistenceError } = await getSupabaseAdminClient().rpc("schedule_meta_ad_name_resolution_retry", {
      p_tenant_id: claimed.tenant_id,
      p_ad_id: claimed.ad_id,
      p_claim_token: claimed.claim_token,
      p_status: outcome.status,
      p_next_retry_at: nextRetryAt,
      p_error_code: outcome.code,
      p_error_message: outcome.message,
    });
    if (persistenceError) throw new Error("Ad-name resolution failure could not be saved.");
  }
}

function classifyResolutionFailure(error: unknown): { status: "transient_error" | "access_required" | "ad_unavailable"; code: string; message: string } {
  if (error instanceof MetaGraphRequestError) {
    if (error.requiresReauthorization) return { status: "access_required", code: "META_AD_ACCESS_REQUIRED", message: "Facebook advertisement access is required." };
    if (error.retryable) return { status: "transient_error", code: error.code, message: error.message };
    return { status: "ad_unavailable", code: error.code, message: error.message };
  }
  if (isAppError(error)) {
    return {
      status: error.retryable ? "transient_error" : "access_required",
      code: error.code,
      message: error.message,
    };
  }
  return { status: "transient_error", code: "META_AD_RESOLUTION_UNEXPECTED_FAILURE", message: "The advertisement name could not be resolved." };
}

export function calculateAdResolutionRetryDelayMs(attemptCount: number, randomValue = Math.random()): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  const delay = RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return Math.floor(Math.min(Math.max(randomValue, 0), 1) * delay);
}

export { MAX_RESOLUTION_ATTEMPTS };
