// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/telecaller-lead-service", () => ({ listCallInOrigins: mocks.list }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/leads/telecaller/origins", () => {
  it("answers the session company's origins", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    const origins = { today: "2026-10-30", minDate: "2025-10-30", platforms: [] };
    mocks.list.mockResolvedValue(origins);
    const response = await GET(new Request("http://localhost/api/leads/telecaller/origins"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(origins);
    expect(mocks.list).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" });
  });

  it("never lists anything without a signed-in member", async () => {
    const { AppError } = await import("@/lib/server/app-error");
    mocks.context.mockRejectedValue(new AppError("Sign in.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await GET(new Request("http://localhost/api/leads/telecaller/origins"));
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
