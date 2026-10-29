import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { listAccessibleCustomers, readGaqlId, searchGoogleAds } from "@/lib/server/google/google-ads-client";
import {
  GOOGLE_OAUTH_STATE_TTL_SECONDS, GoogleOAuthError, assertGoogleAdsScopeGranted, buildGoogleAuthorizationUrl,
  createOAuthNonce, exchangeGoogleAuthorizationCode, refreshGoogleAccessToken, revokeGoogleToken, signOAuthState,
  verifyOAuthState,
} from "@/lib/server/google/google-oauth";

// Cap on accounts checked when listing, so one huge manager hierarchy cannot run the request long.
const MAX_ACCESSIBLE_ACCOUNTS = 50;

export interface GoogleAdsAccountOption {
  customerId: string;
  name: string | null;
  /** Manager account this account is reached through; null for direct access. */
  loginCustomerId: string | null;
  selected: boolean;
}

export interface GoogleAdsOverview {
  canManage: boolean;
  connection: { email: string; connectedAt: string } | null;
  /** Google stopped accepting the saved sign-in (revoked from the Google account, or expired). */
  needsReconnect: boolean;
  linkedAccounts: Array<{ customerId: string; name: string | null }>;
  /** Only for the owner: what to paste into Google Ads. */
  webhook: { url: string; key: string; lastLeadAt: string | null; lastTestAt: string | null } | null;
  hasWebhook: boolean;
}

type ConnectionRow = { id: string; google_sub: string; google_email: string; encrypted_refresh_token: string | null; status: string; connected_at: string };
type WebhookRow = { url_token: string; encrypted_google_key: string; last_lead_received_at: string | null; last_test_received_at: string | null };

async function resolveOwner(): Promise<{ tenantId: string; userId: string }> {
  const access = await requireCrmAccess();
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the company owner can manage Google Ads.", { status: 403, code: "GOOGLE_OWNER_REQUIRED" });
  }
  return { tenantId: access.tenantId, userId: access.userId };
}

export class GoogleConnectionService {
  public async getOverview(origin: string): Promise<GoogleAdsOverview> {
    const access = await requireCrmAccess();
    const canManage = access.membershipRole === "owner";
    const db = getSupabaseAdminClient();
    const [connectionResult, accountsResult, webhookResult, reauthResult] = await Promise.all([
      db.from("google_connections").select("google_email,status,connected_at").eq("tenant_id", access.tenantId).maybeSingle(),
      db.from("google_ads_accounts").select("customer_id,descriptive_name").eq("tenant_id", access.tenantId).eq("is_manager", false).order("descriptive_name"),
      db.from("google_lead_webhooks").select("url_token,encrypted_google_key,last_lead_received_at,last_test_received_at").eq("tenant_id", access.tenantId).eq("is_active", true).maybeSingle(),
      db.from("google_lead_events").select("id").eq("tenant_id", access.tenantId).eq("status", "names_pending").is("next_name_attempt_at", null).eq("last_error_code", "GOOGLE_REAUTHORIZATION_REQUIRED").limit(1),
    ]);
    if (connectionResult.error || accountsResult.error || webhookResult.error || reauthResult.error) {
      throw new AppError("Google Ads details could not be loaded.", { status: 500, code: "GOOGLE_OVERVIEW_FAILED" });
    }
    const connection = connectionResult.data as { google_email: string; status: string; connected_at: string } | null;
    const webhook = webhookResult.data as WebhookRow | null;
    const isConnected = connection?.status === "active";
    return {
      canManage,
      connection: isConnected && connection ? { email: connection.google_email, connectedAt: connection.connected_at } : null,
      needsReconnect: isConnected && (reauthResult.data ?? []).length > 0,
      linkedAccounts: isConnected ? (accountsResult.data ?? []).map((row) => ({ customerId: String(row.customer_id), name: (row.descriptive_name as string | null) ?? null })) : [],
      webhook: canManage && webhook ? {
        url: buildWebhookUrl(origin, webhook.url_token),
        key: decryptToken(webhook.encrypted_google_key),
        lastLeadAt: webhook.last_lead_received_at,
        lastTestAt: webhook.last_test_received_at,
      } : null,
      hasWebhook: Boolean(webhook),
    };
  }

  /** Starts Google sign-in: returns the Google URL and the nonce the route stores in an httpOnly cookie. */
  public async startConnect(): Promise<{ authorizationUrl: string; nonce: string }> {
    const owner = await resolveOwner();
    const nonce = createOAuthNonce();
    const state = signOAuthState({ tenantId: owner.tenantId, userId: owner.userId, nonce, expiresAt: Date.now() + GOOGLE_OAUTH_STATE_TTL_SECONDS * 1000 });
    return { authorizationUrl: buildGoogleAuthorizationUrl(state), nonce };
  }

  /**
   * Google's redirect back. The signed state must name this signed-in owner and tenant and carry the nonce
   * from the cookie set on this browser at the start, so a callback from another session is refused.
   */
  public async completeConnect(code: string | null, stateValue: string | null, cookieNonce: string | null): Promise<void> {
    const owner = await resolveOwner();
    const state = verifyOAuthState(stateValue);
    if (!state || !cookieNonce || state.nonce !== cookieNonce || state.tenantId !== owner.tenantId || state.userId !== owner.userId) {
      throw new AppError("The Google sign-in could not be verified. Try again.", { status: 400, code: "GOOGLE_STATE_INVALID" });
    }
    if (!code) throw new AppError("Google did not return an authorization code.", { status: 400, code: "GOOGLE_CODE_MISSING" });

    const authorization = await exchangeGoogleAuthorizationCode(code).catch((error: unknown) => {
      throw toAppError(error, "Google sign-in could not be completed.");
    });
    try {
      assertGoogleAdsScopeGranted(authorization.grantedScopes);
    } catch (error) {
      await revokeGoogleToken(authorization.refreshToken);
      throw error;
    }

    const db = getSupabaseAdminClient();
    const { data: existing } = await db.from("google_connections").select("google_sub").eq("tenant_id", owner.tenantId).maybeSingle();
    // A different Google user cannot reach the accounts the previous one picked; start the picks over.
    if (existing && existing.google_sub !== authorization.googleSub) await this.clearAccounts(owner.tenantId);

    const { error } = await db.from("google_connections").upsert({
      tenant_id: owner.tenantId,
      google_sub: authorization.googleSub,
      google_email: authorization.googleEmail,
      encrypted_refresh_token: encryptToken(authorization.refreshToken),
      granted_scopes: authorization.grantedScopes,
      status: "active",
      connected_by_user_id: owner.userId,
      connected_at: new Date().toISOString(),
      revoked_at: null,
    }, { onConflict: "tenant_id" });
    if (error) throw new AppError("The Google connection could not be saved.", { status: 500, code: "GOOGLE_CONNECTION_SAVE_FAILED" });
    await this.requeueNames(owner.tenantId);
  }

  /** Every non-manager account the signed-in Google user can reach: directly, or as a direct client of a manager. */
  public async listAccountOptions(): Promise<GoogleAdsAccountOption[]> {
    const owner = await resolveOwner();
    const accessToken = await this.getAccessToken(owner.tenantId);
    const options = await discoverAccounts(accessToken);
    const { data } = await getSupabaseAdminClient().from("google_ads_accounts").select("customer_id").eq("tenant_id", owner.tenantId);
    const selected = new Set((data ?? []).map((row) => String(row.customer_id)));
    return options.map((option) => ({ ...option, selected: selected.has(option.customerId) }));
  }

  /** Saves the owner's picks. Re-read from Google, so only accounts this user can really reach are stored. */
  public async saveAccounts(customerIds: string[]): Promise<void> {
    const owner = await resolveOwner();
    const accessToken = await this.getAccessToken(owner.tenantId);
    const wanted = new Set(customerIds);
    const picks = (await discoverAccounts(accessToken)).filter((option) => wanted.has(option.customerId));
    if (picks.length !== wanted.size) {
      throw new AppError("One of the selected Google Ads accounts is no longer available.", { status: 400, code: "GOOGLE_ACCOUNT_UNAVAILABLE" });
    }
    const db = getSupabaseAdminClient();
    const { error: deleteError } = await db.from("google_ads_accounts").delete().eq("tenant_id", owner.tenantId)
      .not("customer_id", "in", `(${picks.map((pick) => pick.customerId).join(",") || "0"})`);
    if (deleteError) throw new AppError("Google Ads accounts could not be saved.", { status: 500, code: "GOOGLE_ACCOUNTS_SAVE_FAILED" });
    if (picks.length > 0) {
      const { error } = await db.from("google_ads_accounts").upsert(picks.map((pick) => ({
        tenant_id: owner.tenantId, customer_id: pick.customerId, descriptive_name: pick.name,
        is_manager: false, login_customer_id: pick.loginCustomerId,
      })), { onConflict: "tenant_id,customer_id" });
      if (error) throw new AppError("Google Ads accounts could not be saved.", { status: 500, code: "GOOGLE_ACCOUNTS_SAVE_FAILED" });
    }
    await this.requeueNames(owner.tenantId);
  }

  /**
   * Revokes the grant at Google, then deletes the token, the account picks and cached names. Leads already
   * received stay, and the webhook stays on, so new leads keep arriving (they wait for a name). Stopping leads
   * is stopWebhook.
   */
  public async disconnect(): Promise<void> {
    const owner = await resolveOwner();
    const db = getSupabaseAdminClient();
    const { data } = await db.from("google_connections").select("id,encrypted_refresh_token,status").eq("tenant_id", owner.tenantId).maybeSingle();
    const connection = data as Pick<ConnectionRow, "id" | "encrypted_refresh_token" | "status"> | null;
    if (!connection || connection.status !== "active" || !connection.encrypted_refresh_token) return;
    if (!(await revokeGoogleToken(decryptToken(connection.encrypted_refresh_token)))) {
      throw new AppError("Google could not be reached to revoke access. Try again.", { status: 502, code: "GOOGLE_REVOKE_FAILED", retryable: true });
    }
    const { error } = await db.from("google_connections")
      .update({ status: "revoked", encrypted_refresh_token: null, revoked_at: new Date().toISOString() })
      .eq("tenant_id", owner.tenantId).eq("id", connection.id);
    if (error) throw new AppError("The Google connection could not be removed.", { status: 500, code: "GOOGLE_DISCONNECT_FAILED" });
    await this.clearAccounts(owner.tenantId);
  }

  /**
   * Creates the tenant's webhook URL and key, or replaces the key (the URL stays the same). After a rotation
   * Google Ads must be given the new key, or its deliveries are refused with 403.
   */
  public async createOrRotateWebhook(origin: string): Promise<{ url: string; key: string }> {
    const owner = await resolveOwner();
    const db = getSupabaseAdminClient();
    const key = randomBytes(24).toString("base64url");
    const { data: existing } = await db.from("google_lead_webhooks").select("url_token").eq("tenant_id", owner.tenantId).maybeSingle();
    if (existing) {
      const { error } = await db.from("google_lead_webhooks")
        .update({ encrypted_google_key: encryptToken(key), is_active: true, key_rotated_at: new Date().toISOString() })
        .eq("tenant_id", owner.tenantId);
      if (error) throw new AppError("The webhook key could not be saved.", { status: 500, code: "GOOGLE_WEBHOOK_SAVE_FAILED" });
      return { url: buildWebhookUrl(origin, String(existing.url_token)), key };
    }
    const urlToken = randomBytes(32).toString("base64url");
    const { error } = await db.from("google_lead_webhooks").insert({ tenant_id: owner.tenantId, url_token: urlToken, encrypted_google_key: encryptToken(key) });
    if (error) throw new AppError("The webhook could not be created.", { status: 500, code: "GOOGLE_WEBHOOK_SAVE_FAILED" });
    return { url: buildWebhookUrl(origin, urlToken), key };
  }

  /**
   * Stops Google Ads leads for this company: the webhook is switched off, so every delivery (real or test) is
   * refused with 404 and nothing is saved (the webhook route and ingest_google_lead both require is_active).
   * Google has no reliable way to remove a webhook from a lead form, so this switch is what actually stops leads.
   * Leads already received stay. createOrRotateWebhook switches it back on, always with a NEW key, so the old key
   * pasted in Google stays dead.
   */
  public async stopWebhook(): Promise<void> {
    const owner = await resolveOwner();
    const { error } = await getSupabaseAdminClient().from("google_lead_webhooks")
      .update({ is_active: false })
      .eq("tenant_id", owner.tenantId);
    if (error) throw new AppError("Google Ads leads could not be stopped. Try again.", { status: 500, code: "GOOGLE_WEBHOOK_STOP_FAILED" });
  }

  private async getAccessToken(tenantId: string): Promise<string> {
    const { data } = await getSupabaseAdminClient().from("google_connections").select("encrypted_refresh_token,status").eq("tenant_id", tenantId).maybeSingle();
    const connection = data as Pick<ConnectionRow, "encrypted_refresh_token" | "status"> | null;
    if (!connection || connection.status !== "active" || !connection.encrypted_refresh_token) {
      throw new AppError("Connect Google Ads first.", { status: 409, code: "GOOGLE_NOT_CONNECTED" });
    }
    return refreshGoogleAccessToken(decryptToken(connection.encrypted_refresh_token)).catch((error: unknown) => {
      throw toAppError(error, "Google Ads could not be reached.");
    });
  }

  private async clearAccounts(tenantId: string): Promise<void> {
    const db = getSupabaseAdminClient();
    const [accounts, names] = await Promise.all([
      db.from("google_ads_accounts").delete().eq("tenant_id", tenantId),
      db.from("google_ads_entity_names").delete().eq("tenant_id", tenantId),
    ]);
    if (accounts.error || names.error) throw new AppError("Google Ads accounts could not be cleared.", { status: 500, code: "GOOGLE_ACCOUNTS_CLEAR_FAILED" });
  }

  private async requeueNames(tenantId: string): Promise<void> {
    const { error } = await getSupabaseAdminClient().rpc("requeue_google_lead_names", { p_tenant_id: tenantId });
    if (error) console.error(JSON.stringify({ operation: "google_connection", code: "NAME_REQUEUE_FAILED", tenant_id: tenantId }));
  }
}

async function discoverAccounts(accessToken: string): Promise<Array<Omit<GoogleAdsAccountOption, "selected">>> {
  const accessible = (await listAccessibleCustomers(accessToken).catch((error: unknown) => {
    throw toAppError(error, "Google Ads accounts could not be loaded.");
  })).slice(0, MAX_ACCESSIBLE_ACCOUNTS);
  const options = new Map<string, Omit<GoogleAdsAccountOption, "selected">>();
  for (const customerId of accessible) {
    let rows;
    try {
      rows = await searchGoogleAds(accessToken, customerId, null,
        "SELECT customer.id, customer.descriptive_name, customer.manager, customer.status FROM customer LIMIT 1");
    } catch {
      continue; // e.g. a cancelled or not-yet-enabled account: nothing to pick
    }
    const customer = rows[0]?.customer;
    if (!customer || customer.status !== "ENABLED") continue;
    if (customer.manager !== true) {
      options.set(customerId, { customerId, name: readName(customer), loginCustomerId: null });
      continue;
    }
    // A manager account has no campaigns itself: offer its direct, enabled client accounts.
    try {
      const clients = await searchGoogleAds(accessToken, customerId, customerId,
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED' AND customer_client.manager = FALSE");
      for (const row of clients) {
        const client = row.customerClient;
        const clientId = readGaqlId(client?.id);
        if (!clientId || clientId.length !== 10 || options.has(clientId)) continue;
        options.set(clientId, { customerId: clientId, name: typeof client?.descriptiveName === "string" ? client.descriptiveName : null, loginCustomerId: customerId });
      }
    } catch {
      continue;
    }
  }
  return [...options.values()].sort((a, b) => (a.name ?? a.customerId).localeCompare(b.name ?? b.customerId));
}

/** REST JSON is camelCase: customer.descriptive_name arrives as descriptiveName. */
function readName(customer: Record<string, unknown>): string | null {
  return typeof customer.descriptiveName === "string" ? customer.descriptiveName : null;
}

function buildWebhookUrl(origin: string, urlToken: string): string {
  return new URL(`/api/webhooks/google-ads/${urlToken}`, origin).toString();
}

function toAppError(error: unknown, message: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof GoogleOAuthError && error.code === "invalid_grant") {
    return new AppError("Google Ads access has expired or was removed. Connect Google again.", { status: 409, code: "GOOGLE_REAUTHORIZATION_REQUIRED" });
  }
  const retryable = error instanceof GoogleOAuthError ? error.retryable : true;
  return new AppError(message, { status: 502, code: "GOOGLE_REQUEST_FAILED", retryable });
}
