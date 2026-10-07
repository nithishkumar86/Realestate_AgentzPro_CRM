// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTaskNotifications, markTaskNotificationsRead } from "@/lib/server/task-notification-service";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));

const context = { tenantId: "tenant-a", userId: "user-a" };

function builder(result: { data?: unknown; error?: unknown; count?: number }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit", "update"]) query[method] = vi.fn(() => query);
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: null, count: 0, ...result })) });
}

beforeEach(() => vi.clearAllMocks());

describe("task notifications", () => {
  it("lists only the signed-in member's alerts for their tenant, with task and lead names", async () => {
    const notifications = builder({ data: [{ id: "n1", kind: "due_now", due_at: "d", created_at: "c", read_at: null, lead_id: "l1", task_id: "t1" }], count: 1 });
    const tasks = builder({ data: [{ id: "t1", title: "Call back" }] });
    const leads = builder({ data: [{ id: "l1", lead_name: "Ravi" }] });
    mocks.from.mockImplementation((table: string) => (table === "task_notifications" ? notifications : table === "lead_tasks" ? tasks : leads));
    const result = await listTaskNotifications(context);
    expect(notifications.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(notifications.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(tasks.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(result.items[0]).toMatchObject({ id: "n1", kind: "due_now", taskTitle: "Call back", leadName: "Ravi", read: false });
  });

  it("maps a failed read to 500", async () => {
    mocks.from.mockReturnValue(builder({ error: { code: "XX" } }));
    await expect(listTaskNotifications(context)).rejects.toMatchObject({ status: 500, code: "NOTIFICATIONS_QUERY_FAILED" });
  });

  it("marks read only inside the member's own tenant and user, narrowing to the given ids", async () => {
    const query = builder({});
    mocks.from.mockReturnValue(query);
    await markTaskNotificationsRead(context, ["n1"]);
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(query.in).toHaveBeenCalledWith("id", ["n1"]);
    const all = builder({});
    mocks.from.mockReturnValue(all);
    await markTaskNotificationsRead(context, "all");
    expect(all.in).not.toHaveBeenCalled();
  });
});
