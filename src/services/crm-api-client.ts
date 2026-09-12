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
