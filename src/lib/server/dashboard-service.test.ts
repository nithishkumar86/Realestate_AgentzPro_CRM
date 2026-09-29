// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboardRpcArgs, getDashboardStats } from "@/lib/server/dashboard-service";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

const TZ = "Asia/Kolkata";
const TENANT = "tenant-a";
// 2026-09-29 12:00 IST
const NOW = new Date("2026-09-29T06:30:00.000Z");

function tenantTimezone(timezone: string | null = TZ) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.single = vi.fn(() => Promise.resolve({ data: timezone ? { timezone } : null, error: null }));
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe("buildDashboardRpcArgs", () => {
  it("uses the tenant-local calendar month and never a UTC month", () => {
    const args = buildDashboardRpcArgs(TENANT, TZ, {}, NOW);
    // 1 Sep 00:00 IST is 31 Aug 18:30 UTC
    expect(args.p_month_from).toBe("2026-08-31T18:30:00.000Z");
    expect(args.p_month_to).toBe("2026-09-30T18:30:00.000Z");
    expect(args.p_prev_month_from).toBe("2026-07-31T18:30:00.000Z");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_tz).toBe(TZ);
  });

  it("switches month at the tenant's midnight, not UTC midnight", () => {
    // 30 Sep 20:00 UTC is already 1 Oct 01:30 in IST: the tenant is in October, a UTC clock would say September.
    const args = buildDashboardRpcArgs(TENANT, TZ, {}, new Date("2026-09-30T20:00:00.000Z"));
    expect(args.p_month_from).toBe("2026-09-30T18:30:00.000Z"); // 1 Oct 00:00 IST
    expect(args.p_month_to).toBe("2026-10-31T18:30:00.000Z"); // 1 Nov 00:00 IST
    expect(args.p_prev_month_from).toBe("2026-08-31T18:30:00.000Z"); // 1 Sep 00:00 IST
    // and the reverse: 1 Oct 00:00-05:30 UTC is still 30 Sep evening in New York
    const ny = buildDashboardRpcArgs(TENANT, "America/New_York", {}, new Date("2026-10-01T02:00:00.000Z"));
    expect(ny.p_month_from).toBe("2026-09-01T04:00:00.000Z"); // 1 Sep 00:00 EDT
  });

  it("compares against the same elapsed time last month, never past the start of this month", () => {
    const args = buildDashboardRpcArgs(TENANT, TZ, {}, NOW);
    const elapsed = NOW.getTime() - Date.parse(args.p_month_from);
    expect(Date.parse(args.p_prev_month_to) - Date.parse(args.p_prev_month_from)).toBe(elapsed);

    // 31 Mar (31 days) into a 28-day February: the window is capped at the start of March.
    const march = buildDashboardRpcArgs(TENANT, TZ, {}, new Date("2026-03-31T18:00:00.000Z"));
    expect(Date.parse(march.p_prev_month_to)).toBeLessThanOrEqual(Date.parse(march.p_month_from));
  });

  it("rolls the month arithmetic across a year boundary", () => {
    const args = buildDashboardRpcArgs(TENANT, TZ, {}, new Date("2026-01-15T06:30:00.000Z"));
    expect(args.p_prev_month_from).toBe("2025-11-30T18:30:00.000Z"); // 1 Dec 2025 00:00 IST
    expect(args.p_month_from).toBe("2025-12-31T18:30:00.000Z"); // 1 Jan 2026 00:00 IST
    const december = buildDashboardRpcArgs(TENANT, TZ, {}, new Date("2026-12-15T06:30:00.000Z"));
    expect(december.p_month_to).toBe("2026-12-31T18:30:00.000Z"); // 1 Jan 2027 00:00 IST
  });

  it("chooses the timeline bucket from the selected window", () => {
    expect(buildDashboardRpcArgs(TENANT, TZ, {}, NOW).p_granularity).toBe("month");
    expect(buildDashboardRpcArgs(TENANT, TZ, { quickFilter: "today" }, NOW).p_granularity).toBe("hour");
    expect(buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-09-10", dateTo: "2026-09-10" }, NOW).p_granularity).toBe("hour");
    expect(buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-09-01", dateTo: "2026-09-29" }, NOW).p_granularity).toBe("day");
    expect(buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-01-01", dateTo: "2026-09-29" }, NOW).p_granularity).toBe("month");
  });

  it("resolves Today and a From/To window in tenant-local midnights", () => {
    const today = buildDashboardRpcArgs(TENANT, TZ, { quickFilter: "today" }, NOW);
    expect(today.p_from).toBe("2026-09-28T18:30:00.000Z");
    expect(today.p_to).toBe("2026-09-29T18:30:00.000Z");
    const range = buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-09-01", dateTo: "2026-09-10" }, NOW);
    expect(range.p_from).toBe("2026-08-31T18:30:00.000Z");
    expect(range.p_to).toBe("2026-09-10T18:30:00.000Z");
  });

  it("sends no window when no date filter is set, and rejects an invalid one like /leads does", () => {
    const args = buildDashboardRpcArgs(TENANT, TZ, {}, NOW);
    expect(args.p_from).toBeNull();
    expect(args.p_to).toBeNull();
    expect(() => buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-09-10", dateTo: "2026-09-01" }, NOW)).toThrow(/valid inclusive date range/);
    expect(() => buildDashboardRpcArgs(TENANT, TZ, { dateFrom: "2026-09-10" }, NOW)).toThrow(/valid inclusive date range/);
  });

  it("passes Page, Ad, Status and Label through and maps empty to null", () => {
    const all = buildDashboardRpcArgs(TENANT, TZ, { pageRecordId: "p1", adId: "unattributed", status: "Sale", label: "Hot" }, NOW);
    expect(all).toMatchObject({ p_page_record_id: "p1", p_ad_id: "unattributed", p_status: "Sale", p_label: "Hot" });
    const none = buildDashboardRpcArgs(TENANT, TZ, {}, NOW);
    expect(none).toMatchObject({ p_page_record_id: null, p_ad_id: null, p_status: null, p_label: null, p_search: null, p_search_digits: null });
  });

});

describe("getDashboardStats", () => {
  it("scopes the aggregate to the context tenant, reusing the tenant's own timezone", async () => {
    const timezone = tenantTimezone();
    mocks.from.mockReturnValue(timezone);
    mocks.rpc.mockResolvedValue({ data: { total: 4, monthToDate: 2 }, error: null });
    const stats = await getDashboardStats({ tenantId: TENANT, userId: "u" }, { status: "Sale" });
    expect(mocks.from).toHaveBeenCalledWith("tenants");
    expect((timezone.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("tenant_id", TENANT);
    expect(mocks.rpc).toHaveBeenCalledWith("get_dashboard_stats", expect.objectContaining({ p_tenant_id: TENANT, p_status: "Sale", p_tz: TZ }));
    expect(stats).toMatchObject({ tenantId: TENANT, timezone: TZ, total: 4, monthToDate: 2 });
  });

  it("turns a database error into a generic AppError that leaks nothing", async () => {
    mocks.from.mockReturnValue(tenantTimezone());
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "relation lead_data secret detail" } });
    await expect(getDashboardStats({ tenantId: TENANT, userId: "u" }, {})).rejects.toMatchObject({ code: "DASHBOARD_STATS_FAILED", status: 500, message: "The dashboard could not be loaded." });
  });

  it("refuses to run without a verified tenant timezone", async () => {
    mocks.from.mockReturnValue(tenantTimezone("UTC"));
    await expect(getDashboardStats({ tenantId: TENANT, userId: "u" }, {})).rejects.toMatchObject({ code: "TENANT_TIMEZONE_UNAVAILABLE" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
