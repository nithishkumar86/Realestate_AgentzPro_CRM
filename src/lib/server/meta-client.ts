import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getMetaEnv } from "@/lib/server/env";

// Meta's lead retrieval guide requires pages_manage_ads for all lead and ad-level data,
// and pages_manage_metadata for the leadgen webhook subscription:
// https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
export const REQUIRED_META_PERMISSIONS = [
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_ads",
  "pages_show_list",
  "ads_management",
  "leads_retrieval",
] as const;

// Throttling codes from https://developers.facebook.com/docs/graph-api/guides/error-handling
// and https://developers.facebook.com/docs/graph-api/overview/rate-limiting (Page, hourly, and Business Use Case
// limits). Verified against Meta's live docs on 2026-09-11: 4, 17, 32, 341, and 613 are the documented
// application/page-level throttling codes.
const THROTTLING_ERROR_CODES = new Set([4, 17, 32, 341, 613]);

// Business Use Case throttling codes, also verified against the two docs above on 2026-09-11.
// 80000-80006, 80008, 80009, and 80014 are Meta-documented BUC throttle codes. 80007 and 80010-80013 are
// NOT documented by Meta but fall inside this range check; they're included deliberately rather than
// carved out, since it's safer to over-retry an unconfirmed-but-throttling-shaped error than to under-retry
// and surface a spurious failure to the tenant. Keep the range as 80000-80014 as-is.
function isThrottlingError(code: number | undefined): boolean {
  return typeof code === "number" && (THROTTLING_ERROR_CODES.has(code) || (code >= 80000 && code <= 80014));
}

// 190 (token invalid, including app removed), 102 (session), 10, and 200-299 (permission missing or revoked).
// Confirmed against https://developers.facebook.com/docs/graph-api/guides/error-handling as of 2026-09-11.
function isAuthorizationError(code: number | undefined): boolean {
  return code === 190 || code === 102 || code === 10 || (typeof code === "number" && code >= 200 && code <= 299);
}

// A Page needs BOTH gates, because this integration makes two different kinds of call against it.
//
// 1. Lead and ad-level retrieval needs the token to belong to someone who can advertise on the Page
//    (https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving).
// 2. Subscribing the app to the Page's `leadgen` webhook — and reading that subscription back to confirm
//    it — needs one of CREATE_CONTENT, MANAGE or MODERATE. Verbatim from
//    https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/, for both the POST
//    and the GET: "A Page access token requested by a person who can perform CREATE_CONTENT, MANAGE, or
//    MODERATE task on the Page".
//
// ADVERTISE is NOT in that second list. Gating on ADVERTISE alone let a Page through eligibility and then
// failed at subscribePageToLeadgen — which, because the connect is all-or-nothing, tore down the
// subscriptions of every other Page in the same batch.
const REQUIRED_ADS_PAGE_TASK = "ADVERTISE";
const WEBHOOK_SUBSCRIPTION_PAGE_TASKS = ["MANAGE", "CREATE_CONTENT", "MODERATE"] as const;

/** Page tasks this integration requires that the given Page is missing; empty when the Page is usable. */
export function getMissingPageTasks(assignedTasks: readonly string[]): string[] {
  const missing: string[] = [];
  if (!assignedTasks.includes(REQUIRED_ADS_PAGE_TASK)) {
    missing.push(REQUIRED_ADS_PAGE_TASK);
  }
  if (!WEBHOOK_SUBSCRIPTION_PAGE_TASKS.some((task) => assignedTasks.includes(task))) {
    missing.push(WEBHOOK_SUBSCRIPTION_PAGE_TASKS.join(" or "));
  }
  return missing;
}

const GRAPH_BASE_URL = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 10_000;

const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 300;

/**
 * The longest this process will sleep inside a single request before giving up and handing the wait back
 * to the caller.
 *
 * Meta's rate-limiting doc reports Business Use Case throttling as `estimated_time_to_regain_access`, in
 * MINUTES. Sitting in a retry loop for that long is impossible inside an HTTP request and pointless inside
 * a worker — every attempt made while throttled is itself counted against the quota that is throttling us,
 * so retrying into a BUC block actively lengthens it. When the wait Meta asks for exceeds this budget the
 * request fails immediately, retryable, carrying retryAfterSeconds so the queue can reschedule it properly.
 */
const MAX_INLINE_RETRY_DELAY_MS = 4_000;

/**
 * Hard ceiling on `paging.next` hops for any one cursor walk.
 *
 * 100 rows per page, so this allows 5,000 Pages — far beyond a real Business portfolio — while making a
 * malformed or self-referential cursor terminate instead of looping until the platform timeout kills the
 * request with no diagnostic at all.
 */
const MAX_PAGINATED_REQUESTS = 50;
const PAGE_FETCH_LIMIT = "100";

/**
 * Seconds Meta is asking us to wait, from whichever of its throttle signals the response carries.
 *
 * - `retry-after` is the standard HTTP header and is already in seconds.
 * - `x-business-use-case-usage` reports `estimated_time_to_regain_access` in MINUTES, per
 *   https://developers.facebook.com/docs/graph-api/overview/rate-limiting — the largest value across
 *   every business and bucket in the header is the one that governs.
 * - `x-ad-account-usage` reports `reset_time_duration` in seconds.
 *
 * Returns null when the response carries no usable signal, in which case the caller falls back to
 * exponential backoff. Every value is parsed defensively: a malformed header must never produce NaN,
 * a negative delay, or an exception on an error path.
 */
function readRetryAfterSeconds(response: Response | undefined): number | null {
  if (!response) {
    return null;
  }

  const candidates: number[] = [];

  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    candidates.push(retryAfter);
  }

  const businessUsage = parseJsonHeader(response.headers.get("x-business-use-case-usage"));
  if (businessUsage && typeof businessUsage === "object") {
    for (const buckets of Object.values(businessUsage as Record<string, unknown>)) {
      for (const bucket of Array.isArray(buckets) ? buckets : []) {
        const minutes = (bucket as { estimated_time_to_regain_access?: unknown })?.estimated_time_to_regain_access;
        if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
          candidates.push(Math.ceil(minutes * 60));
        }
      }
    }
  }

  const adAccountUsage = parseJsonHeader(response.headers.get("x-ad-account-usage"));
  const resetSeconds = (adAccountUsage as { reset_time_duration?: unknown } | null)?.reset_time_duration;
  if (typeof resetSeconds === "number" && Number.isFinite(resetSeconds) && resetSeconds > 0) {
    candidates.push(Math.ceil(resetSeconds));
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function parseJsonHeader(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Exponential backoff with full jitter. Jitter matters here specifically because a connect subscribes
 * several Pages at once: without it, every one of those calls is throttled at the same instant and then
 * retries at the same instant, reproducing the burst that caused the throttle.
 */
function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_INLINE_RETRY_DELAY_MS);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

type DebugTokenResponse = {
  data?: {
    app_id?: string;
    application?: string;
    data_access_expires_at?: number;
    expires_at?: number;
    is_valid?: boolean;
    scopes?: string[];
    user_id?: string;
    profile_id?: string;
  };
};

type TokenExchangeResponse = { access_token?: string; expires_in?: number };
type PagesResponse = {
  data?: Array<{ id?: string; name?: string; access_token?: string; tasks?: string[] }>;
  paging?: { next?: string };
};

type GraphErrorPayload = {
  error?: {
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    message?: string;
    type?: string;
  };
};

type PageSubscriptionResponse = { success?: boolean };
type PageSubscriptionsResponse = {
  data?: Array<{ id?: string; subscribed_fields?: string[] }>;
  paging?: { next?: string };
};

export type RetrievedMetaLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  form_id: string;
  field_data: unknown[];
  custom_disclaimer_responses?: unknown[];
  rawPayload: Record<string, unknown>;
};

type RetrievedMetaAd = { id: string; name: string };

export class MetaGraphRequestError extends AppError {
  public readonly graphErrorCode: number | null;
  public readonly graphErrorSubcode: number | null;
  public readonly requiresReauthorization: boolean;
  /** GraphMethodException 100/33: the object is missing, or the token lacks permission to read it. */
  public readonly isObjectAccessDenied: boolean;
  /**
   * How long Meta asked us to wait, when it said so. Null when the response carried no throttle signal.
   * Surfaced so a queue can reschedule at the right time instead of retrying straight back into a block.
   */
  public readonly retryAfterSeconds: number | null;

  public constructor(input: { status: number; graphError?: GraphErrorPayload["error"]; retryAfterSeconds?: number | null }) {
    const graphError = input.graphError;
    const retryable = input.status === 429 || input.status >= 500 || graphError?.is_transient === true || isThrottlingError(graphError?.code);
    const retryAfterSeconds = input.retryAfterSeconds ?? null;
    super(retryable ? "Facebook could not complete the request." : "Facebook rejected the request.", {
      status: retryable ? 502 : 400,
      code: retryable ? "META_TEMPORARY_FAILURE" : "META_REQUEST_REJECTED",
      retryable,
      ...(retryable && retryAfterSeconds !== null ? { details: { retryAfterSeconds } } : {}),
    });
    this.retryAfterSeconds = retryAfterSeconds;
    this.graphErrorCode = typeof graphError?.code === "number" ? graphError.code : null;
    this.graphErrorSubcode = typeof graphError?.error_subcode === "number" ? graphError.error_subcode : null;
    this.requiresReauthorization = isAuthorizationError(graphError?.code);
    this.isObjectAccessDenied = graphError?.code === 100 && graphError.error_subcode === 33;
  }
}

export type ValidatedMetaToken = {
  metaUserId: string;
  grantedPermissions: string[];
  userTokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
};

/** Health verdict for a stored User access token. `invalid` covers revoked, expired, and wrong-app tokens. */
export type InspectedUserToken =
  | { status: "invalid" }
  | ({ status: "active" } & ValidatedMetaToken)
  | ({ status: "reauthorization_required"; missingPermissions: string[] } & ValidatedMetaToken);

export type EligibleMetaPage = {
  facebookPageId: string;
  facebookPageName: string;
  assignedTasks: string[];
  pageAccessToken: string;
  /**
   * Page tasks this integration needs that the signed-in person does not hold on this Page.
   * Empty means the Page can be connected. A Page is reported rather than dropped so the UI can say
   * which access is missing — silently omitting it looks identical to the Page not existing.
   */
  missingTasks: string[];
};

export type VerifiedPageToken = {
  tokenExpiresAt: string | null;
  lastVerifiedAt: string;
};

export class MetaClient {
  public async validatePageToken(facebookPageId: string, pageAccessToken: string): Promise<VerifiedPageToken> {
    const environment = getMetaEnv();
    // Meta documents profile_id as the Page represented by an impersonated token:
    // https://developers.facebook.com/docs/graph-api/reference/debug_token/
    const response = await this.request<DebugTokenResponse>("/debug_token", {
      input_token: pageAccessToken,
      access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
    });
    const token = response.data;
    if (token?.is_valid !== true || token.app_id !== environment.META_APP_ID || token.profile_id !== facebookPageId) {
      throw new AppError("Facebook Page authorization could not be verified.", { status: 401, code: "META_PAGE_TOKEN_INVALID" });
    }

    // Missing expiry is not proof of a token without scheduled expiration.
    // Long-lived Page tokens obtained from long-lived User tokens are documented at:
    // https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
    const tokenExpiresAt = verifiedPageExpiry(token.expires_at);
    if (token.data_access_expires_at !== undefined) {
      verifiedPageExpiry(token.data_access_expires_at);
    }
    return { tokenExpiresAt, lastVerifiedAt: new Date().toISOString() };
  }

  /** Confirms a stored Page token is still valid for this app and Page and still carries leads_retrieval. */
  public async hasPageLeadAccess(facebookPageId: string, pageAccessToken: string): Promise<boolean> {
    const environment = getMetaEnv();
    const response = await this.request<DebugTokenResponse>("/debug_token", {
      input_token: pageAccessToken,
      access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
    });
    const token = response.data;
    return token?.is_valid === true
      && token.app_id === environment.META_APP_ID
      && token.profile_id === facebookPageId
      && (token.scopes ?? []).includes("leads_retrieval");
  }

  /**
   * Inspects a User access token and reports its health without throwing for an unhealthy one.
   *
   * This is the shared read behind both the interactive connect path (validateUserToken, which turns an
   * unhealthy verdict into a typed AppError) and the scheduled health check, which must classify every
   * connection rather than abort on the first bad token.
   */
  public async inspectUserToken(inputToken: string): Promise<InspectedUserToken> {
    const environment = getMetaEnv();
    const response = await this.request<DebugTokenResponse>("/debug_token", {
      input_token: inputToken,
      access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
    });
    const token = response.data;

    if (token?.is_valid !== true || token.app_id !== environment.META_APP_ID || !token.user_id) {
      return { status: "invalid" };
    }

    const grantedPermissions = token.scopes ?? [];
    const missingPermissions = REQUIRED_META_PERMISSIONS.filter((permission) => !grantedPermissions.includes(permission));
    const inspected = {
      metaUserId: token.user_id,
      grantedPermissions,
      userTokenExpiresAt: toTimestamp(token.expires_at),
      dataAccessExpiresAt: toTimestamp(token.data_access_expires_at),
    };

    return missingPermissions.length > 0
      ? { status: "reauthorization_required", ...inspected, missingPermissions: [...missingPermissions] }
      : { status: "active", ...inspected };
  }

  public async validateUserToken(inputToken: string): Promise<ValidatedMetaToken> {
    const inspected = await this.inspectUserToken(inputToken);

    if (inspected.status === "invalid") {
      throw new AppError("Facebook authorization could not be verified.", { status: 401, code: "META_TOKEN_INVALID" });
    }

    if (inspected.status === "reauthorization_required") {
      // The declined permissions travel to the browser so it can re-ask for exactly those with
      // auth_type: 'rerequest'. Per Meta's manual-login-flow doc, "once someone has declined a permission,
      // the Login Dialog will not re-ask them for it unless you explicitly tell the dialog you're re-asking"
      // — so without this list a single declined checkbox is an unrecoverable dead end for the user.
      throw new AppError("Required Facebook permissions were not granted.", {
        status: 403,
        code: "META_PERMISSION_DENIED",
        details: { missingPermissions: inspected.missingPermissions },
      });
    }

    return {
      metaUserId: inspected.metaUserId,
      grantedPermissions: inspected.grantedPermissions,
      userTokenExpiresAt: inspected.userTokenExpiresAt,
      dataAccessExpiresAt: inspected.dataAccessExpiresAt,
    };
  }

  /**
   * Completely de-authorizes this app for a Facebook user.
   *
   * https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke/ —
   * "You can also let people completely de-authorize an app, or revoke authorization for login, by making
   * a call to this Graph API endpoint: DELETE /{user-id}/permissions. This request must be made with a
   * valid user access token or an app access token for the current app ... any user access token for the
   * person will be invalidated".
   *
   * Uses the app access token rather than the user's: by the time a disconnect runs the stored user token
   * may already have been revoked or expired, and the app token works in either case.
   */
  public async revokeAppAuthorization(metaUserId: string): Promise<void> {
    const environment = getMetaEnv();
    const response = await this.requestUrl<unknown>(
      this.buildUrl(`/${metaUserId}/permissions`, {
        access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
      }),
      { method: "DELETE" },
    );

    // The docs say this returns "a response of true"; Graph in practice answers {"success": true}.
    // Accept either rather than treat a successful revoke as a failure over a response-shape detail.
    const revoked = response === true
      || (typeof response === "object" && response !== null && (response as PageSubscriptionResponse).success === true);
    if (!revoked) {
      throw new AppError("Facebook authorization could not be revoked.", {
        status: 502,
        code: "META_REVOKE_FAILED",
        retryable: true,
      });
    }
  }

  public async exchangeForLongLivedToken(shortLivedToken: string): Promise<{ accessToken: string; expiresAt: string | null }> {
    const environment = getMetaEnv();
    const response = await this.request<TokenExchangeResponse>("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: environment.META_APP_ID,
      client_secret: environment.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    });

    if (!response.access_token) {
      throw new AppError("Facebook authorization could not be completed.", { status: 502, code: "META_TOKEN_EXCHANGE_FAILED", retryable: true });
    }

    return { accessToken: response.access_token, expiresAt: toExpiryTimestamp(response.expires_in) };
  }

  public async getEligiblePages(userAccessToken: string): Promise<EligibleMetaPage[]> {
    const pages: EligibleMetaPage[] = [];
    let nextUrl: string | undefined = this.buildUrl("/me/accounts", {
      fields: "id,name,access_token,tasks",
      access_token: userAccessToken,
      limit: PAGE_FETCH_LIMIT,
    });

    // Bounded. An unbounded `while (nextUrl)` trusts Meta to eventually stop paging; a cursor that repeats
    // itself turns this into an infinite loop that holds a serverless invocation until the platform kills
    // it, with no error anyone can act on. Failing loudly at the ceiling is the honest outcome — silently
    // truncating would hide the person's Page from the picker, which looks identical to it not existing.
    for (let request = 0; nextUrl; request += 1) {
      if (request >= MAX_PAGINATED_REQUESTS) {
        throw new AppError("This Facebook account has too many Pages to list.", {
          status: 502,
          code: "META_PAGE_LIST_TOO_LARGE",
        });
      }
      const response: PagesResponse = await this.requestUrl<PagesResponse>(nextUrl);
      for (const page of response.data ?? []) {
        if (!page.id || !page.name || !page.access_token) {
          continue;
        }

        const assignedTasks = page.tasks ?? [];
        pages.push({
          facebookPageId: page.id,
          facebookPageName: page.name,
          assignedTasks,
          pageAccessToken: page.access_token,
          missingTasks: getMissingPageTasks(assignedTasks),
        });
      }
      nextUrl = response.paging?.next;
    }

    return pages;
  }

  public async subscribePageToLeadgen(facebookPageId: string, pageAccessToken: string): Promise<void> {
    const response = await this.requestWithBearer<PageSubscriptionResponse>(`/${facebookPageId}/subscribed_apps`, pageAccessToken, {
      method: "POST",
      body: new URLSearchParams({ subscribed_fields: "leadgen" }),
    });

    if (response.success !== true) {
      throw new AppError("Facebook Page lead delivery could not be enabled.", {
        status: 502,
        code: "META_PAGE_SUBSCRIPTION_FAILED",
        retryable: true,
      });
    }
  }

  /**
   * Reads the Page's subscribed apps back and confirms this app is among them with the `leadgen` field.
   *
   * Paginated. `subscribed_apps` is an edge and Meta pages it like any other: a Page with many installed
   * apps returns this app on a later page, and reading only the first one reported "lead delivery could
   * not be confirmed" for a Page that was in fact subscribed correctly — which then rolled back a
   * perfectly good connect.
   */
  public async confirmPageLeadgenSubscription(facebookPageId: string, pageAccessToken: string): Promise<void> {
    const environment = getMetaEnv();
    let nextUrl: string | undefined = this.buildUrl(`/${facebookPageId}/subscribed_apps`, { limit: PAGE_FETCH_LIMIT });
    let appIsSubscribed = false;

    for (let request = 0; nextUrl && !appIsSubscribed; request += 1) {
      if (request >= MAX_PAGINATED_REQUESTS) {
        break;
      }
      const response: PageSubscriptionsResponse = await this.requestUrlWithBearer<PageSubscriptionsResponse>(
        nextUrl,
        pageAccessToken,
        { method: "GET" },
      );
      appIsSubscribed = (response.data ?? []).some(
        (subscription) =>
          subscription.id === environment.META_APP_ID &&
          subscription.subscribed_fields?.includes("leadgen") === true
      );
      nextUrl = response.paging?.next;
    }

    if (!appIsSubscribed) {
      throw new AppError("Facebook Page lead delivery could not be confirmed.", {
        status: 502,
        code: "META_PAGE_SUBSCRIPTION_UNCONFIRMED",
        retryable: true,
      });
    }
  }

  /**
   * Removes this app's leadgen subscription for a Page. Per Meta's docs
   * (https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps), this must be
   * authenticated with the app access token (APP_ID|APP_SECRET) rather than a Page access token: by the
   * time a disconnect runs the Page token may already be gone, and a Page token isn't the right
   * credential for removing the app's own subscription anyway.
   */
  public async unsubscribePageFromLeadgen(facebookPageId: string): Promise<void> {
    const environment = getMetaEnv();
    const response = await this.requestUrl<PageSubscriptionResponse>(
      this.buildUrl(`/${facebookPageId}/subscribed_apps`, {
        access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
      }),
      { method: "DELETE" },
    );

    if (response.success !== true) {
      throw new AppError("Facebook Page lead delivery could not be disabled.", {
        status: 502,
        code: "META_PAGE_UNSUBSCRIBE_FAILED",
        retryable: true,
      });
    }
  }

  public async retrieveLead(leadgenId: string, pageAccessToken: string): Promise<RetrievedMetaLead> {
    const rawPayload = await this.requestWithBearer<Record<string, unknown>>(`/${leadgenId}`, pageAccessToken, {
      method: "GET",
      query: { fields: "id,created_time,ad_id,form_id,field_data,custom_disclaimer_responses" },
    });

    if (
      typeof rawPayload.id !== "string"
      || typeof rawPayload.created_time !== "string"
      || typeof rawPayload.form_id !== "string"
      || !Array.isArray(rawPayload.field_data)
      || (rawPayload.ad_id !== undefined && typeof rawPayload.ad_id !== "string")
      || (rawPayload.custom_disclaimer_responses !== undefined && !Array.isArray(rawPayload.custom_disclaimer_responses))
    ) {
      // Retryable: a malformed Graph body is an upstream fault, and without this the lead was
      // dead-lettered permanently on the first attempt (AppError.retryable defaults to false).
      throw new AppError("Facebook returned an invalid lead response.", {
        status: 502,
        code: "META_LEAD_RESPONSE_INVALID",
        retryable: true,
      });
    }

    return {
      id: rawPayload.id,
      created_time: rawPayload.created_time,
      ad_id: rawPayload.ad_id as string | undefined,
      form_id: rawPayload.form_id,
      field_data: rawPayload.field_data,
      custom_disclaimer_responses: rawPayload.custom_disclaimer_responses as unknown[] | undefined,
      rawPayload,
    };
  }

  public async retrieveAdName(adId: string, userAccessToken: string): Promise<string> {
    const rawPayload = await this.requestWithBearer<Record<string, unknown>>(`/${adId}`, userAccessToken, {
      method: "GET",
      query: { fields: "id,name" },
    });
    const ad = rawPayload as Partial<RetrievedMetaAd>;
    if (ad.id !== adId || typeof ad.name !== "string" || !ad.name.trim()) {
      throw new AppError("Facebook returned an invalid advertisement response.", {
        status: 502,
        code: "META_AD_RESPONSE_INVALID",
      });
    }
    return ad.name.trim();
  }

  private async request<T>(path: string, query: Record<string, string>): Promise<T> {
    return this.requestUrl<T>(this.buildUrl(path, query));
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const environment = getMetaEnv();
    const url = new URL(`${GRAPH_BASE_URL}/${environment.META_GRAPH_API_VERSION}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /** App-token or query-token call. A network fault maps to 502: the failure is upstream of us. */
  private async requestUrl<T>(url: string, options?: { method: "GET" | "DELETE" }): Promise<T> {
    return this.fetchWithRetry<T>({ url, method: options?.method ?? "GET", networkFailureStatus: 502 });
  }

  private async requestWithBearer<T>(
    path: string,
    accessToken: string,
    options: { method: "GET" | "POST"; body?: URLSearchParams; query?: Record<string, string> },
  ): Promise<T> {
    const environment = getMetaEnv();
    const url = new URL(`${GRAPH_BASE_URL}/${environment.META_GRAPH_API_VERSION}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    return this.requestUrlWithBearer<T>(url.toString(), accessToken, { method: options.method, body: options.body });
  }

  /**
   * Bearer-authenticated call against an absolute URL, so a `paging.next` cursor can be followed with the
   * same credential. Graph omits the access token from cursor URLs when the token was sent as a header,
   * which is exactly why the header has to be re-sent rather than the cursor followed anonymously.
   */
  private async requestUrlWithBearer<T>(
    url: string,
    accessToken: string,
    options: { method: "GET" | "POST"; body?: URLSearchParams },
  ): Promise<T> {
    return this.fetchWithRetry<T>({
      url,
      method: options.method,
      accessToken,
      body: options.body,
      networkFailureStatus: 503,
    });
  }

  /**
   * The single retry loop behind every Graph call.
   *
   * Retries only what MetaGraphRequestError classifies as retryable (429, 5xx, is_transient, and the
   * documented throttling codes — which arrive as HTTP 400 and would otherwise look permanent), and stops
   * early when Meta names a wait longer than this process should spend sleeping. The final failure is
   * logged once, with the path only: the query string carries access tokens and must never be logged.
   */
  private async fetchWithRetry<T>(input: {
    url: string;
    method: "GET" | "POST" | "DELETE";
    accessToken?: string;
    body?: URLSearchParams;
    networkFailureStatus: number;
  }): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: {
            ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
            ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          body: input.body,
          signal: controller.signal,
          cache: "no-store",
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        const payload = (await response.json().catch(() => ({}))) as GraphErrorPayload;
        const retryAfterSeconds = readRetryAfterSeconds(response);
        const error = new MetaGraphRequestError({ status: response.status, graphError: payload.error, retryAfterSeconds });

        // Meta asked for longer than we are willing to sleep: stop now rather than spend the remaining
        // attempts on calls that are certain to fail and that each extend the throttle window.
        const waitExceedsBudget = retryAfterSeconds !== null && retryAfterSeconds * 1000 > MAX_INLINE_RETRY_DELAY_MS;
        if (!error.retryable || waitExceedsBudget || attempt === MAX_RETRY_ATTEMPTS - 1) {
          logGraphFailure(input.url, error, attempt + 1, waitExceedsBudget);
          throw error;
        }

        await delay(retryAfterSeconds !== null ? retryAfterSeconds * 1000 : backoffDelayMs(attempt));
      } catch (error) {
        lastError = error;
        if (error instanceof MetaGraphRequestError || attempt === MAX_RETRY_ATTEMPTS - 1) {
          const finalError = error instanceof MetaGraphRequestError
            ? error
            : new MetaGraphRequestError({ status: input.networkFailureStatus });
          if (!(error instanceof MetaGraphRequestError)) {
            logGraphFailure(input.url, finalError, attempt + 1, false, error);
          }
          throw finalError;
        }
        await delay(backoffDelayMs(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new MetaGraphRequestError({ status: input.networkFailureStatus });
  }
}

function toTimestamp(unixSeconds: number | undefined): string | null {
  return unixSeconds && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null;
}

function verifiedPageExpiry(unixSeconds: unknown): string | null {
  if (typeof unixSeconds !== "number" || !Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new AppError("Facebook Page token expiry could not be verified.", { status: 502, code: "META_PAGE_TOKEN_METADATA_INVALID" });
  }
  if (unixSeconds === 0) {
    return null;
  }
  const expiresAt = new Date(unixSeconds * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new AppError("Facebook Page token expiry could not be verified.", { status: 502, code: "META_PAGE_TOKEN_METADATA_INVALID" });
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError("Facebook Page authorization has expired.", { status: 401, code: "META_PAGE_TOKEN_EXPIRED" });
  }
  return expiresAt.toISOString();
}

function toExpiryTimestamp(expiresIn: number | undefined): string | null {
  return expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

/**
 * One structured line per Graph call that ultimately failed.
 *
 * Only the pathname is recorded. Graph URLs carry `access_token` in the query string — including the
 * app secret in `APP_ID|APP_SECRET` app tokens — so logging a full URL would write live credentials into
 * the log store. The Graph error code and subcode are the fields that actually identify a failure in
 * Meta's error reference, and without them a support ticket has nothing to work from.
 */
function logGraphFailure(
  url: string,
  error: MetaGraphRequestError,
  attempts: number,
  waitExceededBudget: boolean,
  cause?: unknown,
): void {
  let path = "unparseable";
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the placeholder: a log line must never be the thing that throws.
  }

  console.error(JSON.stringify({
    operation: "meta_graph_request",
    code: error.code,
    path,
    status: error.status,
    graphErrorCode: error.graphErrorCode,
    graphErrorSubcode: error.graphErrorSubcode,
    requiresReauthorization: error.requiresReauthorization,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
    attempts,
    waitExceededBudget,
    ...(cause ? { cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) } : {}),
  }));
}
