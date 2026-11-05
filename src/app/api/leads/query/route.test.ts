// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), query: vi.fn(), cursor: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ queryLeads: mocks.query, getLeadsCursor: mocks.cursor }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/leads/query", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("lead table query route: Google Ads Campaign filter", () => {
  it.each(["22334455", "unattributed"])("passes campaign %s to the tenant-scoped query unchanged", async (campaignId) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, totalPages: 1, timezone: "Asia/Kolkata" });
    mocks.cursor.mockResolvedValue(null);
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

describe("lead table query route: the new-leads cursor", () => {
  const page = { items: [{ id: "lead-1" }], total: 1, page: 1, pageSize: 100, totalPages: 1, timezone: "Asia/Kolkata" };
  const cursor = "2026-11-05T09:30:12.123456+00:00";
  beforeEach(() => {
    mocks.context.mockReset().mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockReset().mockResolvedValue(page);
    mocks.cursor.mockReset();
  });

  it("returns the cursor of the session's company exactly as read, reading it before the list", async () => {
    mocks.cursor.mockResolvedValue(cursor);
    const response = await POST(post({ quickFilter: "all", pageSize: 100 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...page, cursor });
    expect(mocks.cursor).toHaveBeenCalledWith("tenant-a");
    // Before the list: a lead saved between the two reads is then counted once, never missed.
    expect(mocks.cursor.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
  });

  it("returns a null cursor for a company with no leads yet", async () => {
    mocks.cursor.mockResolvedValue(null);
    const response = await POST(post({ pageSize: 100 }));
    expect(await response.json()).toEqual({ ...page, cursor: null });
  });

  it("still loads the table, without a cursor, when the cursor cannot be read", async () => {
    mocks.cursor.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(post({ pageSize: 100 }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual(page);
    expect("cursor" in body).toBe(false);
  });

  it("does not read a cursor for the single lead a task alert opens", async () => {
    const response = await POST(post({ leadId: "11111111-1111-4111-8111-111111111111", pageSize: 1 }));
    expect(response.status).toBe(200);
    expect(mocks.cursor).not.toHaveBeenCalled();
    expect("cursor" in (await response.json() as Record<string, unknown>)).toBe(false);
  });
});
