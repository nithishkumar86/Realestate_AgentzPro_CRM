import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { publishLeadRetrievalJob } from "@/lib/server/qstash-service";
import { AdNameResolutionService } from "@/lib/server/ad-name-resolution-service";

type RecoveryEvent = { id: string; tenant_id: string; dispatch_generation: string };

export class LeadRecoveryService {
  public async recover(): Promise<void> {
    const { data, error } = await getSupabaseAdminClient().rpc("recover_meta_webhook_notification_events");
    if (error) {
      throw new Error("Lead webhook recovery could not load pending events.");
    }

    const events = (data ?? []) as RecoveryEvent[];
    await Promise.all(events.map((event) => this.dispatch(event)));
    const { error: adRecoveryError } = await getSupabaseAdminClient().rpc("recover_meta_ad_name_resolutions");
    if (adRecoveryError) throw new Error("Ad-name recovery could not repair expired work.");
    await new AdNameResolutionService().resolveDue();
  }

  /** Releases leads held as pending_reconnect for these reconnected Pages back into the normal retrieval pipeline. */
  public async backfillReconnectedPages(tenantId: string, facebookPageIds: string[]): Promise<void> {
    const { data, error } = await getSupabaseAdminClient().rpc("release_pending_reconnect_meta_events", {
      p_tenant_id: tenantId,
      p_facebook_page_ids: facebookPageIds,
    });
    if (error) {
      throw new Error("Leads held for reconnection could not be released.");
    }

    const events = (data ?? []) as RecoveryEvent[];
    await Promise.all(events.map((event) => this.dispatch(event)));
  }

  private async dispatch(event: RecoveryEvent): Promise<void> {
    const eventId = event.id;
    try {
      await publishLeadRetrievalJob({ webhook_notification_event_id: eventId }, event.tenant_id);
      const { error } = await getSupabaseAdminClient().rpc("mark_meta_webhook_event_dispatched", {
        p_event_id: eventId,
        p_dispatch_generation: event.dispatch_generation,
      });
      if (error) {
        throw new Error("Lead webhook recovery dispatch could not be recorded.");
      }
    } catch {
      console.error(JSON.stringify({ operation: "lead_webhook_recovery", eventId, code: "QUEUE_DISPATCH_FAILED" }));
    }
  }
}
