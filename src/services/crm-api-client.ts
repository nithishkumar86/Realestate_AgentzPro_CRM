import type { ConnectionOverview, EligibleFacebookPage } from "@/lib/types";

type ApiErrorPayload = { error?: { message?: string; code?: string; details?: Record<string, unknown> } };

/**
 * Carries the server's machine-readable error code and details alongside the message, so callers can
 * branch on the failure instead of matching on prose. Needed so the connection page can recognise
 * META_PERMISSION_DENIED and re-request exactly the Facebook permissions that were declined.
 */
export class ApiError extends Error {
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;

  public constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init?.headers } });
  const payload = (await response.json().catch(() => null)) as T | ApiErrorPayload | null;
  if (!response.ok) {
    const apiError = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(apiError?.message ?? "The request could not be completed.", apiError?.code, apiError?.details);
  }
  return payload as T;
}

export async function getConnectionOverview(): Promise<ConnectionOverview> { return request<ConnectionOverview>("/api/meta/connection"); }
export async function startMetaConnection(shortLivedUserAccessToken: string): Promise<{ connectionId: string; pages: EligibleFacebookPage[] }> { return request("/api/meta/connections", { method: "POST", body: JSON.stringify({ short_lived_user_access_token: shortLivedUserAccessToken }) }); }
export async function connectSelectedPages(connectionId: string, facebookPageIds: string[]): Promise<ConnectionOverview> { return request("/api/meta/pages/connect", { method: "POST", body: JSON.stringify({ connection_id: connectionId, facebook_page_ids: facebookPageIds }) }); }
export async function disconnectFacebookPage(pageRecordId: string): Promise<ConnectionOverview> { return request("/api/meta/pages/disconnect", { method: "POST", body: JSON.stringify({ page_record_id: pageRecordId }) }); }
export async function disconnectMetaConnection(connectionId: string): Promise<ConnectionOverview> { return request("/api/meta/disconnect", { method: "POST", body: JSON.stringify({ connection_id: connectionId }) }); }

export type GoogleAdsOverview = {
  canManage: boolean;
  connection: { email: string; connectedAt: string } | null;
  needsReconnect: boolean;
  linkedAccounts: Array<{ customerId: string; name: string | null }>;
  /** lastLeadAt / lastTestAt count only deliveries made with the current key. campaigns: see getGoogleAdsOverview. */
  webhook: { url: string; key: string; lastLeadAt: string | null; lastTestAt: string | null; campaigns: Array<{ id: string; name: string }> | null } | null;
  hasWebhook: boolean;
  webhookStopped: boolean;
};
export type GoogleAdsAccountOption = { customerId: string; name: string | null; loginCustomerId: string | null; selected: boolean };

/**
 * campaigns: true (Connection card only) also lists the campaigns Google has delivered leads from with the current
 * key; without it webhook.campaigns is null, so /leads and the dashboard do no extra read.
 */
export async function getGoogleAdsOverview(options: { campaigns?: boolean } = {}): Promise<GoogleAdsOverview> { return request<GoogleAdsOverview>(options.campaigns ? "/api/integrations/google?campaigns=1" : "/api/integrations/google"); }
export async function createGoogleAdsWebhook(): Promise<{ url: string; key: string }> { return request("/api/integrations/google/webhook", { method: "POST", body: "{}" }); }
export async function getGoogleAdsAccountOptions(): Promise<{ accounts: GoogleAdsAccountOption[] }> { return request("/api/integrations/google/accounts"); }
export async function saveGoogleAdsAccounts(customerIds: string[]): Promise<{ saved: boolean }> { return request("/api/integrations/google/accounts", { method: "POST", body: JSON.stringify({ customerIds }) }); }
export async function disconnectGoogleAds(): Promise<{ disconnected: boolean }> { return request("/api/integrations/google/disconnect", { method: "POST", body: "{}" }); }
export async function stopGoogleAdsWebhook(): Promise<{ stopped: boolean }> { return request("/api/integrations/google/webhook", { method: "DELETE" }); }

export type CustomWebhookOverview = {
  canManage: boolean;
  hasWebhook: boolean;
  webhookStopped: boolean;
  /** Owner only, and only with details: true (the Connection card). lastLeadAt counts only leads sent to the current URL. */
  webhook: { url: string; lastLeadAt: string | null } | null;
};

/** details: true (Connection card only) adds the owner's webhook URL; /leads and the dashboard never ask for it. */
export async function getCustomWebhookOverview(options: { details?: boolean } = {}): Promise<CustomWebhookOverview> { return request<CustomWebhookOverview>(options.details ? "/api/integrations/custom-webhook?details=1" : "/api/integrations/custom-webhook"); }
export async function createCustomWebhook(): Promise<{ url: string }> { return request("/api/integrations/custom-webhook", { method: "POST", body: "{}" }); }
export async function stopCustomWebhook(): Promise<{ stopped: boolean }> { return request("/api/integrations/custom-webhook", { method: "DELETE" }); }
