import { describe, expect, it } from "vitest";
import { adBarData, adLabel, CHART_COLORS, describeDelta, formatBucketLabel, formatBucketTooltip, formatCount, rankStatuses } from "@/features/dashboard/dashboard-format";

describe("adBarData", () => {
  const ads = (count: number) => Array.from({ length: count }, (_, i) => ({ adId: `630${i}-ad${i}`, name: `Ad ${i}`, count: 10 - i }));

  it("gives every ranked ad its own colour, in rank order, with the same label as the Ad filter", () => {
    const bars = adBarData(ads(5));
    expect(bars.map((bar) => bar.color)).toEqual(CHART_COLORS.slice(0, 5));
    expect(new Set(bars.map((bar) => bar.color)).size).toBe(5);
    expect(bars[0]).toEqual({ name: adLabel(ads(1)[0]!), count: 10, color: CHART_COLORS[0] });
  });

  it("colours the Other and Unattributed catch-all rows grey and never spends a palette colour on them", () => {
    const bars = adBarData([
      { adId: "6301-a", name: "A", count: 5 },
      { adId: "other", name: "Other", count: 4 },
      { adId: "6302-b", name: "B", count: 3 },
      { adId: "unattributed", name: "Unattributed", count: 2 },
    ]);
    expect(bars.map((bar) => bar.color)).toEqual([CHART_COLORS[0], "var(--chart-muted)", CHART_COLORS[1], "var(--chart-muted)"]);
  });

  it("keeps all 8 possible ranked ads distinct and never grey, and handles no ads", () => {
    const bars = adBarData(ads(8));
    expect(new Set(bars.map((bar) => bar.color)).size).toBe(8);
    expect(bars.map((bar) => bar.color)).not.toContain("var(--chart-8)");
    expect(bars.map((bar) => bar.color)).not.toContain("var(--chart-muted)");
    expect(adBarData([])).toEqual([]);
  });
});

describe("rankStatuses", () => {
  it("keeps every status, biggest first, zero statuses last, with whole-number shares of all leads in view", () => {
    const rows = rankStatuses([
      { status: "New Lead", count: 2 }, { status: "Archived", count: 0 }, { status: "Sale", count: 3 },
      { status: "Working", count: 2 }, { status: "Closed", count: 1 }, { status: "Disqualified", count: 0 },
    ]);
    expect(rows).toEqual([
      { status: "Sale", count: 3, share: 38 },
      { status: "New Lead", count: 2, share: 25 }, // ties keep the incoming (LEAD_STATUSES) order
      { status: "Working", count: 2, share: 25 },
      { status: "Closed", count: 1, share: 13 },
      { status: "Archived", count: 0, share: 0 },
      { status: "Disqualified", count: 0, share: 0 },
    ]);
  });

  it("gives one status 100% when a Status filter is on, and 0% (no division by zero) when empty", () => {
    expect(rankStatuses([{ status: "Working", count: 0 }, { status: "Sale", count: 2 }])).toEqual([
      { status: "Sale", count: 2, share: 100 }, { status: "Working", count: 0, share: 0 },
    ]);
    expect(rankStatuses([{ status: "Sale", count: 0 }])).toEqual([{ status: "Sale", count: 0, share: 0 }]);
  });
});

describe("timeline bucket labels", () => {
  it("labels straight from the tenant-local digits, whatever timezone the browser is in", () => {
    expect(formatBucketLabel("2026-09-01T00:00:00", "day")).toBe("1 Sep");
    expect(formatBucketLabel("2026-09-01T00:00:00", "month")).toBe("Sep 2026");
    expect(formatBucketTooltip("2026-09-30T00:00:00", "day")).toBe("30 Sep 2026");
    expect(formatBucketTooltip("2026-09-01T00:00:00", "month")).toBe("Sep 2026");
  });

  it("formats hourly buckets on a 12-hour clock", () => {
    expect(formatBucketLabel("2026-09-29T00:00:00", "hour")).toBe("12 AM");
    expect(formatBucketLabel("2026-09-29T09:00:00", "hour")).toBe("9 AM");
    expect(formatBucketLabel("2026-09-29T12:00:00", "hour")).toBe("12 PM");
    expect(formatBucketLabel("2026-09-29T23:00:00", "hour")).toBe("11 PM");
    expect(formatBucketTooltip("2026-09-29T15:00:00", "hour")).toBe("29 Sep 2026, 3 PM");
  });
});

describe("month-over-month delta", () => {
  it("describes growth, decline and no change", () => {
    expect(describeDelta(15, 10)).toEqual({ direction: "up", text: "50% more than the same period last month" });
    expect(describeDelta(5, 10)).toEqual({ direction: "down", text: "50% fewer than the same period last month" });
    expect(describeDelta(10, 10).direction).toBe("flat");
  });

  it("never divides by zero", () => {
    expect(describeDelta(4, 0).direction).toBe("new");
    expect(describeDelta(0, 0).direction).toBe("none");
  });
});

describe("display helpers", () => {
  it("formats counts in the Indian grouping used elsewhere in the CRM", () => {
    expect(formatCount(1234567)).toBe("12,34,567");
  });

  it("names ads the way the Ad filter does", () => {
    expect(adLabel({ adId: "6301-karuvi", name: "karuvi" })).toBe("karuvi (ruvi)");
    expect(adLabel({ adId: "6302-aruvi", name: null })).toBe("Name pending (ruvi)");
    expect(adLabel({ adId: "other", name: "Other" })).toBe("Other");
    expect(adLabel({ adId: "unattributed", name: "Unattributed" })).toBe("Unattributed");
  });
});
