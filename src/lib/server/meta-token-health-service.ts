import "server-only";

import { AppError } from "@/lib/server/app-error";
import { MetaClient } from "@/lib/server/meta-client";
import { decryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Scheduled re-validation of every live Meta connection.
 *
 * Meta's Facebook Login best practices are explicit that this is mandatory for a server-to-server
 * integration like this one: "If you don't use the Facebook SDKs in your app, it is extremely important
 * that you manually implement frequent checks of the token validity - at least daily - to ensure that your
 * app is not relying on a token that has expired early for security reasons."
 * (https://developers.facebook.com/docs/facebook-login/best-practices/)
 *
 * Without this, user_token_status was written 'active' at connect and 'invalid' at disconnect and never
 * moved again, so a token revoked at Facebook - or a data-access window that lapsed - was only ever
 * discovered passively, by leads failing to arrive.
 *
 * Two rules govern every write here:
 *
 *  - Only a DEFINITIVE verdict from Meta changes a connection. A transient Graph failure (429, 5xx,
 *    throttling, network) leaves the row exactly as it was; flipping a healthy tenant to
 *    "reauthorization required" because Meta had a bad minute would be its own outage.
 *  - The check is self-healing. A connection previously flagged that now inspects clean is restored to
 *    active, so a tenant who re-authorizes is not stuck behind a stale flag.
 */

const DEFAULT_BATCH_SIZE = 200;

type ConnectionHealthRow = {
  id: string;
  tenant_id: string;
  connection_status: string;
  user_token_status: string;
  long_lived_user_access_token_encrypted: string | null;
};

export type TokenHealthSummary = {
  checked: number;
  healthy: number;
  flagged: number;
  /** Connections left untouched because the verdict was inconclusive (transient Graph or crypto failure). */
  indeterminate: number;
};

export class MetaTokenHealthService {
  private readonly metaClient = new MetaClient();

  public async revalidateActiveConnections(batchSize: number = DEFAULT_BATCH_SIZE): Promise<TokenHealthSummary> {
    const supabase = getSupabaseAdminClient();

    // Least-recently-verified first, so a batch cap still gives every connection a turn.
    const { data, error } = await supabase
      .from("meta_connections")
      .select("id,tenant_id,connection_status,user_token_status,long_lived_user_access_token_encrypted")
      .neq("connection_status", "disconnected")
      .order("last_verified_at", { ascending: true, nullsFirst: true })
      .limit(batchSize);

    if (error) {
      throw new AppError("Meta connections could not be loaded for revalidation.", {
        status: 503,
        code: "TOKEN_HEALTH_LOAD_FAILED",
        retryable: true,
      });
    }

    const summary: TokenHealthSummary = { checked: 0, healthy: 0, flagged: 0, indeterminate: 0 };

    for (const connection of (data ?? []) as ConnectionHealthRow[]) {
      summary.checked += 1;
      const outcome = await this.revalidateConnection(connection);
      summary[outcome] += 1;
    }

    return summary;
  }

  private async revalidateConnection(connection: ConnectionHealthRow): Promise<"healthy" | "flagged" | "indeterminate"> {
    if (!connection.long_lived_user_access_token_encrypted) {
      // A live connection with no token violates meta_connections_token_present_check. Flag rather than
      // ignore: it cannot serve leads, and leaving it "active" is exactly the silent failure being fixed.
      await this.flag(connection, "invalid", "MISSING_TOKEN");
      return "flagged";
    }

    let inspected;
    try {
      inspected = await this.metaClient.inspectUserToken(decryptToken(connection.long_lived_user_access_token_encrypted));
    } catch (error) {
      // Includes MetaGraphRequestError for 429/5xx/throttling and any decryption failure. Not a verdict
      // about the token, so nothing is written.
      console.error(JSON.stringify({
        operation: "meta_token_health",
        code: "TOKEN_INSPECTION_INDETERMINATE",
        connectionId: connection.id,
        tenantId: connection.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return "indeterminate";
    }

    if (inspected.status === "invalid") {
      await this.flag(connection, "invalid", "TOKEN_INVALID");
      return "flagged";
    }

    if (inspected.status === "reauthorization_required") {
      await this.flag(connection, "reauthorization_required", "PERMISSIONS_REVOKED", {
        user_token_expires_at: inspected.userTokenExpiresAt,
        data_access_expires_at: inspected.dataAccessExpiresAt,
        granted_permissions: inspected.grantedPermissions,
      });
      return "flagged";
    }

    // The token itself is good. Data access is a separate clock: per Meta's auth-vs-data guide it lapses
    // 90 days after the person was last active, and leads_retrieval is not on that page's list of
    // never-expiring permissions. Once it lapses, retrieval stops while debug_token still reports a valid
    // token - so this is checked independently of the token verdict. ConnectionService derives the same
    // condition at read time for the UI; writing it here is what makes the stored row usable by the lead
    // pipeline, which reads connection_status directly.
    const dataAccessLapsed = inspected.dataAccessExpiresAt !== null
      && new Date(inspected.dataAccessExpiresAt).getTime() <= Date.now();

    if (dataAccessLapsed) {
      await this.flag(connection, "reauthorization_required", "DATA_ACCESS_EXPIRED", {
        user_token_expires_at: inspected.userTokenExpiresAt,
        data_access_expires_at: inspected.dataAccessExpiresAt,
        granted_permissions: inspected.grantedPermissions,
      });
      return "flagged";
    }

    await getSupabaseAdminClient()
      .from("meta_connections")
      .update({
        // Self-healing: a connection flagged on an earlier run that now inspects clean returns to active.
        connection_status: "active",
        user_token_status: "active",
        user_token_expires_at: inspected.userTokenExpiresAt,
        data_access_expires_at: inspected.dataAccessExpiresAt,
        granted_permissions: inspected.grantedPermissions,
        last_verified_at: new Date().toISOString(),
        disconnected_at: null,
      })
      .eq("id", connection.id)
      .neq("connection_status", "disconnected");

    return "healthy";
  }

  private async flag(
    connection: ConnectionHealthRow,
    userTokenStatus: "invalid" | "reauthorization_required",
    reason: string,
    extraColumns: Record<string, unknown> = {},
  ): Promise<void> {
    console.error(JSON.stringify({
      operation: "meta_token_health",
      code: "CONNECTION_FLAGGED",
      reason,
      connectionId: connection.id,
      tenantId: connection.tenant_id,
    }));

    await getSupabaseAdminClient()
      .from("meta_connections")
      .update({
        connection_status: "reauthorization_required",
        user_token_status: userTokenStatus,
        last_verified_at: new Date().toISOString(),
        ...extraColumns,
      })
      .eq("id", connection.id)
      .neq("connection_status", "disconnected");
  }
}
