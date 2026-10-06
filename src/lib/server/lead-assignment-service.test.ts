// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAdAssignmentRule, assignLead, listAdAssignments, listAssignableMembers, setAdAssignmentRule,
} from "@/lib/server/lead-assignment-service";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

type Result = { data: unknown; error: unknown };

function builder(result: Result) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in"]) query[method] = vi.fn(() => query);
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)) });
}

const context = { tenantId: "tenant-a", userId: "11111111-1111-4111-8111-111111111111" };
const OWNER = { ...context, tenantName: "A", fullName: "Owner", membershipRole: "owner" } as never;
const EMPLOYEE = { ...context, tenantName: "A", fullName: "Emp", membershipRole: "employee" } as never;
const LEAD = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";
const RAVI = "44444444-4444-4444-8444-444444444444";

beforeEach(() => vi.resetAllMocks());

describe("listAssignableMembers", () => {
  it("returns only the tenant's ACTIVE members, named from profiles and sorted by name", async () => {
    const memberships = builder({ data: [{ user_id: RAVI }, { user_id: PRIYA }], error: null });
    const profiles = builder({ data: [{ user_id: RAVI, full_name: "Ravi" }, { user_id: PRIYA, full_name: "Priya" }], error: null });
    mocks.from.mockImplementation((table: string) => table === "tenant_memberships" ? memberships : profiles);
    expect(await listAssignableMembers("tenant-a")).toEqual([{ userId: PRIYA, fullName: "Priya" }, { userId: RAVI, fullName: "Ravi" }]);
    expect(memberships.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(memberships.eq).toHaveBeenCalledWith("membership_status", "active");
  });

  it("falls back to 'Team member' when a profile has no name", async () => {
    mocks.from.mockImplementation((table: string) => table === "tenant_memberships"
      ? builder({ data: [{ user_id: PRIYA }], error: null })
      : builder({ data: [{ user_id: PRIYA, full_name: "  " }], error: null }));
    expect(await listAssignableMembers("tenant-a")).toEqual([{ userId: PRIYA, fullName: "Team member" }]);
  });

  it("makes no profile query when the tenant has no active member", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table !== "tenant_memberships") throw new Error(`Unexpected table ${table}`);
      return builder({ data: [], error: null });
    });
    expect(await listAssignableMembers("tenant-a")).toEqual([]);
  });

  it("reports a failed lookup as 500 ASSIGNEES_LOAD_FAILED", async () => {
    mocks.from.mockImplementation(() => builder({ data: null, error: { code: "XX000" } }));
    await expect(listAssignableMembers("tenant-a")).rejects.toMatchObject({ status: 500, code: "ASSIGNEES_LOAD_FAILED" });
  });
});

describe("assignLead", () => {
  it("assigns through assign_lead with the session's tenant and user as actor, and names the assignee", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ lead_id: LEAD, lead_assignee_user_id: PRIYA }], error: null });
    mocks.from.mockImplementation(() => builder({ data: [{ user_id: PRIYA, full_name: "Priya" }], error: null }));
    expect(await assignLead(context, LEAD, PRIYA)).toEqual({ id: LEAD, assignedUserId: PRIYA, assigneeName: "Priya" });
    expect(mocks.rpc).toHaveBeenCalledWith("assign_lead", { p_tenant_id: "tenant-a", p_lead_id: LEAD, p_assignee_user_id: PRIYA, p_actor_user_id: context.userId });
  });

  it("unassigns with null and does not look up a name", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ lead_id: LEAD, lead_assignee_user_id: null }], error: null });
    expect(await assignLead(context, LEAD, null)).toEqual({ id: LEAD, assignedUserId: null, assigneeName: null });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    ["a rejected actor", "42501", 403, "LEAD_ASSIGN_FORBIDDEN"],
    ["an inactive or foreign assignee", "22023", 400, "INVALID_ASSIGNEE"],
    ["any other failure", "XX000", 500, "LEAD_ASSIGN_FAILED"],
  ])("maps %s (%s) to %i %s", async (_label, code, status, appCode) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code } });
    await expect(assignLead(context, LEAD, PRIYA)).rejects.toMatchObject({ status, code: appCode });
  });

  it("maps a lead that is not this tenant's (no row) to 404", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await expect(assignLead(context, LEAD, PRIYA)).rejects.toMatchObject({ status: 404, code: "LEAD_NOT_FOUND" });
  });
});

describe("ad assignment rules (owner only)", () => {
  it("lists the tenant's ads with their rules and the people who can be picked", async () => {
    mocks.rpc.mockResolvedValue({ data: [
      { ad_id: "ad-1", ad_name: "Karuvi", assignee_user_id: PRIYA, total_leads: 12, unassigned_leads: 3 },
      { ad_id: "ad-2", ad_name: null, assignee_user_id: null, total_leads: "4", unassigned_leads: "4" },
    ], error: null });
    mocks.from.mockImplementation((table: string) => table === "tenant_memberships"
      ? builder({ data: [{ user_id: PRIYA }], error: null })
      : builder({ data: [{ user_id: PRIYA, full_name: "Priya" }], error: null }));
    expect(await listAdAssignments(OWNER)).toEqual({
      ads: [
        { adId: "ad-1", adName: "Karuvi", assigneeUserId: PRIYA, totalLeads: 12, unassignedLeads: 3 },
        { adId: "ad-2", adName: null, assigneeUserId: null, totalLeads: 4, unassignedLeads: 4 },
      ],
      members: [{ userId: PRIYA, fullName: "Priya" }],
      isOwner: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("list_lead_ad_assignments", { p_tenant_id: "tenant-a" });
  });

  it("lets an employee view the ads, flagged as not the owner", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.from.mockImplementation(() => builder({ data: [], error: null }));
    expect(await listAdAssignments(EMPLOYEE)).toEqual({ ads: [], members: [], isOwner: false });
    expect(mocks.rpc).toHaveBeenCalledWith("list_lead_ad_assignments", { p_tenant_id: "tenant-a" });
  });

  it("refuses an employee any change before touching the database", async () => {
    await expect(setAdAssignmentRule(EMPLOYEE, "ad-1", PRIYA)).rejects.toMatchObject({ status: 403 });
    await expect(applyAdAssignmentRule(EMPLOYEE, "ad-1")).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("sets and clears a rule with the session's tenant and owner", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "UPDATED", error: null }).mockResolvedValueOnce({ data: "CLEARED", error: null });
    await setAdAssignmentRule(OWNER, "ad-1", PRIYA);
    await setAdAssignmentRule(OWNER, "ad-1", null);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "set_lead_ad_assignment_rule", { p_tenant_id: "tenant-a", p_owner_user_id: context.userId, p_ad_id: "ad-1", p_assignee_user_id: PRIYA });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "set_lead_ad_assignment_rule", { p_tenant_id: "tenant-a", p_owner_user_id: context.userId, p_ad_id: "ad-1", p_assignee_user_id: null });
  });

  it.each([
    ["AD_NOT_FOUND", 404, "AD_NOT_FOUND"],
    ["INVALID_ASSIGNEE", 400, "INVALID_ASSIGNEE"],
    ["something unexpected", 500, "AD_ASSIGNMENT_FAILED"],
  ])("maps the rule outcome %s to %i %s", async (data, status, code) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(setAdAssignmentRule(OWNER, "ad-1", PRIYA)).rejects.toMatchObject({ status, code });
  });

  it("applies a rule and returns how many leads changed", async () => {
    mocks.rpc.mockResolvedValue({ data: 7, error: null });
    expect(await applyAdAssignmentRule(OWNER, "ad-1")).toEqual({ assigned: 7 });
    expect(mocks.rpc).toHaveBeenCalledWith("apply_lead_ad_assignment_rule", { p_tenant_id: "tenant-a", p_owner_user_id: context.userId, p_ad_id: "ad-1" });
  });

  it.each([
    ["42501", 403, "AD_ASSIGNMENT_NOT_ALLOWED"],
    ["P0002", 409, "AD_RULE_NOT_FOUND"],
    ["22023", 409, "INVALID_ASSIGNEE"],
    ["XX000", 500, "AD_ASSIGNMENT_APPLY_FAILED"],
  ])("maps apply failure %s to %i %s", async (errorCode, status, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: errorCode } });
    await expect(applyAdAssignmentRule(OWNER, "ad-1")).rejects.toMatchObject({ status, code });
  });
});
