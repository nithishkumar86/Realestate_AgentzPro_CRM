import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getMetaEnv } from "@/lib/server/env";

export const REQUIRED_META_PERMISSIONS = [
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_show_list",
  "ads_management",
  "leads_retrieval",
] as const;

const REQUIRED_PAGE_TASK = "ADVERTISE";
const GRAPH_BASE_URL = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 10_000;

type DebugTokenResponse = {
  data?: {
    app_id?: string;
    application?: string;
    data_access_expires_at?: number;
    expires_at?: number;
    is_valid?: boolean;
    scopes?: string[];
    user_id?: string;
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
type PageSubscriptionsResponse = { data?: Array<{ id?: string }> };

export type RetrievedMetaLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  form_id: string;
  field_data: unknown[];
  custom_disclaimer_responses?: unknown[];
  rawPayload: Record<string, unknown>;
};

export class MetaGraphRequestError extends AppError {
  public readonly graphErrorCode: number | null;
  public readonly graphErrorSubcode: number | null;
  public readonly requiresReauthorization: boolean;

  public constructor(input: { status: number; graphError?: GraphErrorPayload["error"] }) {
    const graphError = input.graphError;
    const retryable = input.status === 429 || input.status >= 500 || graphError?.is_transient === true;
    super(retryable ? "Facebook could not complete the request." : "Facebook rejected the request.", {
      status: retryable ? 502 : 400,
      code: retryable ? "META_TEMPORARY_FAILURE" : "META_REQUEST_REJECTED",
      retryable,
    });
    this.graphErrorCode = typeof graphError?.code === "number" ? graphError.code : null;
    this.graphErrorSubcode = typeof graphError?.error_subcode === "number" ? graphError.error_subcode : null;
    this.requiresReauthorization = graphError?.type === "OAuthException" && graphError.code === 190;
  }
}

export type ValidatedMetaToken = {
  metaUserId: string;
  grantedPermissions: string[];
  userTokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
};

export type EligibleMetaPage = {
  facebookPageId: string;
  facebookPageName: string;
  assignedTasks: string[];
  pageAccessToken: string;
};

export class MetaClient {
  public async validateUserToken(inputToken: string): Promise<ValidatedMetaToken> {
    const environment = getMetaEnv();
    const response = await this.request<DebugTokenResponse>("/debug_token", {
      input_token: inputToken,
      access_token: `${environment.META_APP_ID}|${environment.META_APP_SECRET}`,
    });
    const token = response.data;

    if (!token?.is_valid || token.app_id !== environment.META_APP_ID || !token.user_id) {
      throw new AppError("Facebook authorization could not be verified.", { status: 401, code: "META_TOKEN_INVALID" });
    }

    const grantedPermissions = token.scopes ?? [];
    const missingPermissions = REQUIRED_META_PERMISSIONS.filter((permission) => !grantedPermissions.includes(permission));
    if (missingPermissions.length > 0) {
      throw new AppError("Required Facebook permissions were not granted.", { status: 403, code: "META_PERMISSION_DENIED" });
    }

    return {
      metaUserId: token.user_id,
      grantedPermissions,
      userTokenExpiresAt: toTimestamp(token.expires_at),
      dataAccessExpiresAt: toTimestamp(token.data_access_expires_at),
    };
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
      limit: "100",
    });

    while (nextUrl) {
      const response: PagesResponse = await this.requestUrl<PagesResponse>(nextUrl);
      for (const page of response.data ?? []) {
        if (!page.id || !page.name || !page.access_token || !page.tasks?.includes(REQUIRED_PAGE_TASK)) {
          continue;
        }

        pages.push({
          facebookPageId: page.id,
          facebookPageName: page.name,
          assignedTasks: page.tasks,
          pageAccessToken: page.access_token,
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

  public async confirmPageLeadgenSubscription(facebookPageId: string, pageAccessToken: string): Promise<void> {
    const environment = getMetaEnv();
    const response = await this.requestWithBearer<PageSubscriptionsResponse>(`/${facebookPageId}/subscribed_apps`, pageAccessToken, {
      method: "GET",
    });
    const appIsSubscribed = (response.data ?? []).some((subscription) => subscription.id === environment.META_APP_ID);

    if (!appIsSubscribed) {
      throw new AppError("Facebook Page lead delivery could not be confirmed.", {
        status: 502,
        code: "META_PAGE_SUBSCRIPTION_UNCONFIRMED",
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
      throw new AppError("Facebook returned an invalid lead response.", {
        status: 502,
        code: "META_LEAD_RESPONSE_INVALID",
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

  private async requestUrl<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === 2) {
            throw new AppError("Facebook could not complete the request.", {
              status: retryable ? 502 : 400,
              code: retryable ? "META_TEMPORARY_FAILURE" : "META_REQUEST_REJECTED",
              retryable,
            });
          }
          await waitForRetry(response, attempt);
          continue;
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof AppError || attempt === 2) {
          throw error instanceof AppError ? error : new AppError("Facebook could not complete the request.", {
            status: 502,
            code: "META_TEMPORARY_FAILURE",
            retryable: true,
          });
        }
        await waitForRetry(undefined, attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new AppError("Facebook could not complete the request.", {
      status: 502,
      code: "META_TEMPORARY_FAILURE",
      retryable: true,
    });
  }

  private async requestWithBearer<T>(path: string, accessToken: string, options: { method: "GET" | "POST"; body?: URLSearchParams; query?: Record<string, string> }): Promise<T> {
    const environment = getMetaEnv();
    const url = new URL(`${GRAPH_BASE_URL}/${environment.META_GRAPH_API_VERSION}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(options.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: options.body,
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as GraphErrorPayload;
        throw new MetaGraphRequestError({ status: response.status, graphError: payload.error });
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new MetaGraphRequestError({ status: 503 });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toTimestamp(unixSeconds: number | undefined): string | null {
  return unixSeconds && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null;
}

function toExpiryTimestamp(expiresIn: number | undefined): string | null {
  return expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
}

async function waitForRetry(response: Response | undefined, attempt: number): Promise<void> {
  const retryAfter = response?.headers.get("retry-after");
  const headerDelay = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : Number.NaN;
  const delay = Number.isFinite(headerDelay) ? Math.min(headerDelay, 10_000) : 250 * 2 ** attempt;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
