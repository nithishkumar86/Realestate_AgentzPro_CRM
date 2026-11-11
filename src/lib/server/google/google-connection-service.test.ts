// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => value.replace(/^enc:/, "") }));
vi.mock("@/lib/server/google/google-oauth", () => ({}));
vi.mock("@/lib/server/google/google-ads-client", () => ({}));

import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue({ update: mocks.update });
  mocks.update.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockResolvedValue({ error: null });
});

describe("GoogleConnectionService.stopWebhook", () => {
  it("switches off only the owner's own company webhook, so its deliveries are refused", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    await new GoogleConnectionService().stopWebhook();
    expect(mocks.from).toHaveBeenCalledWith("google_lead_webhooks");
    expect(mocks.update).toHaveBeenCalledWith({ is_active: false });
    expect(mocks.eq).toHaveBeenCalledTimes(1);
    expect(mocks.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" });
    await expect(new GoogleConnectionService().stopWebhook()).rejects.toMatchObject({ status: 403, code: "GOOGLE_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("reports a database failure instead of claiming leads stopped", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.eq.mockResolvedValue({ error: { message: "db down" } });
    await expect(new GoogleConnectionService().stopWebhook()).rejects.toMatchObject({ status: 500, code: "GOOGLE_WEBHOOK_STOP_FAILED" });
  });
});

describe("GoogleConnectionService.getOverview", () => {
  // Every query in getOverview ends in maybeSingle() or limit(), or is awaited as is; anything else returns the chain.
  function table(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not", "gt", "in", "order"]) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.limit = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  }

  it("reports a switched-off webhook as stopped and never returns its URL or old key", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.from.mockImplementation((name: string) => name === "google_lead_webhooks"
      ? table({ data: { url_token: "token", encrypted_google_key: "enc:old-key", is_active: false, last_lead_received_at: null, last_test_received_at: null }, error: null })
      : table({ data: name === "google_connections" ? null : [], error: null }));
    const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
    expect(overview).toMatchObject({ hasWebhook: false, webhookStopped: true, webhook: null });
    expect(JSON.stringify(overview)).not.toContain("old-key");
  });

  it("reports an active webhook as receiving leads", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.from.mockImplementation((name: string) => name === "google_lead_webhooks"
      ? table({ data: { url_token: "token", encrypted_google_key: "enc:live-key", is_active: true, last_lead_received_at: null, last_test_received_at: null }, error: null })
      : table({ data: name === "google_connections" ? null : [], error: null }));
    const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
    expect(overview).toMatchObject({ hasWebhook: true, webhookStopped: false, webhook: { key: "live-key" } });
  });

  describe("lead status since the current key, and campaign ticks", () => {
    type Result = { data: unknown; error: unknown };
    type Chain = Record<string, ReturnType<typeof vi.fn>>;
    const owner = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
    // Times as PostgREST returns timestamptz: microseconds and a +00:00 offset.
    const KEY_AT = "2026-11-11T10:00:00.123456+00:00";
    const chains = new Map<string, Chain>();
    const tablesRead = () => mocks.from.mock.calls.map(([name]) => name as string);

    function setup(row: Record<string, unknown>, results: { leads?: Result; names?: Result } = {}) {
      chains.clear();
      mocks.from.mockImplementation((name: string) => {
        const result = name === "google_lead_webhooks" ? { data: { url_token: "token", encrypted_google_key: "enc:live-key", is_active: true, last_lead_received_at: null, last_test_received_at: null, key_rotated_at: null, ...row }, error: null }
          : name === "lead_data" ? results.leads ?? { data: [], error: null }
          : name === "google_ads_entity_names" ? results.names ?? { data: [], error: null }
          : { data: name === "google_connections" ? null : [], error: null };
        const chain = table(result) as Chain;
        chains.set(name, chain);
        return chain;
      });
    }

    it("hides test and lead times from before Replace key, so the card starts over, and reads no campaigns", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ key_rotated_at: KEY_AT, last_test_received_at: "2026-11-11T10:00:00.122999+00:00", last_lead_received_at: "2026-11-11T09:00:00.000001+00:00" });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });
      expect(overview.webhook).toMatchObject({ lastTestAt: null, lastLeadAt: null, campaigns: null });
      expect(tablesRead()).not.toContain("lead_data");
    });

    it("keeps test and lead times from after the current key", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ key_rotated_at: KEY_AT, last_test_received_at: "2026-11-11T10:05:00.654321+00:00", last_lead_received_at: "2026-11-11T10:06:00.000001+00:00" });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
      expect(overview.webhook).toMatchObject({ lastTestAt: "2026-11-11T10:05:00.654321+00:00", lastLeadAt: "2026-11-11T10:06:00.000001+00:00", campaigns: null });
    });

    it("keeps every time when the key was never replaced", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ last_test_received_at: "2026-11-01T08:00:00.000001+00:00", last_lead_received_at: "2026-11-02T08:00:00.000001+00:00" });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
      expect(overview.webhook).toMatchObject({ lastTestAt: "2026-11-01T08:00:00.000001+00:00", lastLeadAt: "2026-11-02T08:00:00.000001+00:00" });
    });

    it("lists each campaign once, from this company's Google-sent leads since the key, named or 'Campaign <id>', sorted by name", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ key_rotated_at: KEY_AT, last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" }, {
        leads: { data: [{ google_campaign_id: "222" }, { google_campaign_id: "111" }, { google_campaign_id: "222" }, { google_campaign_id: "333" }], error: null },
        names: { data: [{ entity_id: "111", name: "Diwali" }, { entity_id: "222", name: " Pongal " }], error: null },
      });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });

      expect(overview.webhook?.campaigns).toEqual([{ id: "333", name: "Campaign 333" }, { id: "111", name: "Diwali" }, { id: "222", name: "Pongal" }]);
      const leads = chains.get("lead_data")!;
      expect(leads.select).toHaveBeenCalledWith("google_campaign_id");
      expect(leads.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
      // Only leads Google sent: a call-in lead has no google_lead_event_id and keeps its campaign in lead_ad_ref.
      expect(leads.not).toHaveBeenCalledWith("google_lead_event_id", "is", null);
      expect(leads.not).toHaveBeenCalledWith("google_campaign_id", "is", null);
      expect(leads.gt).toHaveBeenCalledWith("created_at", "2026-11-11T10:00:00.123Z");
      expect(leads.order).toHaveBeenCalledWith("created_at", { ascending: false });
      expect(leads.limit).toHaveBeenCalledWith(1000);
      const names = chains.get("google_ads_entity_names")!;
      expect(names.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
      expect(names.eq).toHaveBeenCalledWith("entity_type", "campaign");
      expect(names.in).toHaveBeenCalledWith("entity_id", ["222", "111", "333"]);
    });

    it("reads every Google-sent lead when the key was never replaced", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" }, { leads: { data: [{ google_campaign_id: "111" }], error: null } });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });
      expect(overview.webhook?.campaigns).toEqual([{ id: "111", name: "Campaign 111" }]);
      expect(chains.get("lead_data")!.gt).not.toHaveBeenCalled();
    });

    it("returns no campaigns, and skips the names read, when Google sent the leads without a campaign", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ key_rotated_at: KEY_AT, last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" }, { leads: { data: [], error: null } });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });
      expect(overview.webhook?.campaigns).toEqual([]);
      expect(tablesRead()).not.toContain("google_ads_entity_names");
    });

    it("does not read campaigns unless the Connection card asks", async () => {
      mocks.access.mockResolvedValue(owner);
      setup({ last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
      expect(overview.webhook?.campaigns).toBeNull();
      expect(tablesRead()).not.toContain("lead_data");
    });

    it("never reads campaigns for an employee", async () => {
      mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" });
      setup({ last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" });
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });
      expect(overview).toMatchObject({ canManage: false, webhook: null, hasWebhook: true });
      expect(tablesRead()).not.toContain("lead_data");
    });

    it.each([
      ["leads", { leads: { data: null, error: { code: "57014", message: "timeout" } }, names: undefined }],
      ["names", { leads: { data: [{ google_campaign_id: "111" }], error: null }, names: { data: null, error: { code: "57014", message: "timeout" } } }],
    ])("a failed %s read leaves the campaigns out but still returns the rest", async (_label, results) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.access.mockResolvedValue(owner);
      setup({ key_rotated_at: KEY_AT, last_lead_received_at: "2026-11-11T11:00:00.000001+00:00" }, results);
      const overview = await new GoogleConnectionService().getOverview("https://crm.example.com", { includeCampaigns: true });
      expect(overview).toMatchObject({ hasWebhook: true, webhook: { key: "live-key", lastLeadAt: "2026-11-11T11:00:00.000001+00:00", campaigns: null } });
      expect(logged).toHaveBeenCalledWith(JSON.stringify({ operation: "google_overview", code: "WEBHOOK_CAMPAIGNS_LOOKUP_FAILED", tenant_id: "tenant-a", dbCode: "57014" }));
      logged.mockRestore();
    });
  });
});
