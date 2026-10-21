// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedWorkerRequest } from "@/lib/server/worker-auth";

const SECRET = "s".repeat(40);
const mocks = vi.hoisted(() => ({ verify: vi.fn(), authEnv: vi.fn() }));
vi.mock("@/lib/server/qstash-service", () => ({ verifyQstashRequest: mocks.verify }));
vi.mock("@/lib/server/env", () => ({ getAuthEnv: mocks.authEnv }));

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/queues/tasks/reminders", { method: "POST", headers, body: "{}" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.authEnv.mockReturnValue({ SUBSCRIPTION_CRON_SECRET: SECRET });
});

describe("isAuthorizedWorkerRequest", () => {
  it("accepts the correct cron secret without checking a QStash signature", async () => {
    expect(await isAuthorizedWorkerRequest(request({ "x-cron-secret": SECRET }), "{}")).toBe(true);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects a wrong cron secret and never falls back to the QStash check", async () => {
    mocks.verify.mockResolvedValue(true);
    expect(await isAuthorizedWorkerRequest(request({ "x-cron-secret": "wrong" }), "{}")).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects an empty cron secret", async () => {
    expect(await isAuthorizedWorkerRequest(request({ "x-cron-secret": "" }), "{}")).toBe(false);
  });

  it("rejects a cron secret when the auth env cannot be loaded", async () => {
    mocks.authEnv.mockImplementation(() => { throw new Error("env"); });
    expect(await isAuthorizedWorkerRequest(request({ "x-cron-secret": SECRET }), "{}")).toBe(false);
  });

  it("uses the QStash signature check when no cron secret is sent", async () => {
    mocks.verify.mockResolvedValue(true);
    expect(await isAuthorizedWorkerRequest(request(), "{}")).toBe(true);
    mocks.verify.mockResolvedValue(false);
    expect(await isAuthorizedWorkerRequest(request(), "{}")).toBe(false);
    expect(mocks.authEnv).not.toHaveBeenCalled();
  });
});
