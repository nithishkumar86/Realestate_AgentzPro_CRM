// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/queues/meta/recovery/route";

const SECRET = "s".repeat(40);
const mocks = vi.hoisted(() => ({ verify: vi.fn(), recover: vi.fn() }));
vi.mock("@/lib/server/qstash-service", () => ({ verifyQstashRequest: mocks.verify }));
vi.mock("@/lib/server/env", () => ({ getAuthEnv: () => ({ SUBSCRIPTION_CRON_SECRET: SECRET }) }));
vi.mock("@/lib/server/lead-recovery-service", () => ({
  LeadRecoveryService: class { recover = mocks.recover; },
}));

const call = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/queues/meta/recovery", { method: "POST", headers, body: "{}" }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("lead recovery worker", () => {
  it("runs recovery for a pg_cron call with the correct secret", async () => {
    mocks.recover.mockResolvedValue(undefined);
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledOnce();
  });

  it("rejects a wrong cron secret without running recovery", async () => {
    mocks.verify.mockResolvedValue(true);
    expect((await call({ "x-cron-secret": "wrong" })).status).toBe(403);
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("still runs recovery for a QStash-signed request", async () => {
    mocks.verify.mockResolvedValue(true);
    mocks.recover.mockResolvedValue(undefined);
    expect((await call()).status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledOnce();
  });

  it("rejects an unsigned request without a secret", async () => {
    mocks.verify.mockResolvedValue(false);
    expect((await call()).status).toBe(403);
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("answers 500 when recovery fails", async () => {
    mocks.recover.mockRejectedValue(new Error("boom"));
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(500);
  });
});
