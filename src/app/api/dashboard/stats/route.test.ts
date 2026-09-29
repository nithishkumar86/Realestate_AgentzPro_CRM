// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), stats: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/dashboard-service", () => ({ getDashboardStats: mocks.stats }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/stats", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/dashboard/stats", () => {
  it("takes the tenant only from the verified session and forwards the filters", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.stats.mockResolvedValue({ tenantId: "tenant-a", total: 3 });
    const filters = { quickFilter: "all", status: "Sale", label: "Hot", adId: "unattributed", dateFrom: "2026-09-01", dateTo: "2026-09-10", search: "Ravi", pageRecordId: "00000000-0000-4000-8000-000000000001" };
    const response = await POST(post(filters));
    expect(response.status).toBe(200);
    expect(mocks.stats).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, filters);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(await response.json()).toMatchObject({ total: 3 });
  });

  it.each([
    ["a client-supplied tenant id", { tenantId: "tenant-b" }],
    ["a client-supplied tenant_id", { tenant_id: "tenant-b" }],
    ["paging fields the dashboard does not accept", { page: 1, pageSize: 25 }],
    ["an unknown status", { status: "Nonsense" }],
    ["a non-uuid page id", { pageRecordId: "not-a-uuid" }],
    ["an over-long search", { search: "x".repeat(201) }],
  ])("rejects %s with a 400 before touching data", async (_name, body) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("returns 401 JSON, not a redirect, when the session is missing or idle-expired", async () => {
    mocks.context.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await POST(post({}));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("does not leak internals when the aggregate fails", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.stats.mockRejectedValue(new Error("connection string postgres://secret"));
    const response = await POST(post({}));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
