import type { LeadSource } from "@/features/leads/lead-options";

/**
 * The lead platforms the dashboard can show, one at a time, picked with the "Leads" dropdown in the header.
 * Every company sees all of them (a platform with no leads shows an empty state), so the list never needs a
 * per-company lookup.
 *
 * This is the only place that knows how platforms differ. Totals, status, label and timeline are common to
 * every platform; `group` and `items` name the platform's own breakdowns (get_dashboard_platform_stats returns
 * them as byGroup / topItems), or are null when the platform has none. `filters` says which Leads-page filters
 * make sense for it (Page and Ad are Facebook-only). `connection` is the integration whose health the page warns
 * about.
 *
 * Adding a platform: give it a lead_source (lead_data_lead_source_check + LEAD_SOURCES), add an entry here, and
 * add its branch to group_rows / item_rows in get_dashboard_platform_stats. Nothing else in the dashboard changes.
 */
export interface DashboardPlatform {
  id: LeadSource;
  label: string;
  group: { title: string; subtitle: string; ariaLabel: string } | null;
  /** `idSuffix`: show the id's last 4 digits after the name, as the Ad filter does (Facebook ads). */
  items: { title: string; subtitle: string; ariaLabel: string; idSuffix: boolean } | null;
  filters: { page: boolean; ad: boolean };
  connection: "meta" | "google" | null;
  emptyState: { title: string; description: string };
}

export const DASHBOARD_PLATFORMS = [
  {
    id: "facebook",
    label: "Facebook",
    group: { title: "Leads by Page", subtitle: "Share of leads in view", ariaLabel: "Leads by Facebook Page" },
    items: { title: "Top ads", subtitle: "Highest-volume ads", ariaLabel: "Leads by ad", idSuffix: true },
    filters: { page: true, ad: true },
    connection: "meta",
    emptyState: { title: "No Facebook leads match these filters", description: "Charts appear as soon as leads match. New leads show up here instantly." },
  },
  {
    id: "google_ads",
    label: "Google Ads",
    group: { title: "Leads by campaign", subtitle: "Share of leads in view", ariaLabel: "Leads by Google Ads campaign" },
    items: { title: "Top ad groups", subtitle: "Highest-volume ad groups", ariaLabel: "Leads by Google Ads ad group", idSuffix: false },
    filters: { page: false, ad: false },
    connection: "google",
    emptyState: { title: "No Google Ads leads match these filters", description: "Leads from your Google Ads lead forms show up here instantly once Google Ads is connected." },
  },
  {
    id: "telecaller",
    label: "Telecaller",
    group: null,
    items: null,
    filters: { page: false, ad: false },
    connection: null,
    emptyState: { title: "No call-in leads match these filters", description: "Leads your team adds with the + button on the Leads page show up here instantly." },
  },
] as const satisfies readonly DashboardPlatform[];

export type DashboardPlatformId = (typeof DASHBOARD_PLATFORMS)[number]["id"];

export const DASHBOARD_PLATFORM_IDS = DASHBOARD_PLATFORMS.map((platform) => platform.id) as [DashboardPlatformId, ...DashboardPlatformId[]];

export const DEFAULT_DASHBOARD_PLATFORM: DashboardPlatformId = "facebook";

export function getDashboardPlatform(id: DashboardPlatformId): DashboardPlatform {
  return DASHBOARD_PLATFORMS.find((platform) => platform.id === id) ?? DASHBOARD_PLATFORMS[0];
}

/** Reads a `?platform=` value. Anything missing or unknown opens the default (Facebook) view. */
export function parseDashboardPlatform(value: unknown): DashboardPlatformId {
  return DASHBOARD_PLATFORMS.some((platform) => platform.id === value) ? value as DashboardPlatformId : DEFAULT_DASHBOARD_PLATFORM;
}
