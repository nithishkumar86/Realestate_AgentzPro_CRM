// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/push/subscribe/route";

const mocks = vi.hoisted(() => ({ context: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/push-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/push-service")>("@/lib/server/push-service");
  return { ...actual, savePushSubscription: mocks.save, removePushSubscription: vi.fn() };
});

const post = (endpoint: string) => POST(new Request("http://localhost/api/push/subscribe", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint, keys: { p256dh: "p", auth: "a" } }),
}));

beforeEach(() => { vi.clearAllMocks(); mocks.context.mockResolvedValue({ tenantId: "t", userId: "u" }); });

describe("POST /api/push/subscribe", () => {
  it.each(["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc"])(
    "accepts the browser push service %s", async (endpoint) => {
      expect((await post(endpoint)).status).toBe(200);
      expect(mocks.save).toHaveBeenCalledOnce();
    });

  it.each(["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x"])(
    "rejects %s so the server never posts to it", async (endpoint) => {
      expect((await post(endpoint)).status).toBe(400);
      expect(mocks.save).not.toHaveBeenCalled();
    });
});
