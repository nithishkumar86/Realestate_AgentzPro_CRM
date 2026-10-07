// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/queues/tasks/reminders/route";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/qstash-service", () => ({ verifyQstashRequest: mocks.verify }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));

const call = () => POST(new Request("http://localhost/api/queues/tasks/reminders", { method: "POST", body: "{}" }));

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
});
