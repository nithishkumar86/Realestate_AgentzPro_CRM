import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), assertSameOrigin: vi.fn() }));
vi.mock("@/lib/server/auth/supabase-auth-client", () => ({ createAuthClient: async () => ({ auth: { signOut: mocks.signOut } }) }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
beforeEach(() => { vi.clearAllMocks(); mocks.signOut.mockResolvedValue({ error: null }); });

it("retains the origin check and signs out this device only", async () => {
  const request = new Request("https://crm.example.com/api/auth/logout", { method: "POST" });
  const response = await POST(request);
  expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ signedOut: true });
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("set-cookie")).toMatch(/agentz_active_tenant=;.*Max-Age=0/i);
  expect(response.headers.get("set-cookie")).toMatch(/agentz_last_activity=;.*Max-Age=0/i);
});
