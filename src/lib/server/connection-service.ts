import "server-only";

import { AppError } from "@/lib/server/app-error";
import { LeadRecoveryService } from "@/lib/server/lead-recovery-service";
import { MetaClient, MetaGraphRequestError, type EligibleMetaPage, type VerifiedPageToken } from "@/lib/server/meta-client";
import { assertMetaRateLimit } from "@/lib/server/meta-rate-limit";
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
  /** Empty when the Page can be connected; otherwise the Page access this integration still needs. */
  missingTasks: string[];
};

type ConnectionRow = {
  id: string;
  meta_user_id: string;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  user_token_status: string;
  user_token_expires_at: string | null;
  data_access_expires_at: string | null;
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
    await assertMetaRateLimit("connection_start", tenantId);
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
    await assertMetaRateLimit("pages_list", tenantId);
    return this.getEligiblePagesForConnection(tenantId, connectionId);
  }

  public async connectSelectedPages(connectionId: string, facebookPageIds: string[]): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    await assertMetaRateLimit("pages_connect", tenantId);
    if (facebookPageIds.length === 0) {
      throw new AppError("At least one Facebook Page must be selected.", { status: 422, code: "META_PAGE_SELECTION_INVALID" });
    }
    const sourcePages = await this.getSourcePages(tenantId, connectionId);
    const sourcePagesById = new Map(sourcePages.map((page) => [page.facebookPageId, page]));
    const selectedPages = [...new Set(facebookPageIds)].map((facebookPageId) => {
      const sourcePage = sourcePagesById.get(facebookPageId);
      if (!sourcePage) {
        throw new AppError("One or more selected Facebook Pages are no longer available.", {
          status: 422,
          code: "META_PAGE_SELECTION_INVALID",
        });
      }
      // Refuse before anything reaches Meta. Subscribing needs CREATE_CONTENT, MANAGE or MODERATE on the
      // Page; a Page held with only ADVERTISE used to pass selection and then fail mid-batch, rolling back
      // every other Page in the same request. Naming the Page here turns that into a fixable message.
      if (sourcePage.missingTasks.length > 0) {
        throw new AppError("Your Facebook access to this Page is not sufficient to receive leads.", {
          status: 422,
          code: "META_PAGE_TASKS_INSUFFICIENT",
          details: { facebookPageName: sourcePage.facebookPageName, missingTasks: sourcePage.missingTasks },
        });
      }
      return sourcePage;
    });

    // Token verification runs before anything is subscribed, so a failure here needs no rollback.
    // Bounded concurrency rather than one-at-a-time: 100 Pages used to mean 300 strictly sequential Graph
    // round trips, which at a realistic ~200ms each exceeds the platform's function timeout and fails the
    // whole connect on duration alone. The limit stays small because these calls all count against one
    // shared app-level Graph quota — the fix for slowness must not become the cause of throttling.
    const verifiedTokens = await mapWithConcurrency(selectedPages, META_CALL_CONCURRENCY, (sourcePage) =>
      this.metaClient.validatePageToken(sourcePage.facebookPageId, sourcePage.pageAccessToken),
    );
    try {
      throwFirstRejection(verifiedTokens);
    } catch (verificationError) {
      // A revoked User token fails here too, before any subscribe runs. No rollback is needed, but the
      // connection still has to be flagged and the user still has to be told to re-authorize.
      throw await this.asConnectionFacingError(verificationError, tenantId, connectionId);
    }

    const persistencePayload = selectedPages.map((sourcePage, index) => {
      const verifiedToken = (verifiedTokens[index] as PromiseFulfilledResult<VerifiedPageToken>).value;
      return {
        facebook_page_id: sourcePage.facebookPageId,
        facebook_page_name: sourcePage.facebookPageName,
        assigned_tasks: sourcePage.assignedTasks,
        page_access_token_encrypted: encryptToken(sourcePage.pageAccessToken),
        token_expires_at: verifiedToken.tokenExpiresAt,
        last_verified_at: verifiedToken.lastVerifiedAt,
      };
    });
    // Any Page that already holds a live record — this tenant's or another's — was already subscribed at
    // Meta before this request ran. A rollback must never touch those: unsubscribing one would silently
    // stop lead delivery for a connection this request did not create. Only Pages subscribed for the first
    // time here are safe to undo.
    const alreadyConnectedPageIds = await this.getAlreadyConnectedPageIds(selectedPages.map((page) => page.facebookPageId));

    const rollbackPageIds: string[] = [];
    try {
      // mapWithConcurrency settles EVERY task before returning, even after one has failed. That is load
      // bearing, not incidental: if the first rejection propagated immediately, the rollback below would
      // run while other subscribe calls were still in flight, and any that landed afterwards would be
      // orphaned at Meta with no local record and no second chance to undo them.
      const subscriptions = await mapWithConcurrency(selectedPages, META_CALL_CONCURRENCY, async (sourcePage) => {
        await this.metaClient.subscribePageToLeadgen(sourcePage.facebookPageId, sourcePage.pageAccessToken);
        await this.metaClient.confirmPageLeadgenSubscription(sourcePage.facebookPageId, sourcePage.pageAccessToken);
        if (!alreadyConnectedPageIds.has(sourcePage.facebookPageId)) {
          rollbackPageIds.push(sourcePage.facebookPageId);
        }
      });
      throwFirstRejection(subscriptions);

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
    } catch (connectError) {
      // Nothing is persisted until the RPC commits, so every Page this request subscribed at Meta before
      // the failure would otherwise be left as an orphaned subscription with no local record — Meta keeps
      // delivering leadgen events for a Page no tenant owns. This covers the RPC failing as well as the
      // subscribe calls: the P0001 ownership conflict is an ordinary outcome, not an edge case, and every
      // occurrence used to orphan a subscription on another tenant's Page. A rollback failure must not mask
      // the original error or stop the remaining rollbacks from running.
      for (const facebookPageId of rollbackPageIds) {
        try {
          await this.metaClient.unsubscribePageFromLeadgen(facebookPageId);
        } catch (rollbackError) {
          console.error(JSON.stringify({
            operation: "connect_selected_pages_rollback",
            code: "META_UNSUBSCRIBE_FAILED",
            facebookPageId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          }));
        }
      }
      throw await this.asConnectionFacingError(connectError, tenantId, connectionId);
    }

    // The Pages are saved, so a backfill failure must not fail the request; the recovery worker also releases held leads.
    try {
      await new LeadRecoveryService().backfillReconnectedPages(tenantId, selectedPages.map((page) => page.facebookPageId));
    } catch {
      console.error(JSON.stringify({ operation: "lead_reconnect_backfill", code: "BACKFILL_RELEASE_FAILED" }));
    }

    return this.getOverview();
  }

  public async getOverview(): Promise<SafeConnectionOverview> {
    const tenantId = await resolveTenantId();
    const supabase = getSupabaseAdminClient();
    const [{ data: connections, error: connectionError }, { data: pages, error: pageError }] = await Promise.all([
      supabase.from("meta_connections").select("id,connection_status,user_token_expires_at,data_access_expires_at").eq("tenant_id", tenantId).order("connected_at", { ascending: false }),
      supabase.from("facebook_pages").select("id,meta_connection_id,facebook_page_id,facebook_page_name,connection_status,connected_at").eq("tenant_id", tenantId).order("connected_at", { ascending: false }),
    ]);

    if (connectionError || pageError) {
      throw new AppError("Connection details could not be loaded.", { status: 500, code: "CONNECTION_LOAD_FAILED", retryable: true });
    }

    const typedConnections = (connections ?? []) as Array<Pick<ConnectionRow, "id" | "connection_status" | "user_token_expires_at" | "data_access_expires_at">>;
    const typedPages = (pages ?? []) as PageRow[];
    return {
      connectionStatus: getOverviewStatus(typedConnections.map(getEffectiveConnectionStatus)),
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
    await assertMetaRateLimit("disconnect", tenantId);
    const supabase = getSupabaseAdminClient();

    const { data: pageRow } = await supabase
      .from("facebook_pages")
      .select("facebook_page_id")
      .eq("id", pageRecordId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected")
      .maybeSingle();
    const facebookPageId = (pageRow as { facebook_page_id: string } | null)?.facebook_page_id;
    if (facebookPageId) {
      await this.unsubscribePage(facebookPageId);
    }

    const { data, error } = await supabase
      .from("facebook_pages")
      // The stored Page token is deleted, not just marked invalid; reconnecting stores a freshly verified one.
      .update({ connection_status: "disconnected", token_status: "invalid", page_access_token_encrypted: null, disconnected_at: new Date().toISOString() })
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
    await assertMetaRateLimit("disconnect", tenantId);
    const supabase = getSupabaseAdminClient();

    const { data: pageRows } = await supabase
      .from("facebook_pages")
      .select("facebook_page_id")
      .eq("meta_connection_id", connectionId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected");
    for (const row of (pageRows ?? []) as Array<{ facebook_page_id: string }>) {
      await this.unsubscribePage(row.facebook_page_id);
    }

    // Runs before the RPC, which clears the row's live status and token.
    await this.revokeAuthorizationIfLastConnection(tenantId, connectionId);

    const { error } = await supabase.rpc("disconnect_meta_connection", {
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

  /**
   * De-authorizes this app for the connection's Facebook user, so "Disconnect" genuinely uninstalls it
   * instead of leaving the app installed with live permissions on the person's Facebook account.
   *
   * Meta's Login best practices make this a policy obligation, not a courtesy: "Once people are logged in,
   * you should also give them a way to log out, disconnect their account, or delete it all together. In
   * addition to being a courtesy, this is also a requirement of our Developer Policies for Login."
   *
   * Guarded, because meta_connections is unique on (tenant_id, meta_user_id) — the same Facebook user can
   * legitimately be connected by two different tenants. DELETE /{user-id}/permissions invalidates EVERY
   * token for that person, so revoking while another tenant still holds a live connection would silently
   * break that tenant's lead delivery. Only the last live connection for a Facebook user revokes, and if
   * that cannot be proven the authorization is left in place.
   *
   * Like unsubscribePage, a failure is logged rather than thrown: a user-initiated disconnect must always
   * complete locally. A stranded authorization is recoverable; a half-finished disconnect that leaves live
   * tokens in our database is not.
   */
  private async revokeAuthorizationIfLastConnection(tenantId: string, connectionId: string): Promise<void> {
    const supabase = getSupabaseAdminClient();

    const { data: connectionRow, error: connectionError } = await supabase
      .from("meta_connections")
      .select("meta_user_id")
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected")
      .maybeSingle();

    const metaUserId = (connectionRow as { meta_user_id: string } | null)?.meta_user_id;
    if (connectionError || !metaUserId) {
      return;
    }

    const { data: otherConnections, error: otherConnectionError } = await supabase
      .from("meta_connections")
      .select("id")
      .eq("meta_user_id", metaUserId)
      .neq("id", connectionId)
      .neq("connection_status", "disconnected")
      .limit(1);

    if (otherConnectionError || (otherConnections ?? []).length > 0) {
      return;
    }

    try {
      await this.metaClient.revokeAppAuthorization(metaUserId);
    } catch (error) {
      console.error(JSON.stringify({
        operation: "disconnect_meta_connection_revoke",
        code: "META_REVOKE_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // A user-initiated disconnect must always succeed locally even if Meta's side has a hiccup; the failure
  // is logged so it can be caught/retried by monitoring instead of silently lost.
  private async unsubscribePage(facebookPageId: string): Promise<void> {
    try {
      await this.metaClient.unsubscribePageFromLeadgen(facebookPageId);
    } catch (error) {
      console.error(JSON.stringify({
        operation: "disconnect_facebook_page",
        code: "META_UNSUBSCRIBE_FAILED",
        facebookPageId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Facebook Page IDs, among the given set, that already hold a live local record — for any tenant.
   *
   * Deliberately not tenant-scoped: the question a rollback needs answered is "was this Page already
   * subscribed before this request", and a Page held by a different tenant must be left alone just as
   * firmly as one held by this one.
   *
   * Fails closed. If this cannot be determined the connect is refused before anything is subscribed,
   * because a subscription that cannot be rolled back is worse than a retryable failure.
   */
  private async getAlreadyConnectedPageIds(facebookPageIds: string[]): Promise<Set<string>> {
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .select("facebook_page_id")
      .in("facebook_page_id", facebookPageIds)
      .neq("connection_status", "disconnected");

    if (error || !data) {
      throw new AppError("Facebook Page connection state could not be verified.", {
        status: 503,
        code: "PAGE_STATE_UNAVAILABLE",
        retryable: true,
      });
    }

    return new Set((data as Array<{ facebook_page_id: string }>).map((row) => row.facebook_page_id));
  }

  /**
   * Turns a Graph authorization failure into the one thing the user can act on: re-authorize.
   *
   * MetaGraphRequestError already computes requiresReauthorization from the documented codes — 190 (token
   * invalid, which is also what Facebook returns once someone removes the app from their Facebook
   * settings), 102, 10, and 200-299 — and the lead pipeline consumes it. This path did not. Everything
   * here surfaced as a flat 400 "Facebook rejected the request.", while the connection row stayed 'active'
   * and the UI kept showing a healthy connection with no reconnect prompt. The person's only route back
   * was to guess that disconnecting and reconnecting would help.
   *
   * Writing the row is what makes this stick. Deriving the status at read time cannot detect a revoked
   * token — revocation changes nothing about the stored expiry timestamps — so a connection killed at
   * Facebook's end looks perfectly healthy until something tries to use it.
   *
   * A failure to write the flag is logged, never thrown: the caller is already handling an error, and
   * replacing it with a database error would lose the only diagnosis we have.
   */
  private async asConnectionFacingError(error: unknown, tenantId: string, connectionId: string): Promise<unknown> {
    if (!(error instanceof MetaGraphRequestError) || !error.requiresReauthorization) {
      return error;
    }

    const { error: updateError } = await getSupabaseAdminClient()
      .from("meta_connections")
      .update({
        connection_status: "reauthorization_required",
        user_token_status: "reauthorization_required",
        last_verified_at: new Date().toISOString(),
      })
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected");

    if (updateError) {
      console.error(JSON.stringify({
        operation: "meta_connection_flag_reauthorization",
        code: "CONNECTION_FLAG_FAILED",
        graphErrorCode: error.graphErrorCode,
      }));
    }

    return new AppError("Facebook authorization has expired or been revoked. Reconnect Facebook to continue.", {
      status: 403,
      code: "META_REAUTHORIZATION_REQUIRED",
    });
  }

  private async getEligiblePagesForConnection(tenantId: string, connectionId: string): Promise<SafeEligiblePage[]> {
    const sourcePages = await this.getSourcePages(tenantId, connectionId);
    return sourcePages.map(toSafeEligiblePage);
  }

  private async getSourcePages(tenantId: string, connectionId: string): Promise<EligibleMetaPage[]> {
    const { data, error } = await getSupabaseAdminClient()
      .from("meta_connections")
      .select("id,meta_user_id,connection_status,user_token_status,user_token_expires_at,data_access_expires_at,long_lived_user_access_token_encrypted")
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .neq("connection_status", "disconnected")
      .single();
    const connection = data as ConnectionRow | null;

    if (error || !connection) {
      throw new AppError("Facebook connection was not found.", { status: 404, code: "CONNECTION_NOT_FOUND" });
    }
    if (getEffectiveConnectionStatus(connection) === "reauthorization_required" || connection.user_token_status !== "active") {
      throw new AppError("Facebook authorization is required before Pages can be loaded.", {
        status: 403,
        code: "META_REAUTHORIZATION_REQUIRED",
      });
    }

    try {
      return await this.metaClient.getEligiblePages(decryptToken(connection.long_lived_user_access_token_encrypted));
    } catch (error) {
      // Listing Pages is the first call made with the stored token after connect, so a token revoked at
      // Facebook's end surfaces here first. Flag it and say so rather than reporting a generic rejection.
      throw await this.asConnectionFacingError(error, tenantId, connectionId);
    }
  }
}

/**
 * Graph calls in flight at once during a connect.
 *
 * Deliberately small. The point is to stop 100 Pages from serializing into a request that outlives the
 * function timeout, not to go as fast as possible: every one of these calls is charged to the same
 * app-level Graph quota that all tenants share, and a wide burst is precisely what triggers the Business
 * Use Case throttling that then blocks everyone.
 */
const META_CALL_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` in flight, resolving in input order.
 *
 * Always settles every task, even after one rejects — the caller decides what to do about failures, and
 * for the connect path that decision (rolling back subscriptions) is only safe once nothing is still in
 * flight. Returning settled results rather than throwing is what makes that guarantee available.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

/** Rethrows the first failure in input order, so the error a caller sees does not depend on timing. */
function throwFirstRejection(results: ReadonlyArray<PromiseSettledResult<unknown>>): void {
  const rejection = results.find((result) => result.status === "rejected");
  if (rejection) {
    throw (rejection as PromiseRejectedResult).reason;
  }
}

function toSafeEligiblePage(page: EligibleMetaPage): SafeEligiblePage {
  return {
    facebookPageId: page.facebookPageId,
    facebookPageName: page.facebookPageName,
    assignedTasks: page.assignedTasks,
    pageIdLastFour: page.facebookPageId.slice(-4),
    missingTasks: page.missingTasks,
  };
}

/**
 * Derived at read time rather than written back, so the row is never stale and no background job is needed.
 *
 * Data access runs on a second, independent clock from token expiry. Per
 * https://developers.facebook.com/documentation/facebook-login/auth-vs-data: "The expiration period for
 * data access is 90 days, based on when the user was last active. When this 90-day period expires, the
 * user can still access your app — that is, they are still authenticated — but your app can't access
 * their data. To regain data access, your app must ask the user to re-authorize your app's permissions."
 *
 * That page lists the permissions which never expire, and `leads_retrieval` is NOT among them. So once
 * data access lapses, lead retrieval stops even though the User token itself is still valid and
 * unexpired. Reading only user_token_expires_at left the connection showing a green "Active" badge while
 * it had silently stopped delivering leads — the single worst failure mode for a lead CRM.
 */
function getEffectiveConnectionStatus(
  connection: Pick<ConnectionRow, "connection_status" | "user_token_expires_at" | "data_access_expires_at">,
): ConnectionRow["connection_status"] {
  if (connection.connection_status !== "active") {
    return connection.connection_status;
  }
  return hasElapsed(connection.user_token_expires_at) || hasElapsed(connection.data_access_expires_at)
    ? "reauthorization_required"
    : "active";
}

function hasElapsed(timestamp: string | null): boolean {
  if (timestamp == null) {
    return false;
  }
  const elapsedAt = new Date(timestamp).getTime();
  // An unparseable timestamp yields NaN; treat it as "not elapsed" rather than locking a working
  // connection out of the CRM over a bad column value.
  return Number.isFinite(elapsedAt) && elapsedAt <= Date.now();
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
