// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/server/custom-webhook/custom-webhook-connection-service", () => ({
  CustomWebhookConnectionService: class { getOverview = mocks.getOverview; createOrReplace = mocks.createOrReplace; stop = mocks.stop; },
}));

import { DELETE, GET, POST } from "./route";

const URL_BASE = "http://localhost/api/integrations/custom-webhook";
const send = (method: "POST" | "DELETE", origin = "http://localhost") => new Request(URL_BASE, { method, headers: { host: "localhost", origin }, body: method === "POST" ? "{}" : undefined });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/integrations/custom-webhook", () => {
  it("asks for the URL only with ?details=1 (the Connection card)", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasWebhook: true, webhookStopped: false, webhook: null });
    expect((await GET(new Request(URL_BASE))).status).toBe(200);
    expect(mocks.getOverview).toHaveBeenLastCalledWith("http://localhost", { includeUrl: false });
    await GET(new Request(`${URL_BASE}?details=1`));
    expect(mocks.getOverview).toHaveBeenLastCalledWith("http://localhost", { includeUrl: true });
  });

  it("passes a sign-in refusal through", async () => {
    mocks.getOverview.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    expect((await GET(new Request(URL_BASE))).status).toBe(401);
  });
});

describe("POST /api/integrations/custom-webhook", () => {
  it("creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "http://localhost/api/webhooks/custom/x" });
    const response = await POST(send("POST"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "http://localhost/api/webhooks/custom/x" });
    expect(mocks.createOrReplace).toHaveBeenCalledWith("http://localhost");
  });

  it("refuses a cross-site request without creating anything", async () => {
    expect((await POST(send("POST", "https://evil.example"))).status).toBe(403);
    expect(mocks.createOrReplace).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/integrations/custom-webhook", () => {
  it("stops webhook leads", async () => {
    mocks.stop.mockResolvedValue(undefined);
    const response = await DELETE(send("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
  });

  it("refuses a cross-site request, and passes the owner-only refusal through", async () => {
    expect((await DELETE(send("DELETE", "https://evil.example"))).status).toBe(403);
    expect(mocks.stop).not.toHaveBeenCalled();
    mocks.stop.mockRejectedValue(new AppError("Only the company owner can manage the webhook.", { status: 403, code: "CUSTOM_WEBHOOK_OWNER_REQUIRED" }));
    const response = await DELETE(send("DELETE"));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CUSTOM_WEBHOOK_OWNER_REQUIRED");
  });
});
