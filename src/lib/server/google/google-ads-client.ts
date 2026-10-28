import "server-only";

import { getGoogleEnv } from "@/lib/server/env";

// Google Ads API over REST, read-only: listAccessibleCustomers and GoogleAdsService.Search (GAQL SELECT).
// Nothing here can create or change anything in an advertiser's account.
//   https://developers.google.com/google-ads/api/docs/account-management/listing-accounts
//   https://developers.google.com/google-ads/api/rest/common/search
//   https://developers.google.com/google-ads/api/docs/concepts/call-structure (headers)
const API_HOST = "https://googleads.googleapis.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 5;

export class GoogleAdsApiError extends Error {
  public constructor(public readonly code: string, public readonly status: number, public readonly retryable: boolean) {
    super(`Google Ads API request failed: ${code}`);
    this.name = "GoogleAdsApiError";
  }
}

export type GaqlRow = Record<string, Record<string, unknown> | undefined>;

/** Customer ids (10 digits, no hyphens) the signed-in Google user can access directly. */
export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const body = await callApi(accessToken, null, "GET", "customers:listAccessibleCustomers");
  const names = Array.isArray(body.resourceNames) ? body.resourceNames : [];
  return names.flatMap((name) => {
    const id = typeof name === "string" ? /^customers\/(\d{10})$/.exec(name)?.[1] : undefined;
    return id ? [id] : [];
  });
}

/**
 * Runs a GAQL SELECT against one account. loginCustomerId is the manager account the account is reached
 * through, sent as login-customer-id; null when the user has direct access (the header then defaults to the
 * operating customer). Results are capped at MAX_PAGES pages of 10,000 rows.
 */
export async function searchGoogleAds(accessToken: string, customerId: string, loginCustomerId: string | null, query: string): Promise<GaqlRow[]> {
  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await callApi(accessToken, loginCustomerId, "POST", `customers/${customerId}/googleAds:search`, pageToken ? { query, pageToken } : { query });
    if (Array.isArray(body.results)) rows.push(...(body.results as GaqlRow[]));
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return rows;
}

async function callApi(accessToken: string, loginCustomerId: string | null, method: "GET" | "POST", path: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const environment = getGoogleEnv();
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "developer-token": environment.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  if (payload) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_HOST}/${environment.GOOGLE_ADS_API_VERSION}/${path}`, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new GoogleAdsApiError("GOOGLE_ADS_UNREACHABLE", 0, true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new GoogleAdsApiError(readErrorCode(body, response.status), response.status, response.status === 429 || response.status >= 500);
  }
  return body;
}

/** The first GoogleAdsFailure errorCode (e.g. "authorizationError:USER_PERMISSION_DENIED"), never a message. */
function readErrorCode(body: Record<string, unknown>, status: number): string {
  const error = body.error as { status?: unknown; details?: Array<{ errors?: Array<{ errorCode?: Record<string, unknown> }> }> } | undefined;
  const errorCode = error?.details?.[0]?.errors?.[0]?.errorCode;
  if (errorCode && typeof errorCode === "object") {
    const [type, value] = Object.entries(errorCode)[0] ?? [];
    if (type && typeof value === "string") return `${type}:${value}`.slice(0, 120);
  }
  return typeof error?.status === "string" ? error.status.slice(0, 120) : `HTTP_${status}`;
}

/** REST JSON returns int64 ids as strings; both shapes are accepted. */
export function readGaqlId(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^\d+$/.test(text) ? text : null;
}
