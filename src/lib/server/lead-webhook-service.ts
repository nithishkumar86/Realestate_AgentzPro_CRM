import "server-only";

import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { publishLeadRetrievalJob } from "@/lib/server/qstash-service";

const metaIdentifierSchema = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const unixTimestampSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((value, context) => {
  const timestamp = Number(value);
  const date = new Date(timestamp * 1000);
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(date.getTime())) {
    context.addIssue({ code: "custom", message: "Invalid Unix timestamp." });
    return z.NEVER;
  }
  return date.toISOString();
});

const leadgenChangeSchema = z.object({
  field: z.literal("leadgen"),
  value: z.object({
    leadgen_id: metaIdentifierSchema,
    page_id: metaIdentifierSchema,
    form_id: metaIdentifierSchema,
    adgroup_id: metaIdentifierSchema.optional(),
    ad_id: metaIdentifierSchema.optional(),
    created_time: unixTimestampSchema,
  }).passthrough(),
}).passthrough();

const entrySchema = z.object({
  id: metaIdentifierSchema,
  time: unixTimestampSchema,
  changes: z.array(z.object({ field: z.string(), value: z.unknown() }).passthrough()),
}).passthrough();

const metaWebhookSchema = z.object({
  object: z.literal("page"),
  entry: z.array(entrySchema),
}).passthrough();

type PageConnectionRow = {
  id: string;
  tenant_id: string;
  facebook_page_id: string;
  connection_status: "active" | "reauthorization_required" | "disconnected";
  token_status: "active" | "invalid" | "expired" | "reauthorization_required";
};

type NewWebhookEvent = {
  id: string;
  dispatch_generation: string;
};

type DispatchableEvent = NewWebhookEvent & { tenant_id: string };

export type ParsedMetaLeadWebhook = {
  changes: NormalizedLeadgenChange[];
  /**
   * leadgen changes whose value did not match Meta's documented shape. They are counted and skipped
   * rather than thrown, so one malformed change cannot discard the valid leads delivered beside it.
   */
  rejectedChangeCount: number;
};

type InitialEventStatus = "pending" | "pending_reconnect";

type NormalizedLeadgenChange = {
  metaEntryId: string;
  metaEntryTime: string;
  leadgenId: string;
  facebookPageId: string;
  formId: string;
  adgroupId: string | null;
  adId: string | null;
  leadCreatedTime: string;
  rawWebhookChange: Record<string, unknown>;
};

export function parseMetaLeadWebhook(rawBody: string): ParsedMetaLeadWebhook {
  const payload = metaWebhookSchema.parse(JSON.parse(rawBody));
  const normalizedChanges: NormalizedLeadgenChange[] = [];
  let rejectedChangeCount = 0;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "leadgen") {
        continue;
      }

      // Isolated per change: Meta batches several leads into one notification, and a single change we
      // cannot normalize must not discard its siblings or force the whole delivery to be rejected.
      const leadgenChange = leadgenChangeSchema.safeParse(change);
      if (!leadgenChange.success) {
        rejectedChangeCount += 1;
        continue;
      }

      normalizedChanges.push({
        metaEntryId: entry.id,
        metaEntryTime: entry.time,
        leadgenId: leadgenChange.data.value.leadgen_id,
        facebookPageId: leadgenChange.data.value.page_id,
        formId: leadgenChange.data.value.form_id,
        adgroupId: leadgenChange.data.value.adgroup_id ?? null,
        adId: leadgenChange.data.value.ad_id ?? null,
        leadCreatedTime: leadgenChange.data.value.created_time,
        rawWebhookChange: leadgenChange.data,
      });
    }
  }

  return { changes: normalizedChanges, rejectedChangeCount };
}

export class LeadWebhookService {
  public async ingest(rawBody: string): Promise<void> {
    const { changes, rejectedChangeCount } = parseMetaLeadWebhook(rawBody);
    if (rejectedChangeCount > 0) {
      console.error(JSON.stringify({ operation: "lead_webhook_ingestion", code: "LEADGEN_CHANGE_REJECTED", rejectedChangeCount }));
    }
    const newEvents: DispatchableEvent[] = [];

    for (const change of changes) {
      const pageConnection = await this.findPageConnection(change);
      if (!pageConnection) {
        this.logLeadRouting(change, "PAGE_CONNECTION_NOT_FOUND");
        continue;
      }

      // Held rather than dropped: release_pending_reconnect_meta_events sends it through the normal pipeline once the Page reconnects.
      const awaitingReconnect = pageConnection.connection_status !== "active" || pageConnection.token_status !== "active";
      const event = await this.insertEvent(pageConnection, change, awaitingReconnect ? "pending_reconnect" : "pending");
      if (awaitingReconnect) {
        this.logLeadRouting(change, "PAGE_AWAITING_RECONNECT");
        continue;
      }
      if (event) {
        newEvents.push({ ...event, tenant_id: pageConnection.tenant_id });
      }
    }

    await Promise.all(newEvents.map((event) => this.dispatchEvent(event)));
  }

  private async findPageConnection(change: NormalizedLeadgenChange): Promise<PageConnectionRow | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .select("id,tenant_id,facebook_page_id,connection_status,token_status")
      .eq("facebook_page_id", change.facebookPageId)
      .neq("connection_status", "disconnected")
      // lead_eligible_since, not connected_at: connected_at is rewritten on every reconnect, so using it
      // here silently discarded every lead created in the moments before a tenant reconnected the Page.
      // lead_eligible_since is stamped once when the tenant first claims the Page and survives reconnects,
      // so the "no backfill of leads from before this tenant owned the Page" guarantee is unchanged.
      .lte("lead_eligible_since", change.leadCreatedTime)
      .maybeSingle();

    if (error) {
      throw new Error("Facebook Page connection lookup failed.");
    }
    return (data as PageConnectionRow | null) ?? null;
  }

  private async insertEvent(pageConnection: PageConnectionRow, change: NormalizedLeadgenChange, status: InitialEventStatus): Promise<NewWebhookEvent | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from("meta_webhook_notification_events")
      .upsert({
        processing_status: status,
        tenant_id: pageConnection.tenant_id,
        facebook_page_record_id: pageConnection.id,
        facebook_page_id: change.facebookPageId,
        meta_entry_id: change.metaEntryId,
        meta_entry_time: change.metaEntryTime,
        leadgen_id: change.leadgenId,
        form_id: change.formId,
        adgroup_id: change.adgroupId,
        ad_id: change.adId,
        lead_created_time: change.leadCreatedTime,
        raw_webhook_change: change.rawWebhookChange,
      }, { onConflict: "leadgen_id", ignoreDuplicates: true })
      .select("id,dispatch_generation")
      .maybeSingle();

    if (error) {
      throw new Error("Webhook notification event could not be saved.");
    }
    return (data as NewWebhookEvent | null) ?? null;
  }

  private async dispatchEvent(event: DispatchableEvent): Promise<void> {
    const eventId = event.id;
    try {
      await publishLeadRetrievalJob({ webhook_notification_event_id: eventId }, event.tenant_id);
      const { error } = await getSupabaseAdminClient().rpc("mark_meta_webhook_event_dispatched", {
        p_event_id: eventId,
        p_dispatch_generation: event.dispatch_generation,
      });
      if (error) {
        throw new Error("Webhook notification event dispatch could not be recorded.");
      }
    } catch {
      console.error(JSON.stringify({ operation: "lead_webhook_dispatch", eventId, code: "QUEUE_DISPATCH_FAILED" }));
    }
  }

  private logLeadRouting(change: NormalizedLeadgenChange, code: string): void {
    console.warn(JSON.stringify({
      operation: "lead_webhook_routing",
      code,
      leadgenIdLastFour: change.leadgenId.slice(-4),
      facebookPageIdLastFour: change.facebookPageId.slice(-4),
    }));
  }
}
