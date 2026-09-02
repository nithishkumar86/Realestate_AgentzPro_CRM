import "server-only";

import { AppError } from "@/lib/server/app-error";
import { MetaClient, type EligibleMetaPage } from "@/lib/server/meta-client";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { resolveTenantId } from "@/lib/server/tenant-context";

export type SafeConnectionPage = {
  id: string;
  pageName: string;
  category: null;
  pageIdLastFour: string;
  status: "active" | "reauthorization_required" | "disconnected";
  lastConnectedAt: string;
  connectionId: string;
};

export type SafeConnectionOverview = {
  connectionStatus: "active" | "reauthorization_required" | "disconnected" | "not_connected";
  pages: SafeConnectionPage[];
};

export type SafeEligiblePage = {
  facebookPageId: string;
  facebookPageName: string;
  assignedTasks: string[];
  pageIdLastFour: string;
};

type ConnectionRow = {
  id: string;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  user_token_status: string;
  long_lived_user_access_token_encrypted: string;
};

type PageRow = {
  id: string;
  meta_connection_id: string;
  facebook_page_id: string;
  facebook_page_name: string;
  connection_status: SafeConnectionPage["status"];
  connected_at: string;
};

export class ConnectionService {
  private readonly metaClient = new MetaClient();

  public async startConnection(shortLivedUserAccessToken: string): Promise<{ connectionId: string; pages: SafeEligiblePage[] }> {
    const tenantId = await resolveTenantId();
    const shortLivedToken = await this.metaClient.validateUserToken(shortLivedUserAccessToken);
    const exchangedToken = await this.metaClient.exchangeForLongLivedToken(shortLivedUserAccessToken);
    const longLivedToken = await this.metaClient.validateUserToken(exchangedToken.accessToken);
    const encryptedToken = encryptToken(exchangedToken.accessToken);
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
      .from("meta_connections")
      .upsert(
        {
          tenant_id: tenantId,
          meta_user_id: longLivedToken.metaUserId,
          granted_permissions: longLivedToken.grantedPermissions,
          long_lived_user_access_token_encrypted: encryptedToken,
          user_token_expires_at: exchangedToken.expiresAt ?? longLivedToken.userTokenExpiresAt,
          data_access_expires_at: longLivedToken.dataAccessExpiresAt,
          user_token_status: "active",
          connection_status: "active",
          connected_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
          disconnected_at: null,
        },
        { onConflict: "tenant_id,meta_user_id" },
      )
      .select("id")
      .single();

    if (error || !data) {
      throw new AppError("Facebook connection could not be saved.", { status: 500, code: "CONNECTION_SAVE_FAILED", retryable: true });
    }

    // Validate the original authorization before writing, even though the exchanged token is authoritative for storage.
    void shortLivedToken;
    const pages = await this.getEligiblePagesForConnection(tenantId, data.id);
    return { connectionId: data.id, pages };
  }

  public async getEligiblePages(connectionId: string): Promise<SafeEligiblePage[]> {
    const tenantId = await resolveTenantId();
    return this.getEligiblePagesForConnection(tenantId, connectionId);
  }

  public async connectSelectedPages(connectionId: string, facebookPageIds: string[]): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    const eligiblePages = await this.getEligiblePagesForConnection(tenantId, connectionId);
    const eligiblePagesById = new Map(eligiblePages.map((page) => [page.facebookPageId, page]));
    const selectedPages = facebookPageIds.map((facebookPageId) => eligiblePagesById.get(facebookPageId));

    if (selectedPages.some((page) => !page)) {
      throw new AppError("One or more selected Facebook Pages are no longer available.", {
        status: 422,
        code: "META_PAGE_SELECTION_INVALID",
      });
    }

    const sourcePages = await this.getSourcePages(tenantId, connectionId);
    const sourcePagesById = new Map(sourcePages.map((page) => [page.facebookPageId, page]));
    const persistencePayload = facebookPageIds.map((facebookPageId) => {
      const sourcePage = sourcePagesById.get(facebookPageId);
      if (!sourcePage) {
        throw new AppError("One or more selected Facebook Pages are no longer available.", {
          status: 422,
          code: "META_PAGE_SELECTION_INVALID",
        });
      }
      return {
        facebook_page_id: sourcePage.facebookPageId,
        facebook_page_name: sourcePage.facebookPageName,
        assigned_tasks: sourcePage.assignedTasks,
        page_access_token_encrypted: encryptToken(sourcePage.pageAccessToken),
      };
    });

    const { error } = await getSupabaseAdminClient().rpc("connect_selected_facebook_pages", {
      p_tenant_id: tenantId,
      p_connection_id: connectionId,
      p_pages: persistencePayload,
    });
    if (error) {
      if (error.code === "P0001") {
        throw new AppError("This Facebook Page is already connected to another CRM account.", {
          status: 409,
          code: "FACEBOOK_PAGE_OWNERSHIP_CONFLICT",
        });
      }
      throw new AppError("Selected Facebook Pages could not be saved.", {
        status: 500,
        code: "PAGE_SAVE_FAILED",
        retryable: true,
      });
    }

    return this.getOverview();
  }

  public async getOverview(): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    const supabase = getSupabaseAdminClient();
    const [{ data: connections, error: connectionError }, { data: pages, error: pageError }] = await Promise.all([
      supabase.from("meta_connections").select("id,connection_status").eq("tenant_id", tenantId).order("connected_at", { ascending: false }),
      supabase.from("facebook_pages").select("id,meta_connection_id,facebook_page_id,facebook_page_name,connection_status,connected_at").eq("tenant_id", tenantId).order("connected_at", { ascending: false }),
    ]);

    if (connectionError || pageError) {
      throw new AppError("Connection details could not be loaded.", { status: 500, code: "CONNECTION_LOAD_FAILED", retryable: true });
    }

    const typedConnections = (connections ?? []) as Array<Pick<ConnectionRow, "id" | "connection_status">>;
    const typedPages = (pages ?? []) as PageRow[];
    return {
      connectionStatus: getOverviewStatus(typedConnections.map((connection) => connection.connection_status)),
      pages: typedPages.map((page) => ({
        id: page.id,
        connectionId: page.meta_connection_id,
        pageName: page.facebook_page_name,
        category: null,
        pageIdLastFour: page.facebook_page_id.slice(-4),
        status: page.connection_status,
        lastConnectedAt: page.connected_at,
      })),
    };
  }

  public async disconnectPage(pageRecordId: string): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .update({ connection_status: "disconnected", token_status: "invalid", disconnected_at: new Date().toISOString() })
      .eq("id", pageRecordId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected")
      .select("id")
      .maybeSingle();

    if (error) {
      throw new AppError("Facebook Page could not be disconnected.", { status: 500, code: "PAGE_DISCONNECT_FAILED", retryable: true });
    }
    if (!data) {
      throw new AppError("Facebook Page was not found.", { status: 404, code: "FACEBOOK_PAGE_NOT_FOUND" });
    }
    return this.getOverview();
  }

  public async disconnectConnection(connectionId: string): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    const { error } = await getSupabaseAdminClient().rpc("disconnect_meta_connection", {
      p_tenant_id: tenantId,
      p_connection_id: connectionId,
    });
    if (error) {
      if (error.code === "P0002") {
        throw new AppError("Facebook connection was not found.", { status: 404, code: "CONNECTION_NOT_FOUND" });
      }
      throw new AppError("Facebook connection could not be disconnected.", { status: 500, code: "CONNECTION_DISCONNECT_FAILED", retryable: true });
    }
    return this.getOverview();
  }

  private async getEligiblePagesForConnection(tenantId: string, connectionId: string): Promise<SafeEligiblePage[]> {
    const sourcePages = await this.getSourcePages(tenantId, connectionId);
    return sourcePages.map(toSafeEligiblePage);
  }

  private async getSourcePages(tenantId: string, connectionId: string): Promise<EligibleMetaPage[]> {
    const { data, error } = await getSupabaseAdminClient()
      .from("meta_connections")
      .select("id,connection_status,user_token_status,long_lived_user_access_token_encrypted")
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected")
      .single();
    const connection = data as ConnectionRow | null;

    if (error || !connection) {
      throw new AppError("Facebook connection was not found.", { status: 404, code: "CONNECTION_NOT_FOUND" });
    }
    if (connection.connection_status === "reauthorization_required" || connection.user_token_status !== "active") {
      throw new AppError("Facebook authorization is required before Pages can be loaded.", {
        status: 403,
        code: "META_REAUTHORIZATION_REQUIRED",
      });
    }

    return this.metaClient.getEligiblePages(decryptToken(connection.long_lived_user_access_token_encrypted));
  }
}

function toSafeEligiblePage(page: EligibleMetaPage): SafeEligiblePage {
  return {
    facebookPageId: page.facebookPageId,
    facebookPageName: page.facebookPageName,
    assignedTasks: page.assignedTasks,
    pageIdLastFour: page.facebookPageId.slice(-4),
  };
}

function getOverviewStatus(statuses: Array<SafeConnectionOverview["connectionStatus"]>): SafeConnectionOverview["connectionStatus"] {
  if (statuses.includes("reauthorization_required")) {
    return "reauthorization_required";
  }
  if (statuses.includes("active")) {
    return "active";
  }
  if (statuses.includes("disconnected")) {
    return "disconnected";
  }
  return "not_connected";
}
