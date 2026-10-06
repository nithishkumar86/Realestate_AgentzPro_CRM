// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteLead, getLeadFilterOptions, queryLeads, updateLeadTriage } from "@/lib/server/lead-query-service";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

function builder(result: { data: unknown; error: unknown; count?: number }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "not", "or", "gte", "lt", "order", "range", "limit", "update", "delete", "in"]) {
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

describe("lead timeline hooks into the leads list", () => {
  const leadRow = (id: string) => ({ id, lead_name: "Client", lead_email: null, lead_phone: null, ad_id: null, ad_name: null, lead_created_time: "2026-09-09T02:00:00Z", status: "New Lead", label: "Warm", label_source: "default", facebook_pages: { facebook_page_name: "Page A" } });

  it("marks which leads on the page have an open task, with one tenant-scoped query", async () => {
    const leads = builder({ data: [leadRow("lead-1"), leadRow("lead-2")], error: null, count: 2 });
    const timezone = builder({ data: { timezone: "Asia/Kolkata" }, error: null });
    const tasks = builder({ data: [{ lead_id: "lead-2" }], error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone : table === "lead_tasks" ? tasks : leads);
    const result = await queryLeads(context, {});
    expect(result.items.map((item) => item.hasOpenTask)).toEqual([false, true]);
    expect(tasks.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(tasks.eq).toHaveBeenCalledWith("status", "open");
    expect(tasks.in).toHaveBeenCalledWith("lead_id", ["lead-1", "lead-2"]);
  });

  it("skips the open-task lookup in export mode", async () => {
    const leads = builder({ data: [leadRow("lead-1")], error: null, count: 1 });
    const timezone = builder({ data: { timezone: "Asia/Kolkata" }, error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone : leads);
    const result = await queryLeads(context, {}, true);
    expect(mocks.from).not.toHaveBeenCalledWith("lead_tasks");
    expect(result.items[0].hasOpenTask).toBeUndefined();
  });

  it("changes status through update_lead_status with the session's tenant and user as actor", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ lead_id: "lead-1", lead_status: "Working", lead_label: "Warm", lead_label_source: "default" }], error: null });
    const result = await updateLeadTriage(context, "lead-1", { status: "Working" });
    expect(mocks.rpc).toHaveBeenCalledWith("update_lead_status", { p_tenant_id: "tenant-a", p_lead_id: "lead-1", p_status: "Working", p_actor_user_id: "user-a" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "lead-1", status: "Working", label: "Warm", labelSource: "default" });
  });

  it("maps a status change that matched no lead to 404, and a rejected actor to 403", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(updateLeadTriage(context, "lead-x", { status: "Working" })).rejects.toMatchObject({ status: 404, code: "LEAD_NOT_FOUND" });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(updateLeadTriage(context, "lead-1", { status: "Working" })).rejects.toMatchObject({ status: 403, code: "LEAD_UPDATE_FORBIDDEN" });
  });

  it("keeps a label change as a direct tenant-scoped update (labels are not on the timeline)", async () => {
    const leads = builder({ data: { id: "lead-1", status: "New Lead", label: "Hot", label_source: "telecaller" }, error: null });
    mocks.from.mockReturnValue(leads);
    await updateLeadTriage(context, "lead-1", { label: "Hot" });
    expect(leads.update).toHaveBeenCalledWith({ label: "Hot" });
    expect(leads.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});


describe("lead assignment in the leads list", () => {
  const PRIYA = "33333333-3333-4333-8333-333333333333";
  const timezone = () => builder({ data: { timezone: "Asia/Kolkata" }, error: null });

  it.each([
    ["unassigned", "is", ["assigned_user_id", null]],
    ["me", "eq", ["assigned_user_id", "user-a"]],
    [PRIYA, "eq", ["assigned_user_id", PRIYA]],
  ] as const)("filters by assignee %s with the matching tenant-scoped predicate", async (assignee, method, args) => {
    const leads = builder({ data: [], error: null, count: 0 });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone() : leads);
    await queryLeads(context, { assignee });
    expect(leads[method]).toHaveBeenCalledWith(...args);
    expect(leads.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("adds no assignee predicate when the filter is empty", async () => {
    const leads = builder({ data: [], error: null, count: 0 });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone() : leads);
    await queryLeads(context, {});
    expect(leads.is).not.toHaveBeenCalled();
    expect(leads.eq).not.toHaveBeenCalledWith("assigned_user_id", expect.anything());
  });

  it("names each row's assignee from profiles (one lookup), and leaves unassigned rows null", async () => {
    const leads = builder({ data: [
      { id: "lead-1", lead_name: "A", ad_id: "ad-1", lead_created_time: "2026-09-09T02:00:00Z", status: "New Lead", label: "Hot", assigned_user_id: PRIYA },
      { id: "lead-2", lead_name: "B", ad_id: "ad-1", lead_created_time: "2026-09-09T01:00:00Z", status: "New Lead", label: "Hot", assigned_user_id: PRIYA },
      { id: "lead-3", lead_name: "C", ad_id: null, lead_created_time: "2026-09-09T00:00:00Z", status: "New Lead", label: "Hot", assigned_user_id: null },
    ], error: null, count: 3 });
    const profiles = builder({ data: [{ user_id: PRIYA, full_name: "Priya" }], error: null });
    const tasks = builder({ data: [], error: null });
    mocks.from.mockImplementation((table: string) => table === "tenants" ? timezone() : table === "profiles" ? profiles : table === "lead_tasks" ? tasks : leads);
    const result = await queryLeads(context, {});
    expect(result.items.map((item) => [item.assignedUserId, item.assigneeName])).toEqual([[PRIYA, "Priya"], [PRIYA, "Priya"], [null, null]]);
    expect(profiles.in).toHaveBeenCalledTimes(1);
    expect(profiles.in).toHaveBeenCalledWith("user_id", [PRIYA]);
  });

  it("offers the tenant's active members as assignee choices with the filter options", async () => {
    const pages = builder({ data: [], error: null });
    const leads = builder({ data: [], error: null });
    const memberships = builder({ data: [{ user_id: PRIYA }], error: null });
    const profiles = builder({ data: [{ user_id: PRIYA, full_name: "Priya" }], error: null });
    mocks.from.mockImplementation((table: string) => table === "facebook_pages" ? pages : table === "tenant_memberships" ? memberships : table === "profiles" ? profiles : leads);
    const options = await getLeadFilterOptions(context);
    expect(options.assignees).toEqual([{ userId: PRIYA, fullName: "Priya" }]);
    expect(memberships.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(memberships.eq).toHaveBeenCalledWith("membership_status", "active");
  });
});
