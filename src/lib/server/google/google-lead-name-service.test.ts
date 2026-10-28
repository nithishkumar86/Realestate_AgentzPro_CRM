// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLeadNameService } from "@/lib/server/google/google-lead-name-service";

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {} as Record<string, Row[]>,
  upserts: [] as Array<{ table: string; row: Row }>,
  search: vi.fn(),
  refresh: vi.fn(),
}));

// A tiny in-memory stand-in for the supabase-js query builder: eq/is filters, maybeSingle, plain await.
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (mocks.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        upsert: async (row: Row) => { mocks.upserts.push({ table, row }); return { error: null }; },
        then: (resolve: (value: unknown) => void) => resolve({ data: rows(), error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/server/token-crypto", () => ({ decryptToken: (value: string) => value }));
vi.mock("@/lib/server/google/google-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/google/google-oauth")>()),
  refreshGoogleAccessToken: mocks.refresh,
}));
vi.mock("@/lib/server/google/google-ads-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/google/google-ads-client")>()),
  searchGoogleAds: mocks.search,
}));

const CLAIM = { id: "event-1", tenant_id: "tenant-a", claim_token: "claim-1", name_attempts: 1 };

function queueOneClaim(): void {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_due_google_lead_name") {
      const claimed = mocks.rpc.mock.calls.filter(([called]) => called === "claim_due_google_lead_name").length === 1;
      return { data: claimed ? CLAIM : null, error: null };
    }
    return { data: true, error: null };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.upserts.length = 0;
  mocks.tables = {
    lead_data: [{ tenant_id: "tenant-a", google_lead_event_id: "event-1", google_campaign_id: "111", google_adgroup_id: null, google_asset_group_id: "222" }],
    google_connections: [{ tenant_id: "tenant-a", status: "active", encrypted_refresh_token: "refresh-token" }],
    google_ads_accounts: [
      { tenant_id: "tenant-a", is_manager: false, customer_id: "1000000001", login_customer_id: null },
      { tenant_id: "tenant-a", is_manager: false, customer_id: "1000000002", login_customer_id: "9000000009" },
    ],
    google_ads_entity_names: [],
  };
  mocks.refresh.mockResolvedValue("access-token");
  queueOneClaim();
});

describe("GoogleLeadNameService", () => {
  it("finds the account that owns the campaign, through its manager, and writes '<campaign> › <asset group>'", async () => {
    mocks.search.mockImplementation(async (_token: string, customerId: string, _login: string | null, query: string) => {
      if (customerId === "1000000001") return [];
      if (query.includes("FROM campaign")) return [{ campaign: { id: "111", name: "Chennai Villas" } }];
      return [{ assetGroup: { id: "222", name: "Search assets" } }];
    });
    await new GoogleLeadNameService().processDue();
    expect(mocks.search).toHaveBeenCalledWith("access-token", "1000000002", "9000000009", "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = 111");
    expect(mocks.rpc).toHaveBeenCalledWith("complete_google_lead_name", { p_event_id: "event-1", p_tenant_id: "tenant-a", p_claim_token: "claim-1", p_ad_name: "Chennai Villas › Search assets" });
    expect(mocks.upserts.map(({ row }) => [row.entity_type, row.customer_id])).toEqual([["campaign", "1000000002"], ["asset_group", "1000000002"]]);
  });

  it("uses the cached name without calling Google Ads", async () => {
    mocks.tables.lead_data[0].google_asset_group_id = null;
    mocks.tables.google_ads_entity_names = [{ tenant_id: "tenant-a", entity_type: "campaign", entity_id: "111", customer_id: "1000000001", name: "Cached Campaign" }];
    await new GoogleLeadNameService().processDue();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("complete_google_lead_name", expect.objectContaining({ p_ad_name: "Cached Campaign" }));
  });

  it("parks the lead (no attempt used) when the tenant has no Google connection", async () => {
    mocks.tables.google_connections = [];
    await new GoogleLeadNameService().processDue();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_google_lead_name_retry", expect.objectContaining({ p_park: true, p_error_code: "GOOGLE_CONNECTION_REQUIRED" }));
    expect(mocks.rpc).not.toHaveBeenCalledWith("complete_google_lead_name", expect.anything());
  });

  it("parks when Google revoked the sign-in", async () => {
    const { GoogleOAuthError } = await import("@/lib/server/google/google-oauth");
    mocks.refresh.mockRejectedValue(new GoogleOAuthError("invalid_grant", false));
    await new GoogleLeadNameService().processDue();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_google_lead_name_retry", expect.objectContaining({ p_park: true, p_error_code: "GOOGLE_REAUTHORIZATION_REQUIRED" }));
  });

  it("schedules a counted retry when no linked account owns the campaign", async () => {
    mocks.search.mockResolvedValue([]);
    await new GoogleLeadNameService().processDue();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_google_lead_name_retry", expect.objectContaining({ p_park: false, p_error_code: "CAMPAIGN_NOT_FOUND" }));
  });
});
