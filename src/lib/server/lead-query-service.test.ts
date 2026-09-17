// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteLead, getLeadFilterOptions, queryLeads } from "@/lib/server/lead-query-service";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));

function builder(result: { data: unknown; error: unknown; count?: number }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "not", "or", "gte", "lt", "order", "range", "limit", "update", "delete"]) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(() => Promise.resolve(result));
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)) });
}

const context = { tenantId: "tenant-a", userId: "user-a" };

beforeEach(() => vi.resetAllMocks());

describe("tenant-scoped lead query contracts", () => {
  it("always scopes lead queries by the authenticated tenant and composes Page plus ad filters", async () => {
    const leads = builder({ data: [], error: null, count: 0 });
    const timezone = builder({ data: { timezone: "Asia/Kolkata" }, error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone : leads);
    await queryLeads(context, { pageRecordId: "page-a", adId: "ad-a" });
    expect(leads.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(leads.eq).toHaveBeenCalledWith("facebook_page_record_id", "page-a");
    expect(leads.eq).toHaveBeenCalledWith("ad_id", "ad-a");
  });

  it("uses a null ad predicate for Unattributed and no ad predicate for All ads", async () => {
    const leads = builder({ data: [], error: null, count: 0 });
    const timezone = builder({ data: { timezone: "Asia/Kolkata" }, error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone : leads);
    await queryLeads(context, { adId: "unattributed" });
    expect(leads.is).toHaveBeenCalledWith("ad_id", null);
    leads.is.mockClear();
    await queryLeads(context, {});
    expect(leads.is).not.toHaveBeenCalled();
  });

  it("returns distinct ads by ID, preserving duplicate display names and Page scope", async () => {
    const pages = builder({ data: [{ id: "page-a", facebook_page_name: "Page A" }], error: null });
    const leads = builder({ data: [
      { ad_id: "ad-1", ad_name: "Same Name", lead_created_time: "2026-09-09T02:00:00Z" },
      { ad_id: "ad-2", ad_name: "Same Name", lead_created_time: "2026-09-09T01:00:00Z" },
    ], error: null });
    mocks.from.mockImplementation((table: string) => table === "facebook_pages" ? pages : leads);
    const result = await getLeadFilterOptions(context, "page-a");
    expect(result.ads).toEqual([{ id: "ad-1", name: "Same Name" }, { id: "ad-2", name: "Same Name" }]);
    expect(leads.eq).toHaveBeenCalledWith("facebook_page_record_id", "page-a");
  });

  it("export mode does not apply a visible-page range and carries Ad Name/ID fields", async () => {
    const leads = builder({ data: [{ id: "lead-1", lead_name: "Client", lead_email: "client@example.com", lead_phone: "9999999999", ad_id: "ad-1", ad_name: "Campaign", lead_created_time: "2026-09-09T02:00:00Z", status: "New Lead", label: "Warm", facebook_pages: { facebook_page_name: "Page A" } }], error: null, count: 1 });
    const timezone = builder({ data: { timezone: "Asia/Kolkata" }, error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone : leads);
    const result = await queryLeads(context, { pageRecordId: "page-a", adId: "ad-1" }, true);
    expect(leads.range).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ adId: "ad-1", adName: "Campaign", facebookPage: "Page A" });
  });
});

describe("deleteLead", () => {
  it("deletes exactly the tenant-scoped row and returns its id", async () => {
    const leads = builder({ data: { id: "lead-1" }, error: null });
    mocks.from.mockReturnValue(leads);
    const result = await deleteLead(context, "lead-1");
    expect(leads.delete).toHaveBeenCalled();
    expect(leads.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(leads.eq).toHaveBeenCalledWith("id", "lead-1");
    expect(result).toEqual({ id: "lead-1" });
  });

  it("throws LEAD_NOT_FOUND when nothing matched (wrong tenant or already deleted)", async () => {
    const leads = builder({ data: null, error: null });
    mocks.from.mockReturnValue(leads);
    await expect(deleteLead(context, "missing-lead")).rejects.toMatchObject({ code: "LEAD_NOT_FOUND", status: 404 });
  });

  it("reports a blocked delete when a foreign key still references the lead", async () => {
    const leads = builder({ data: null, error: { code: "23503", message: "violates foreign key constraint" } });
    mocks.from.mockReturnValue(leads);
    await expect(deleteLead(context, "lead-1")).rejects.toMatchObject({ code: "LEAD_DELETE_BLOCKED", status: 409 });
  });
});
