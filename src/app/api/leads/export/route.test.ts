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
        { leadgenId: "lg-1", leadName: "First", email: "first@example.com", phone: "111", facebookPage: "Page A", adName: "Ad A", adId: "ad-a", status: "New Lead", label: "Warm", leadDate: "2026-09-09T02:00:00Z" },
        { leadgenId: "lg-2", leadName: "Second", email: "second@example.com", phone: "222", facebookPage: "Page A", adName: "Ad B", adId: "ad-b", status: "Contacted", label: "Hot", leadDate: "2026-09-09T03:00:00Z" },
      ],
    });
    const filters = { pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "ad-a", dateFrom: "2026-09-01", dateTo: "2026-09-10", search: "First" };
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(filters), headers: { "content-type": "application/json" } }));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, expect.objectContaining(filters), true);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Lead ID,Lead Name,Lead Date,Status,Label,Email,Phone,Facebook Page,Ad Name,Ad ID,Assigned To");
    // The date sits right after the name in every row too, formatted on the company clock.
    const firstDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-09-09T02:00:00Z"));
    expect(lines[1]).toBe(`lg-1,First,"${firstDate}",New Lead,Warm,first@example.com,111,Page A,Ad A,ad-a,`);
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
      // Google Ads with a campaign (or Unattributed): the download follows the Campaign filter.
      { quickFilter: "all", source: "google_ads", campaignId: "22334455" },
      { quickFilter: "all", source: "google_ads", campaignId: "unattributed", status: "New Lead", search: "Kumar" },
    ];

    for (const body of bodies) {
      const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      // Every filter reaches the query service unchanged, in export mode (no pagination).
      expect(mocks.query).toHaveBeenLastCalledWith({ tenantId: "tenant-a", userId: "user-a" }, body, true);
    }
  });

  it("accepts the Source filter and writes empty Lead ID, Page and Ad cells for a call-in lead", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({
      timezone: "Asia/Kolkata", total: 1,
      items: [{ leadgenId: "", leadName: "Caller", email: null, phone: "9876543210", facebookPage: "-", adName: "-", adId: null, source: "telecaller", status: "New Lead", label: "Warm", leadDate: "2026-10-26T05:00:00Z", assigneeName: "Ravi" }],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "telecaller" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-10-26T05:00:00Z"));
    expect((await response.text()).replace(/^﻿/, "").split("\r\n")[1]).toBe(`,Caller,"${date}",New Lead,Warm,,9876543210,,,,Ravi`);
  });

  it.each([
    ["a non-numeric campaign id", "abc"],
    ["a campaign id that would add a PostgREST filter", "1,lead_name.eq.x"],
    ["an empty campaign id", ""],
  ])("rejects %s with a 400 before reading any lead", async (_name, campaignId) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockClear();
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "google_ads", campaignId }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("authenticated lead CSV route, webhook leads", () => {
  it("accepts the Webhook source and writes the tool's lead_id, Webhook and the source it named", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockResolvedValue({
      timezone: "Asia/Kolkata", total: 1,
      items: [{ leadgenId: "lp-42", leadName: "John Doe", email: "john@example.com", phone: "9876543210", facebookPage: "Webhook", adName: "Landing Page", adId: null, source: "custom_webhook", status: "New Lead", label: "Warm", leadDate: "2026-11-11T05:00:00Z", assigneeName: null }],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "custom_webhook" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenLastCalledWith({ tenantId: "tenant-a", userId: "user-a" }, { quickFilter: "all", source: "custom_webhook" }, true);
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-11T05:00:00Z"));
    expect((await response.text()).replace(/^﻿/, "").split("\r\n")[1]).toBe(`lp-42,John Doe,"${date}",New Lead,Warm,john@example.com,9876543210,Webhook,Landing Page,,`);
  });
});
