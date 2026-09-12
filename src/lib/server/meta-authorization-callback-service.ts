import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { getMetaEnv } from "@/lib/server/env";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Handles the two unauthenticated Facebook Login callbacks: de-authorization and data deletion.
 *
 * Both arrive with only an app-scoped Facebook user ID (proven by the signed_request signature, which the
 * route verifies before calling in here), so every operation is keyed on meta_user_id and deliberately
 * spans tenants: the person removed the app from their Facebook account, which invalidates that
 * authorization for every tenant holding it, not just one.
 */

export type DataDeletionReceipt = { confirmationCode: string; url: string };

export class MetaAuthorizationCallbackService {
  /** Disconnects every live connection for a Facebook user and scrubs stored tokens. Returns the count. */
  public async deauthorize(metaUserId: string): Promise<number> {
    const { data, error } = await getSupabaseAdminClient().rpc("deauthorize_meta_user", {
      p_meta_user_id: metaUserId,
    });

    if (error) {
      throw new AppError("Facebook de-authorization could not be recorded.", {
        status: 500,
        code: "META_DEAUTHORIZATION_FAILED",
        retryable: true,
      });
    }

    return typeof data === "number" ? data : 0;
  }

  /**
   * Records a data deletion request and performs the deletion of the Facebook-derived credentials this
   * app holds, then returns the confirmation code and status URL Meta requires in the response body.
   *
   * The deletion itself is the same de-authorization scrub: the data this app holds "from Facebook about
   * the user" is the stored User and Page access tokens and the connection records binding them. Lead
   * records belong to the tenant that owns the Page, not to the Facebook user who authorized the
   * connection, and are governed by the tenant's own retention - the status page states this so the
   * response to the person is truthful rather than implying more was deleted than was.
   */
  public async recordDataDeletionRequest(metaUserId: string): Promise<DataDeletionReceipt> {
    const connectionsDisconnected = await this.deauthorize(metaUserId);
    const confirmationCode = randomBytes(16).toString("hex");

    const { error } = await getSupabaseAdminClient()
      .from("meta_data_deletion_requests")
      .insert({
        confirmation_code: confirmationCode,
        meta_user_id: metaUserId,
        status: "completed",
        connections_disconnected: connectionsDisconnected,
        completed_at: new Date().toISOString(),
      });

    if (error) {
      throw new AppError("Data deletion request could not be recorded.", {
        status: 500,
        code: "META_DATA_DELETION_RECORD_FAILED",
        retryable: true,
      });
    }

    // The public origin is taken from the configured webhook callback URL, not from the incoming
    // request: behind a proxy or load balancer request.url carries the internal host, and this URL is
    // handed to Meta and shown to the person, so it has to be externally reachable.
    return {
      confirmationCode,
      url: `${new URL(getMetaEnv().META_WEBHOOK_CALLBACK_URL).origin}/meta/data-deletion?code=${confirmationCode}`,
    };
  }

  /** Looks up a deletion request for the public status page. Returns null for an unknown code. */
  public async findDataDeletionRequest(confirmationCode: string): Promise<{ status: string; requestedAt: string; completedAt: string | null } | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from("meta_data_deletion_requests")
      .select("status,requested_at,completed_at")
      .eq("confirmation_code", confirmationCode)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    const row = data as { status: string; requested_at: string; completed_at: string | null };
    return { status: row.status, requestedAt: row.requested_at, completedAt: row.completed_at };
  }
}
