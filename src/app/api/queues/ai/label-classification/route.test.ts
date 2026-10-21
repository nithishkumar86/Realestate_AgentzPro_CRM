// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/queues/ai/label-classification/route";

const SECRET = "s".repeat(40);
const mocks = vi.hoisted(() => ({ verify: vi.fn(), processDue: vi.fn() }));
vi.mock("@/lib/server/qstash-service", () => ({ verifyQstashRequest: mocks.verify }));
vi.mock("@/lib/server/env", () => ({ getAuthEnv: () => ({ SUBSCRIPTION_CRON_SECRET: SECRET }) }));
vi.mock("@/lib/server/label-classification-service", () => ({
  LabelClassificationService: class { processDue = mocks.processDue; },
}));

const call = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/queues/ai/label-classification", { method: "POST", headers, body: "{}" }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("label classification worker", () => {
  it("processes due leads for a pg_cron call with the correct secret", async () => {
    mocks.processDue.mockResolvedValue(undefined);
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(200);
    expect(mocks.processDue).toHaveBeenCalledOnce();
  });

  it("rejects a wrong cron secret without processing", async () => {
    mocks.verify.mockResolvedValue(true);
    expect((await call({ "x-cron-secret": "wrong" })).status).toBe(403);
    expect(mocks.processDue).not.toHaveBeenCalled();
  });

  it("still processes for a QStash-signed request", async () => {
    mocks.verify.mockResolvedValue(true);
    mocks.processDue.mockResolvedValue(undefined);
    expect((await call()).status).toBe(200);
    expect(mocks.processDue).toHaveBeenCalledOnce();
  });

  it("rejects an unsigned request without a secret", async () => {
    mocks.verify.mockResolvedValue(false);
    expect((await call()).status).toBe(403);
    expect(mocks.processDue).not.toHaveBeenCalled();
  });

  it("answers 500 when processing fails", async () => {
    mocks.processDue.mockRejectedValue(new Error("boom"));
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(500);
  });
});
