import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { publishLeadRetrievalJob } from "@/lib/server/qstash-service";

type RecoveryEvent = { id: string };

export class LeadRecoveryService {
  public async recover(): Promise<void> {
    const { data, error } = await getSupabaseAdminClient().rpc("recover_meta_webhook_notification_events");
    if (error) {
      throw new Error("Lead webhook recovery could not load pending events.");
    }

    const events = (data ?? []) as RecoveryEvent[];
    await Promise.all(events.map((event) => this.dispatch(event.id)));
  }

  private async dispatch(eventId: string): Promise<void> {
    try {
      await publishLeadRetrievalJob({ webhook_notification_event_id: eventId });
      const { error } = await getSupabaseAdminClient().rpc("mark_meta_webhook_event_dispatched", { p_event_id: eventId });
      if (error) {
        throw new Error("Lead webhook recovery dispatch could not be recorded.");
      }
    } catch {
      console.error(JSON.stringify({ operation: "lead_webhook_recovery", eventId, code: "QUEUE_DISPATCH_FAILED" }));
    }
  }
}
