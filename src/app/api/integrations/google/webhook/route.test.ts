// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ stopWebhook: vi.fn(), createOrRotateWebhook: vi.fn() }));
vi.mock("@/lib/server/google/google-connection-service", () => ({
  GoogleConnectionService: class { stopWebhook = mocks.stopWebhook; createOrRotateWebhook = mocks.createOrRotateWebhook; },
}));

import { DELETE } from "./route";

function remove(origin = "http://localhost"): Request {
  return new Request("http://localhost/api/integrations/google/webhook", { method: "DELETE", headers: { host: "localhost", origin } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE /api/integrations/google/webhook", () => {
  it("stops Google Ads leads", async () => {
    mocks.stopWebhook.mockResolvedValue(undefined);
    const response = await DELETE(remove());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(mocks.stopWebhook).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-site request without stopping anything", async () => {
    const response = await DELETE(remove("https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.stopWebhook).not.toHaveBeenCalled();
  });

  it("passes the owner-only refusal through", async () => {
    mocks.stopWebhook.mockRejectedValue(new AppError("Only the company owner can manage Google Ads.", { status: 403, code: "GOOGLE_OWNER_REQUIRED" }));
    const response = await DELETE(remove());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("GOOGLE_OWNER_REQUIRED");
  });
});
