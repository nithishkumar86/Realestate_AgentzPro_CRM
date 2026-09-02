import "server-only";

import { AppError } from "@/lib/server/app-error";
import { getServerEnvironment } from "@/lib/server/env";

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
    const environment = getServerEnvironment();
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
    const environment = getServerEnvironment();
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

  private async request<T>(path: string, query: Record<string, string>): Promise<T> {
    return this.requestUrl<T>(this.buildUrl(path, query));
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const environment = getServerEnvironment();
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
