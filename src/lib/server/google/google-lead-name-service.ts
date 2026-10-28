import "server-only";

import { decryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { GoogleAdsApiError, readGaqlId, searchGoogleAds } from "@/lib/server/google/google-ads-client";
import { GoogleOAuthError, refreshGoogleAccessToken } from "@/lib/server/google/google-oauth";

const RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
// Same reasoning as the label worker: finish well inside Vercel's 300s limit.
const SWEEP_TIME_BUDGET_MS = 240_000;

type ClaimedEvent = { id: string; tenant_id: string; claim_token: string; name_attempts: number };
type LeadIds = { google_campaign_id: string | null; google_adgroup_id: string | null; google_asset_group_id: string | null };
type LinkedAccount = { customer_id: string; login_customer_id: string | null };
type EntityType = "campaign" | "ad_group" | "asset_group";

/** The tenant cannot be looked up right now; the lead waits until the owner (re)connects Google. */
class ParkError extends Error {
  public constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * Fills lead_data.ad_name for Google Ads leads with "<campaign> › <ad group or asset group>", using the
 * tenant's own Google sign-in and read-only GAQL queries. The webhook carries only ids and no account id,
 * so the owning account is found by asking each linked account and remembered in google_ads_entity_names.
 * A lead is never held back by this: it is already saved and labelled; only the name arrives later.
 */
export class GoogleLeadNameService {
  private readonly accessTokens = new Map<string, Promise<string>>();

  public async processDue(limit = 25, now: () => number = Date.now): Promise<void> {
    const startedAt = now();
    const db = getSupabaseAdminClient();
    const { error: recoverError } = await db.rpc("recover_google_lead_names");
    if (recoverError) logWorkerIssue("QUEUE_RECOVERY_FAILED");

    for (let processed = 0; processed < limit; processed += 1) {
      if (now() - startedAt >= SWEEP_TIME_BUDGET_MS) return;
      const { data, error } = await db.rpc("claim_due_google_lead_name");
      if (error) throw new Error("Google lead names could not claim pending work.");
      const claimed = data as ClaimedEvent | null;
      if (!claimed?.claim_token) return;
      await this.processClaim(claimed);
    }
  }

  private async processClaim(claimed: ClaimedEvent): Promise<void> {
    try {
      const name = await this.resolveName(claimed);
      const { error } = await getSupabaseAdminClient().rpc("complete_google_lead_name", {
        p_event_id: claimed.id, p_tenant_id: claimed.tenant_id, p_claim_token: claimed.claim_token, p_ad_name: name,
      });
      if (error) throw new Error("Google lead name could not be saved.");
    } catch (error) {
      await this.recordFailure(claimed, error);
    }
  }

  private async resolveName(claimed: ClaimedEvent): Promise<string> {
    const db = getSupabaseAdminClient();
    const { data: lead, error } = await db.from("lead_data")
      .select("google_campaign_id,google_adgroup_id,google_asset_group_id")
      .eq("tenant_id", claimed.tenant_id)
      .eq("google_lead_event_id", claimed.id)
      .maybeSingle();
    if (error) throw new Error("The Google lead could not be loaded.");
    const ids = lead as LeadIds | null;
    if (!ids?.google_campaign_id) throw new GoogleAdsApiError("LEAD_NOT_FOUND", 0, false);

    const accounts = await this.loadAccounts(claimed.tenant_id);
    const accessToken = await this.getAccessToken(claimed.tenant_id);
    const campaign = await this.lookupName(claimed.tenant_id, accessToken, accounts, "campaign", ids.google_campaign_id, null);
    if (!campaign) throw new GoogleAdsApiError("CAMPAIGN_NOT_FOUND", 0, true);

    // Ad group (video / discovery) or asset group (Performance Max) live in the campaign's account.
    const owner = accounts.filter((account) => account.customer_id === campaign.customerId);
    const subType: EntityType | null = ids.google_asset_group_id ? "asset_group" : ids.google_adgroup_id ? "ad_group" : null;
    const subId = ids.google_asset_group_id ?? ids.google_adgroup_id;
    let subName: string | null = null;
    if (subType && subId) {
      try {
        subName = (await this.lookupName(claimed.tenant_id, accessToken, owner, subType, subId, campaign.customerId))?.name ?? null;
      } catch {
        subName = null; // the campaign name alone is still a useful name
      }
    }
    return subName ? `${campaign.name} › ${subName}` : campaign.name;
  }

  private async loadAccounts(tenantId: string): Promise<LinkedAccount[]> {
    const { data, error } = await getSupabaseAdminClient().from("google_ads_accounts")
      .select("customer_id,login_customer_id")
      .eq("tenant_id", tenantId)
      .eq("is_manager", false);
    if (error) throw new Error("Google Ads accounts could not be loaded.");
    const accounts = (data ?? []) as LinkedAccount[];
    if (accounts.length === 0) throw new ParkError("GOOGLE_ACCOUNTS_REQUIRED");
    return accounts;
  }

  /** One token refresh per tenant per sweep. */
  private getAccessToken(tenantId: string): Promise<string> {
    let token = this.accessTokens.get(tenantId);
    if (!token) {
      token = this.refreshAccessToken(tenantId);
      token.catch(() => this.accessTokens.delete(tenantId));
      this.accessTokens.set(tenantId, token);
    }
    return token;
  }

  private async refreshAccessToken(tenantId: string): Promise<string> {
    const { data, error } = await getSupabaseAdminClient().from("google_connections")
      .select("encrypted_refresh_token,status")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error("The Google connection could not be loaded.");
    const connection = data as { encrypted_refresh_token: string | null; status: string } | null;
    if (!connection || connection.status !== "active" || !connection.encrypted_refresh_token) throw new ParkError("GOOGLE_CONNECTION_REQUIRED");
    try {
      return await refreshGoogleAccessToken(decryptToken(connection.encrypted_refresh_token));
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === "invalid_grant") throw new ParkError("GOOGLE_REAUTHORIZATION_REQUIRED");
      throw error;
    }
  }

  /** Cache first; otherwise ask each candidate account until one owns the id, then remember the answer. */
  private async lookupName(tenantId: string, accessToken: string, accounts: LinkedAccount[], type: EntityType, entityId: string, knownCustomerId: string | null): Promise<{ name: string; customerId: string } | null> {
    if (!/^\d{1,30}$/.test(entityId)) return null;
    const db = getSupabaseAdminClient();
    const { data: cached } = await db.from("google_ads_entity_names")
      .select("name,customer_id")
      .eq("tenant_id", tenantId).eq("entity_type", type).eq("entity_id", entityId)
      .maybeSingle();
    if (cached?.name && typeof cached.customer_id === "string") return { name: String(cached.name), customerId: cached.customer_id };

    const query = `SELECT ${type}.id, ${type}.name FROM ${type} WHERE ${type}.id = ${entityId}`;
    let lastError: unknown = null;
    for (const account of accounts) {
      if (knownCustomerId && account.customer_id !== knownCustomerId) continue;
      try {
        const rows = await searchGoogleAds(accessToken, account.customer_id, account.login_customer_id, query);
        const row = rows.find((candidate) => readGaqlId(candidate[toResultKey(type)]?.id) === entityId);
        const name = row?.[toResultKey(type)]?.name;
        if (typeof name === "string" && name.trim()) {
          await db.from("google_ads_entity_names").upsert({
            tenant_id: tenantId, entity_type: type, entity_id: entityId, customer_id: account.customer_id,
            name: name.trim().slice(0, 500), fetched_at: new Date().toISOString(),
          }, { onConflict: "tenant_id,entity_type,entity_id" });
          return { name: name.trim(), customerId: account.customer_id };
        }
      } catch (error) {
        lastError = error; // this account may simply not be reachable; try the others
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  private async recordFailure(claimed: ClaimedEvent, error: unknown): Promise<void> {
    const park = error instanceof ParkError;
    const code = park ? error.code
      : error instanceof GoogleAdsApiError || error instanceof GoogleOAuthError ? error.code
      : "GOOGLE_NAME_LOOKUP_FAILED";
    if (!park) logWorkerIssue("LEAD_NAME_LOOKUP_FAILED", { error_code: code, event_id: claimed.id, tenant_id: claimed.tenant_id });
    try {
      const { error: persistenceError } = await getSupabaseAdminClient().rpc("schedule_google_lead_name_retry", {
        p_event_id: claimed.id,
        p_tenant_id: claimed.tenant_id,
        p_claim_token: claimed.claim_token,
        p_next_attempt_at: new Date(Date.now() + calculateNameRetryDelayMs(claimed.name_attempts)).toISOString(),
        p_error_code: code,
        p_park: park,
      });
      if (persistenceError) logWorkerIssue("RETRY_RECORD_FAILED", { event_id: claimed.id, tenant_id: claimed.tenant_id });
    } catch {
      logWorkerIssue("RETRY_RECORD_FAILED", { event_id: claimed.id, tenant_id: claimed.tenant_id });
    }
  }
}

/** GAQL resource names are snake_case; REST JSON results are camelCase (ad_group -> adGroup). */
function toResultKey(type: EntityType): string {
  return type.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function logWorkerIssue(code: string, details: Record<string, string> = {}): void {
  console.error(JSON.stringify({ operation: "google_lead_name_worker", code, ...details }));
}

export function calculateNameRetryDelayMs(attemptCount: number, randomValue = Math.random()): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  const delay = RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  // At least 10s, so a retry never lands in the same sweep.
  return Math.max(10_000, Math.floor(Math.min(Math.max(randomValue, 0), 1) * delay));
}
