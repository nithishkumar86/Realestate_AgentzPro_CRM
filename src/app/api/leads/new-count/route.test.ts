// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ countNewLeadsOnFirstPage: mocks.count }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/leads/new-count", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

const since = "2026-11-05T09:30:12.123456+00:00";

beforeEach(() => {
  mocks.context.mockReset().mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
  mocks.count.mockReset().mockResolvedValue(2);
});

describe("new leads count route", () => {
  it("counts for the session's company with the table's filters, the cursor and page size, and returns only the count", async () => {
    const filters = { quickFilter: "today", status: "New Lead", label: "Hot", assignee: "me", source: "google_ads", campaignId: "22334455", dateFrom: "2026-11-01", dateTo: "2026-11-05", search: "Ravi", pageRecordId: "11111111-1111-4111-8111-111111111111", adId: "6301-karuvi" };
    const response = await POST(post({ ...filters, pageSize: 100, since }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2 });
    // The microsecond cursor is passed on exactly as the database wrote it.
    expect(mocks.count).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, filters, since, 100);
  });

  it("accepts a null cursor (the company had no leads at the last load)", async () => {
    const response = await POST(post({ quickFilter: "all", pageSize: 100, since: null }));
    expect(response.status).toBe(200);
    expect(mocks.count).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, { quickFilter: "all" }, null, 100);
  });

  it.each([
    ["a tenant id in the body", { tenantId: "tenant-b", pageSize: 100, since }],
    ["a page number", { page: 2, pageSize: 100, since }],
    ["a single lead id", { leadId: "11111111-1111-4111-8111-111111111111", pageSize: 100, since }],
    ["a page size above the table's 100", { pageSize: 101, since }],
    ["no page size", { since }],
    ["no cursor", { pageSize: 100 }],
    ["a date without a time", { pageSize: 100, since: "2026-11-05" }],
    ["a time without an offset", { pageSize: 100, since: "2026-11-05T09:30:12.123456" }],
    ["a cursor that would add a PostgREST filter", { pageSize: 100, since: `${since},lead_name.eq.x` }],
    ["a campaign id that would add a PostgREST filter", { pageSize: 100, since, campaignId: "1,lead_name.eq.x" }],
  ])("rejects %s with a 400 before reading any lead", async (_name, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("answers a failed count with an error, never a made-up number", async () => {
    mocks.count.mockRejectedValue(new AppError("New leads could not be checked.", { status: 500, code: "LEAD_QUERY_FAILED" }));
    const response = await POST(post({ pageSize: 100, since }));
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("count");
  });

  it("refuses a signed-out request before reading any lead", async () => {
    mocks.context.mockRejectedValue(new AppError("Sign in to continue.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await POST(post({ pageSize: 100, since }));
    expect(response.status).toBe(401);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});
