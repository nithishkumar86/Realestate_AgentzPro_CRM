// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/queues/tasks/reminders/route";

const SECRET = "s".repeat(40);
const mocks = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/qstash-service", () => ({ verifyQstashRequest: mocks.verify }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/server/env", () => ({ getAuthEnv: () => ({ SUBSCRIPTION_CRON_SECRET: SECRET }) }));

const call = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/queues/tasks/reminders", { method: "POST", headers, body: "{}" }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("task reminder worker", () => {
  it("rejects an unsigned request without touching the database", async () => {
    mocks.verify.mockResolvedValue(false);
    expect((await call()).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("enqueues the due reminders for a signed request", async () => {
    mocks.verify.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await call()).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_task_reminders", {});
  });

  it("answers 500 so QStash retries when the database call fails", async () => {
    mocks.verify.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect((await call()).status).toBe(500);
  });

  it("enqueues the due reminders for a pg_cron call with the correct secret", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_task_reminders", {});
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects a wrong cron secret without touching the database", async () => {
    mocks.verify.mockResolvedValue(true);
    expect((await call({ "x-cron-secret": "wrong" })).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
