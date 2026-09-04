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
};

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

export function parseMetaLeadWebhook(rawBody: string): NormalizedLeadgenChange[] {
  const payload = metaWebhookSchema.parse(JSON.parse(rawBody));
  const normalizedChanges: NormalizedLeadgenChange[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "leadgen") {
        continue;
      }

      const leadgenChange = leadgenChangeSchema.parse(change);
      normalizedChanges.push({
        metaEntryId: entry.id,
        metaEntryTime: entry.time,
        leadgenId: leadgenChange.value.leadgen_id,
        facebookPageId: leadgenChange.value.page_id,
        formId: leadgenChange.value.form_id,
        adgroupId: leadgenChange.value.adgroup_id ?? null,
        adId: leadgenChange.value.ad_id ?? null,
        leadCreatedTime: leadgenChange.value.created_time,
        rawWebhookChange: leadgenChange,
      });
    }
  }

  return normalizedChanges;
}

export class LeadWebhookService {
  public async ingest(rawBody: string): Promise<void> {
    const changes = parseMetaLeadWebhook(rawBody);
    const newEventIds: string[] = [];

    for (const change of changes) {
      const pageConnection = await this.findPageConnection(change);
      if (!pageConnection) {
        this.logUnroutableLead(change, "PAGE_CONNECTION_NOT_FOUND");
        continue;
      }
      if (pageConnection.connection_status !== "active" || pageConnection.token_status !== "active") {
        this.logUnroutableLead(change, "PAGE_CONNECTION_NOT_READY");
        continue;
      }

      const eventId = await this.insertEvent(pageConnection, change);
      if (eventId) {
        newEventIds.push(eventId);
      }
    }

    await Promise.all(newEventIds.map((eventId) => this.dispatchEvent(eventId)));
  }

  private async findPageConnection(change: NormalizedLeadgenChange): Promise<PageConnectionRow | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from("facebook_pages")
      .select("id,tenant_id,facebook_page_id,connection_status,token_status")
      .eq("facebook_page_id", change.facebookPageId)
      .neq("connection_status", "disconnected")
      .lte("connected_at", change.leadCreatedTime)
      .maybeSingle();

    if (error) {
      throw new Error("Facebook Page connection lookup failed.");
    }
    return (data as PageConnectionRow | null) ?? null;
  }

  private async insertEvent(pageConnection: PageConnectionRow, change: NormalizedLeadgenChange): Promise<string | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from("meta_webhook_notification_events")
      .upsert({
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
      .select("id")
      .maybeSingle();

    if (error) {
      throw new Error("Webhook notification event could not be saved.");
    }
    return (data as NewWebhookEvent | null)?.id ?? null;
  }

  private async dispatchEvent(eventId: string): Promise<void> {
    try {
      await publishLeadRetrievalJob({ webhook_notification_event_id: eventId });
      const { error } = await getSupabaseAdminClient().rpc("mark_meta_webhook_event_dispatched", { p_event_id: eventId });
      if (error) {
        throw new Error("Webhook notification event dispatch could not be recorded.");
      }
    } catch {
      console.error(JSON.stringify({ operation: "lead_webhook_dispatch", eventId, code: "QUEUE_DISPATCH_FAILED" }));
    }
  }

  private logUnroutableLead(change: NormalizedLeadgenChange, code: string): void {
    console.warn(JSON.stringify({
      operation: "lead_webhook_routing",
      code,
      leadgenIdLastFour: change.leadgenId.slice(-4),
      facebookPageIdLastFour: change.facebookPageId.slice(-4),
    }));
  }
}
