// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ queryLeads: mocks.query }));

import { POST } from "./route";

describe("authenticated lead CSV route", () => {
  it("passes tenant and every filter to export mode and returns all filtered rows", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({
      timezone: "Asia/Kolkata",
      total: 2,
      items: [
        { leadName: "First", email: "first@example.com", phone: "111", facebookPage: "Page A", adName: "Ad A", adId: "ad-a", status: "New Lead", label: "Warm", leadDate: "2026-09-09T02:00:00Z" },
        { leadName: "Second", email: "second@example.com", phone: "222", facebookPage: "Page A", adName: "Ad B", adId: "ad-b", status: "Contacted", label: "Hot", leadDate: "2026-09-09T03:00:00Z" },
      ],
    });
    const filters = { pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "ad-a", dateFrom: "2026-09-01", dateTo: "2026-09-10", search: "First" };
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(filters), headers: { "content-type": "application/json" } }));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, expect.objectContaining(filters), true);
    expect(csv).toContain("Lead Name,Email,Phone,Facebook Page,Ad Name,Ad ID");
    expect(csv).toContain("First");
    expect(csv).toContain("Second");
    expect(csv).not.toContain("Project");
    expect(csv).not.toMatch(/token|secret|authorization/i);
  });

  /**
   * The bodies below are what the Download button actually posts — unfiltered, one filter, and
   * several combined. The schema is strict, so any field the client sends that this route does not
   * declare fails the whole export with a 400 before a single row is read. That is worth a test of
   * its own: the client and this schema have to keep agreeing, and only an exact body proves it.
   */
  it("accepts every filter combination the Download button sends and exports each in full", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({ timezone: "Asia/Kolkata", total: 0, items: [] });
    const bodies = [
      { quickFilter: "all" },
      { quickFilter: "today" },
      { quickFilter: "all", adId: "6301-karuvi" },
      { quickFilter: "all", status: "New Lead", label: "Hot", search: "Kumar" },
      { quickFilter: "all", status: "New Lead", dateFrom: "2026-09-01", dateTo: "2026-09-10", pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "6301-karuvi" },
      // Everything at once: search, Page, Ad, Status, Label and both date bounds.
      { quickFilter: "all", search: "Kumar", pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "6301-karuvi", status: "New Lead", label: "Hot", dateFrom: "2026-09-01", dateTo: "2026-09-10" },
    ];

    for (const body of bodies) {
      const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      // Every filter reaches the query service unchanged, in export mode (no pagination).
      expect(mocks.query).toHaveBeenLastCalledWith({ tenantId: "tenant-a", userId: "user-a" }, body, true);
    }
  });
});
