// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), send: vi.fn(), setDetails: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("web-push", () => ({ default: { sendNotification: mocks.send, setVapidDetails: mocks.setDetails } }));

const row = { id: "n1", tenant_id: "t1", user_id: "u1", task_id: "k1", lead_id: "l1", kind: "due_now" };

function builder(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "in", "eq", "delete", "upsert"]) query[method] = vi.fn(() => query);
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data, error: null })) });
}

function wire(subs: unknown[]) {
  const deleteQuery = builder(null);
  mocks.from.mockImplementation((table: string) => {
    if (table === "push_subscriptions") return Object.assign(builder(subs), { delete: deleteQuery.delete });
    if (table === "lead_tasks") return builder([{ id: "k1", tenant_id: "t1", title: "Call back" }]);
    return builder([{ id: "l1", tenant_id: "t1", lead_name: "Ravi" }]);
  });
  return deleteQuery;
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("sendReminderPushes", () => {
  it("does nothing without VAPID keys", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", ""); vi.stubEnv("VAPID_PRIVATE_KEY", "");
    const { sendReminderPushes } = await import("@/lib/server/push-service");
    expect(await sendReminderPushes([row])).toEqual({ sent: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("pushes only to the subscriptions of the alert's own member and tenant", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub"); vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    wire([
      { tenant_id: "t1", user_id: "u1", endpoint: "https://push/mine", p256dh: "p", auth: "a" },
      { tenant_id: "t1", user_id: "u2", endpoint: "https://push/other-user", p256dh: "p", auth: "a" },
      { tenant_id: "t2", user_id: "u1", endpoint: "https://push/other-tenant", p256dh: "p", auth: "a" },
    ]);
    mocks.send.mockResolvedValue({});
    const { sendReminderPushes } = await import("@/lib/server/push-service");
    expect(await sendReminderPushes([row])).toEqual({ sent: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ endpoint: "https://push/mine" });
    expect(JSON.parse(mocks.send.mock.calls[0][1])).toMatchObject({ title: "Follow up with Ravi now", body: "Call back", url: "/tasks" });
  });

  it("drops a subscription the push service reports gone, and never throws", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub"); vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    const removal = wire([{ tenant_id: "t1", user_id: "u1", endpoint: "https://push/dead", p256dh: "p", auth: "a" }]);
    mocks.send.mockRejectedValue({ statusCode: 410 });
    const { sendReminderPushes } = await import("@/lib/server/push-service");
    await expect(sendReminderPushes([row])).resolves.toEqual({ sent: 0 });
    expect(removal.delete).toHaveBeenCalled();
    expect(removal.eq).toHaveBeenCalledWith("endpoint", "https://push/dead");
  });
});
