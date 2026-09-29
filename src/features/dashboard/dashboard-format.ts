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

/** "Name pending (1234)" — the same wording the Ad filter dropdown uses. */
export function adLabel(ad: { adId: string; name: string | null }): string {
  if (ad.adId === "other" || ad.adId === "unattributed") return ad.name ?? ad.adId;
  return `${ad.name ?? "Name pending"} (${ad.adId.slice(-4)})`;
}
