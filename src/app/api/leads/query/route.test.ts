// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ queryLeads: mocks.query }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/leads/query", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("lead table query route: Google Ads Campaign filter", () => {
  it.each(["22334455", "unattributed"])("passes campaign %s to the tenant-scoped query unchanged", async (campaignId) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, totalPages: 1, timezone: "Asia/Kolkata" });
    const body = { quickFilter: "all", source: "google_ads", campaignId, pageSize: 100 };
    const response = await POST(post(body));
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenLastCalledWith({ tenantId: "tenant-a", userId: "user-a" }, body);
  });

  it.each([
    ["a non-numeric campaign id", "abc"],
    ["a campaign id that would add a PostgREST filter", "1,lead_name.eq.x"],
    ["a campaign id with a closing bracket", "1)"],
  ])("rejects %s with a 400 before reading any lead", async (_name, campaignId) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockClear();
    const response = await POST(post({ source: "google_ads", campaignId }));
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
