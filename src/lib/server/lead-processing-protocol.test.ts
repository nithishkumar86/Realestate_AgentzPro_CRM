import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeadRetrievalService } from "@/lib/server/lead-retrieval-service";
import { LeadRecoveryService } from "@/lib/server/lead-recovery-service";
import { LeadWebhookService } from "@/lib/server/lead-webhook-service";
import { MetaClient, MetaGraphRequestError } from "@/lib/server/meta-client";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), publish: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => mocks }));
vi.mock("@/lib/server/qstash-service", () => ({ publishLeadRetrievalJob: mocks.publish }));
vi.mock("@/lib/server/token-crypto", () => ({ decryptToken: mocks.decrypt }));
const event = { id: "event", claim_token: "attempt-b", tenant_id: "tenant", facebook_page_record_id: "page-row",
  facebook_page_id: "page", leadgen_id: "lead", form_id: "form", ad_id: null,
  lead_created_time: "2026-09-08T00:00:00.000Z", retrieval_attempt_count: 2 };
const page = { id: "page-row", tenant_id: "tenant", facebook_page_id: "page", page_access_token_encrypted: "cipher",
  connection_status: "active", token_status: "active", connection_generation: "generation-a" };
function query(data: unknown) {
  const builder = { select: vi.fn(), eq: vi.fn(), neq: vi.fn(), lte: vi.fn(), upsert: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) };
  for (const method of [builder.select, builder.eq, builder.neq, builder.lte, builder.upsert]) method.mockReturnValue(builder);
  return builder;
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks();
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "claim_meta_webhook_notification_event" ? event : true, error: null }));
  mocks.from.mockReturnValue(query(page)); mocks.decrypt.mockReturnValue("token-a");
});
describe("lead processing RPC protocol", () => {
  it("completes with the claim token and retrieved ad fallback", async () => {
    vi.spyOn(MetaClient.prototype, "retrieveLead").mockResolvedValue({ id: "lead", form_id: "form", ad_id: "ad", created_time: event.lead_created_time, field_data: [], rawPayload: {} });
    await new LeadRetrievalService().process("event");
    expect(mocks.rpc).toHaveBeenCalledWith("complete_meta_lead_retrieval_event", expect.objectContaining({ p_event_id: "event", p_claim_token: "attempt-b", p_ad_id: "ad" }));
  });
  it("records the generation of the token actually used when Meta rejects it", async () => {
    vi.spyOn(MetaClient.prototype, "retrieveLead").mockRejectedValue(new MetaGraphRequestError({ status: 400, graphError: { type: "OAuthException", code: 190 } }));
    await new LeadRetrievalService().process("event");
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_lead_retrieval_retry", expect.objectContaining({ p_claim_token: "attempt-b", p_connection_generation: "generation-a", p_requires_reauthorization: true, p_next_retrieval_attempt_at: expect.any(String) }));
  });
  it("flags the connection for reauthorization before calling Meta when the stored Page token has expired", async () => {
    mocks.from.mockReturnValue(query({ ...page, token_expires_at: "2020-01-01T00:00:00.000Z" }));
    const retrieve = vi.spyOn(MetaClient.prototype, "retrieveLead");
    await new LeadRetrievalService().process("event");
    expect(retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_lead_retrieval_retry", expect.objectContaining({ p_connection_generation: "generation-a", p_requires_reauthorization: true, p_error_code: "META_REAUTHORIZATION_REQUIRED" }));
  });
  it.each([
    [false, true, "META_REAUTHORIZATION_REQUIRED"],
    [true, false, "META_LEAD_NOT_AVAILABLE"],
  ])("confirms GraphMethodException 100/33 against the token (lead access %s -> reauthorization %s)", async (hasAccess, requiresReauthorization, errorCode) => {
    vi.spyOn(MetaClient.prototype, "retrieveLead").mockRejectedValue(new MetaGraphRequestError({ status: 400, graphError: { type: "GraphMethodException", code: 100, error_subcode: 33 } }));
    vi.spyOn(MetaClient.prototype, "hasPageLeadAccess").mockResolvedValue(hasAccess);
    await new LeadRetrievalService().process("event");
    expect(MetaClient.prototype.hasPageLeadAccess).toHaveBeenCalledWith("page", "token-a");
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_lead_retrieval_retry", expect.objectContaining({ p_connection_generation: "generation-a", p_requires_reauthorization: requiresReauthorization, p_error_code: errorCode, p_force_dead_letter: true }));
  });
  it("retries instead of pausing the Page when the 100/33 token check itself fails", async () => {
    vi.spyOn(MetaClient.prototype, "retrieveLead").mockRejectedValue(new MetaGraphRequestError({ status: 400, graphError: { type: "GraphMethodException", code: 100, error_subcode: 33 } }));
    vi.spyOn(MetaClient.prototype, "hasPageLeadAccess").mockRejectedValue(new Error("network"));
    await new LeadRetrievalService().process("event");
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_lead_retrieval_retry", expect.objectContaining({ p_requires_reauthorization: false, p_force_dead_letter: false, p_error_code: "META_TEMPORARY_FAILURE" }));
  });
  it("does not invalidate a token when the Page is already disconnected", async () => {
    mocks.from.mockReturnValue(query({ ...page, connection_status: "disconnected" }));
    const retrieve = vi.spyOn(MetaClient.prototype, "retrieveLead");
    await new LeadRetrievalService().process("event");
    expect(retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_lead_retrieval_retry", expect.objectContaining({ p_connection_generation: null, p_claim_token: "attempt-b" }));
  });
  it("treats rejected stale completion as a harmless no-op", async () => {
    vi.spyOn(MetaClient.prototype, "retrieveLead").mockResolvedValue({ id: "lead", form_id: "form", created_time: event.lead_created_time, field_data: [], rawPayload: {} });
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "claim_meta_webhook_notification_event" ? event : false, error: null }));
    await new LeadRetrievalService().process("event");
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["claim_meta_webhook_notification_event", "complete_meta_lead_retrieval_event"]);
  });
  it("acknowledges recovery using the generation read before publishing", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: "event", tenant_id: "tenant", dispatch_generation: "dispatch-a" }], error: null });
    await new LeadRecoveryService().recover();
    expect(mocks.publish).toHaveBeenCalledWith({ webhook_notification_event_id: "event" }, "tenant");
    expect(mocks.rpc).toHaveBeenCalledWith("mark_meta_webhook_event_dispatched", { p_event_id: "event", p_dispatch_generation: "dispatch-a" });
  });
  describe("leads arriving while a Page awaits reconnection", () => {
    const webhook = JSON.stringify({ object: "page", entry: [{ id: "page", time: 1788825600, changes: [{ field: "leadgen", value: { leadgen_id: "lead", page_id: "page", form_id: "form", created_time: 1788825600 } }] }] });
    const heldRpc = async (name: string) => ({
      data: name === "release_pending_reconnect_meta_events" ? [{ id: "event", tenant_id: "tenant", dispatch_generation: "dispatch-released" }]
        : name === "claim_meta_webhook_notification_event" ? event : true,
      error: null,
    });

    it.each([
      { connection_status: "reauthorization_required", token_status: "reauthorization_required" },
      { connection_status: "active", token_status: "expired" },
    ])("saves the lead as pending_reconnect instead of dropping it for an inactive Page %j", async (status) => {
      const events = query({ id: "event", dispatch_generation: "dispatch-held" });
      mocks.from.mockImplementation((table: string) => table === "facebook_pages" ? query({ ...page, ...status }) : events);
      await new LeadWebhookService().ingest(webhook);
      expect(events.upsert).toHaveBeenCalledWith(expect.objectContaining({
        processing_status: "pending_reconnect", tenant_id: "tenant", leadgen_id: "lead", form_id: "form",
        facebook_page_id: "page", facebook_page_record_id: "page-row", raw_webhook_change: expect.objectContaining({ field: "leadgen" }),
      }), { onConflict: "leadgen_id", ignoreDuplicates: true });
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it("releases held leads when the Page reconnects and processes them through the normal pipeline", async () => {
      mocks.rpc.mockImplementation(heldRpc);
      await new LeadRecoveryService().backfillReconnectedPages("tenant", ["page"]);
      expect(mocks.rpc).toHaveBeenCalledWith("release_pending_reconnect_meta_events", { p_tenant_id: "tenant", p_facebook_page_ids: ["page"] });
      expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ webhook_notification_event_id: "event" }, "tenant");
      expect(mocks.rpc).toHaveBeenCalledWith("mark_meta_webhook_event_dispatched", { p_event_id: "event", p_dispatch_generation: "dispatch-released" });

      vi.spyOn(MetaClient.prototype, "retrieveLead").mockResolvedValue({ id: "lead", form_id: "form", created_time: event.lead_created_time, field_data: [], rawPayload: {} });
      await new LeadRetrievalService().process(mocks.publish.mock.calls[0][0].webhook_notification_event_id);
      expect(MetaClient.prototype.retrieveLead).toHaveBeenCalledWith("lead", "token-a");
      expect(mocks.rpc).toHaveBeenCalledWith("complete_meta_lead_retrieval_event", expect.objectContaining({ p_event_id: "event", p_claim_token: "attempt-b" }));
    });

    it("ignores the same leadgen_id re-delivered during backfill instead of storing or dispatching it twice", async () => {
      // ON CONFLICT (leadgen_id) DO NOTHING returns no row for a lead that is already held or released.
      const events = query(null);
      mocks.from.mockImplementation((table: string) => table === "facebook_pages" ? query(page) : events);
      await new LeadWebhookService().ingest(webhook);
      expect(events.upsert).toHaveBeenCalledWith(expect.objectContaining({ leadgen_id: "lead", processing_status: "pending" }), { onConflict: "leadgen_id", ignoreDuplicates: true });
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it("dispatches nothing when the reconnected Pages had no held leads", async () => {
      mocks.rpc.mockResolvedValue({ data: [], error: null });
      await new LeadRecoveryService().backfillReconnectedPages("tenant", ["page"]);
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it("reports a failed release so held leads are left for the recovery worker", async () => {
      mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
      await expect(new LeadRecoveryService().backfillReconnectedPages("tenant", ["page"])).rejects.toThrow("Leads held for reconnection could not be released.");
      expect(mocks.publish).not.toHaveBeenCalled();
    });
  });
  it("acknowledges initial dispatch using the inserted event generation", async () => {
    mocks.from.mockImplementation((table: string) => query(table === "facebook_pages" ? page : { id: "event", dispatch_generation: "dispatch-initial" }));
    await new LeadWebhookService().ingest(JSON.stringify({ object: "page", entry: [{ id: "page", time: 1788825600, changes: [{ field: "leadgen", value: { leadgen_id: "lead", page_id: "page", form_id: "form", created_time: 1788825600 } }] }] }));
    expect(mocks.rpc).toHaveBeenLastCalledWith("mark_meta_webhook_event_dispatched", { p_event_id: "event", p_dispatch_generation: "dispatch-initial" });
  });
});
