import type { TimelineGranularity } from "@/lib/server/dashboard-service";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Timeline buckets arrive as tenant-local wall-clock strings (YYYY-MM-DDTHH:MM:SS, no offset). They are
 * labelled straight from those digits — never through Date/timezone conversion — so a bucket can never
 * shift to the neighbouring day in the viewer's own timezone.
 */
export function formatBucketLabel(bucket: string, granularity: TimelineGranularity): string {
  const year = bucket.slice(0, 4);
  const month = MONTHS[Number(bucket.slice(5, 7)) - 1] ?? "";
  const day = Number(bucket.slice(8, 10));
  if (granularity === "month") return `${month} ${year}`;
  if (granularity === "day") return `${day} ${month}`;
  const hour = Number(bucket.slice(11, 13));
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

/** Long form for tooltips, e.g. "12 Sep 2026" / "Sep 2026" / "12 Sep 2026, 3 PM". */
export function formatBucketTooltip(bucket: string, granularity: TimelineGranularity): string {
  const year = bucket.slice(0, 4);
  const month = MONTHS[Number(bucket.slice(5, 7)) - 1] ?? "";
  const day = Number(bucket.slice(8, 10));
  if (granularity === "month") return `${month} ${year}`;
  if (granularity === "day") return `${day} ${month} ${year}`;
  return `${day} ${month} ${year}, ${formatBucketLabel(bucket, "hour")}`;
}

export interface Delta {
  direction: "up" | "down" | "flat" | "new" | "none";
  text: string;
}

/** "vs last month, same period" comparison for the This Month card. */
export function describeDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    return current === 0 ? { direction: "none", text: "No leads yet this month or last" } : { direction: "new", text: "No leads in the same period last month" };
  }
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { direction: "flat", text: "Same as last month so far" };
  return { direction: change > 0 ? "up" : "down", text: `${Math.abs(change)}% ${change > 0 ? "more" : "fewer"} than the same period last month` };
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-IN");
}

export interface RankedStatus { status: string; count: number; share: number }

/**
 * Status breakdown for the ranked chart: every status (the RPC zero-fills all 13), biggest first, so
 * statuses with 0 leads sit at the bottom. Ties keep the order the RPC sends (the LEAD_STATUSES order),
 * so rows don't reshuffle between identical refreshes. `share` is a whole-number percentage of all
 * leads in view.
 */
export function rankStatuses(byStatus: Array<{ status: string; count: number }>): RankedStatus[] {
  const total = byStatus.reduce((sum, item) => sum + item.count, 0);
  return byStatus
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ status, count }) => ({ status, count, share: total ? Math.round((count / total) * 100) : 0 }));
}

/** The non-ranked rows get_dashboard_platform_stats adds to topItems: totals, not a ranked item. */
const CATCH_ALL_ITEM_IDS = new Set(["other", "unattributed"]);

export type TopItem = { id: string; name: string | null; count: number };

/**
 * A ranked item's bar label. With `idSuffix` (Facebook ads) it is "Name pending (1234)", the same wording the
 * Ad filter dropdown uses; without it (Google ad groups, whose name already falls back to the id) the name alone.
 */
export function itemLabel(item: Pick<TopItem, "id" | "name">, idSuffix: boolean): string {
  if (CATCH_ALL_ITEM_IDS.has(item.id)) return item.name ?? item.id;
  return idSuffix ? `${item.name ?? "Name pending"} (${item.id.slice(-4)})` : item.name ?? "Name pending";
}

/** Theme colours live in globals.css (--chart-*) so light and dark each get a tuned palette. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)"];

export interface ItemBar { name: string; count: number; color: string }

/**
 * Colours for ranked items, rank 1 first: the seven vivid palette colours plus lime for rank 8. The
 * palette's own eighth colour is grey, which would look like the grey catch-all rows, so it is skipped.
 */
const ITEM_COLORS = [...CHART_COLORS.slice(0, 7), "var(--status-12)"];

/**
 * Top-items rows (ads, ad groups), each ranked item in its own colour so the bars can be told apart. The
 * database returns at most 8 ranked items (get_dashboard_platform_stats), so colours never repeat. The "Other"
 * and "Unattributed" catch-all rows are neutral grey: they are totals, not a ranked item, so they never borrow
 * an item's colour.
 */
export function itemBarData(items: TopItem[], idSuffix: boolean): ItemBar[] {
  let rank = 0;
  return items.map((item) => {
    const isCatchAll = CATCH_ALL_ITEM_IDS.has(item.id);
    return { name: itemLabel(item, idSuffix), count: item.count, color: isCatchAll ? "var(--chart-muted)" : ITEM_COLORS[rank++ % ITEM_COLORS.length] };
  });
}
