// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTaskOverview } from "@/lib/server/task-tracking-service";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), members: vi.fn(), timezone: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/lead-assignment-service", () => ({ listAssignableMembers: mocks.members }));
vi.mock("@/lib/server/lead-query-service", () => ({ getTenantTimezone: mocks.timezone }));

const OWNER = { tenantId: "tenant-a", userId: "owner-1", membershipRole: "owner" } as never;
const EMPLOYEE = { tenantId: "tenant-a", userId: "emp-1", membershipRole: "member" } as never;
const LEAD = "11111111-1111-4111-8111-111111111111";

const row = {
  id: "t1", lead_id: LEAD, title: "Call", due_at: "2026-10-08T10:00:00Z", original_due_at: "2026-10-08T09:00:00Z",
  repeat_rule: "none", status: "completed", closed_at: "2026-10-08T09:30:00Z", lead_name: "Ravi", lead_phone: "999",
  owner_user_id: "emp-1", owner_name: "Asha",
};

function leadQuery() {
  const result = { data: [{ id: LEAD, status: "Working", ad_name: "Ad", lead_email: null, assigned_user_id: "emp-1", facebook_pages: { facebook_page_name: "Page" } }], error: null };
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in"]) query[method] = vi.fn(() => query);
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.timezone.mockResolvedValue("Asia/Kolkata");
  mocks.members.mockResolvedValue([{ userId: "emp-1", fullName: "Asha" }]);
  mocks.from.mockImplementation(() => leadQuery());
  mocks.rpc.mockImplementation((name: string) => Promise.resolve(name === "list_tracked_tasks"
    ? { data: [row], error: null }
    : { data: [{ overdue: 1, today: 2, upcoming: 3, done: 4, done_on_time: 3 }], error: null }));
});

describe("getTaskOverview", () => {
  it("pins an employee to their own tasks whatever member is requested, and hides the member list", async () => {
    const result = await getTaskOverview(EMPLOYEE, { bucket: "today", member: "someone-else" });
    expect(mocks.rpc).toHaveBeenCalledWith("list_tracked_tasks", expect.objectContaining({ p_tenant_id: "tenant-a", p_owner_user_id: "emp-1" }));
    expect(mocks.rpc).toHaveBeenCalledWith("count_tracked_tasks", expect.objectContaining({ p_owner_user_id: "emp-1" }));
    expect(result.isOwner).toBe(false);
    expect(result.members).toEqual([]);
    expect(mocks.members).not.toHaveBeenCalled();
  });

  it("lets the owner see everyone, or narrow to one member", async () => {
    await getTaskOverview(OWNER, { bucket: "overdue" });
    expect(mocks.rpc).toHaveBeenCalledWith("list_tracked_tasks", expect.objectContaining({ p_owner_user_id: null }));
    await getTaskOverview(OWNER, { bucket: "overdue", member: "emp-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("list_tracked_tasks", expect.objectContaining({ p_owner_user_id: "emp-1" }));
  });

  it("measures on time against the ORIGINAL due time and marks a moved task as rescheduled", async () => {
    // Closed 09:30 is before the moved due time (10:00) but after the original (09:00): Late, and rescheduled.
    const { items, counts } = await getTaskOverview(OWNER, { bucket: "done" });
    expect(items[0]).toMatchObject({ onTime: false, rescheduled: true, lead: { status: "Working", facebookPage: "Page" } });
    expect(counts).toEqual({ overdue: 1, today: 2, upcoming: 3, done: 4, doneOnTime: 3 });
  });

  it("scopes the lead lookup to the tenant and maps a database failure to 500", async () => {
    const query = leadQuery();
    mocks.from.mockReturnValue(query);
    await getTaskOverview(OWNER, { bucket: "today" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(getTaskOverview(OWNER, { bucket: "today" })).rejects.toMatchObject({ status: 500, code: "TASKS_QUERY_FAILED" });
  });
});
