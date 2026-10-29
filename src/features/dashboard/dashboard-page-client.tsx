"use client";

import { ArrowDownRight, ArrowUpRight, Minus, Radio } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EmptyState, Notice, PageHeader, SkeletonRows } from "@/components/ui";
import { DonutChart, HorizontalBarChart, StatusRankChart, TimelineChart, groupDonutData, labelDonutData } from "@/features/dashboard/dashboard-charts";
import { describeDelta, formatCount, itemBarData } from "@/features/dashboard/dashboard-format";
import { DEFAULT_DASHBOARD_PLATFORM, getDashboardPlatform, type DashboardPlatform, type DashboardPlatformId } from "@/features/dashboard/dashboard-platforms";
import { PlatformSwitcher } from "@/features/dashboard/platform-switcher";
import { useDashboardStats, type LiveState } from "@/features/dashboard/use-dashboard-live";
import { LeadActiveFilters, LeadFilterBar } from "@/features/leads/lead-filters";
import { useLeadFilters } from "@/features/leads/use-lead-filters";
import { type ConnectionStatus } from "@/lib/types";
import { getConnectionOverview, getGoogleAdsOverview } from "@/services/crm-api-client";

const LIVE_TEXT: Record<LiveState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Live · refreshing every 15s",
};

type ConnectionHealth = { meta: ConnectionStatus | "not_connected" | null; google: { hasWebhook: boolean; needsReconnect: boolean } | null };

/** "Page, Ad, Status and Label" for Facebook, "Status and Label" where Page and Ad do not apply. */
function filterNames(platform: DashboardPlatform): string {
  return [...(platform.filters.page ? ["Page"] : []), ...(platform.filters.ad ? ["Ad"] : []), "Status", "Label"].join(", ").replace(/, (?=[^,]*$)/, " and ");
}

/**
 * The dashboard shows ONE lead platform at a time, picked with the "Leads" switch at the top right (Facebook by
 * default). The platform lives in its own state and in the URL (?platform=google_ads), never in useLeadFilters, so
 * "Clear all" and the filter chips can't change it and a reload or a shared link opens the same view. Everything
 * that differs per platform (breakdowns, which filters apply, which connection to watch) comes from
 * DASHBOARD_PLATFORMS.
 */
export function DashboardPageClient({ initialPlatform = DEFAULT_DASHBOARD_PLATFORM }: { initialPlatform?: DashboardPlatformId }) {
  const [platformId, setPlatformId] = useState<DashboardPlatformId>(initialPlatform);
  const platform = getDashboardPlatform(platformId);
  const [health, setHealth] = useState<ConnectionHealth>({ meta: null, google: null });
  const [filterError, setFilterError] = useState<string | null>(null);
  // An aggregate view opens on ALL ads: pre-selecting one ad (as /leads does) would silently narrow every number.
  const filters = useLeadFilters({ autoSelectDefaultAd: false, onError: setFilterError });

  // Page and Ad are sent only for a platform that has them; switching platform also clears them (see switchPlatform).
  const { pageRecordId, adId, ...commonFilters } = filters.filterBody();
  const body = {
    ...commonFilters,
    ...(platform.filters.page && pageRecordId ? { pageRecordId } : {}),
    ...(platform.filters.ad && adId ? { adId } : {}),
    platform: platformId,
  };
  const { stats: latestStats, isFetching, error, liveState, lastUpdated, refresh } = useDashboardStats(body);
  // Right after a switch the last response is still the previous platform's: show the loader, never those numbers
  // under the new platform's name.
  const stats = latestStats?.platform === platformId ? latestStats : null;

  // Each connection's health is loaded once, the first time a platform that depends on it is shown.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const connection = platform.connection;
    if (!connection || requested.current.has(connection)) return;
    requested.current.add(connection);
    let isMounted = true;
    const load = connection === "meta"
      ? getConnectionOverview().then((overview) => { if (isMounted) setHealth((current) => ({ ...current, meta: overview.connectionStatus })); })
      : getGoogleAdsOverview().then((overview) => { if (isMounted) setHealth((current) => ({ ...current, google: { hasWebhook: overview.hasWebhook, needsReconnect: overview.needsReconnect } })); });
    // Connection health is best-effort; leave the warning hidden if it can't be loaded.
    void load.catch(() => { requested.current.delete(connection); });
    return () => { isMounted = false; };
  }, [platform.connection]);

  function switchPlatform(next: DashboardPlatformId) {
    setPlatformId(next);
    filters.clearPage();
    const url = new URL(window.location.href);
    if (next === DEFAULT_DASHBOARD_PLATFORM) url.searchParams.delete("platform");
    else url.searchParams.set("platform", next);
    window.history.replaceState(null, "", url);
  }

  const delta = stats ? describeDelta(stats.monthToDate, stats.previousMonthSamePeriod) : null;

  return (
    <div className="dash">
      <PageHeader title="Dashboard" description="Live lead analytics for your company, one platform at a time. Filters work exactly like the Leads page."
        actions={<PlatformSwitcher value={platformId} onChange={switchPlatform} />} />

      <ConnectionNotice platform={platform} health={health} />

      <LeadFilterBar filters={filters} showSearch={false} showQuickToggle={false} showPage={platform.filters.page} showAd={platform.filters.ad} />
      {filterError ? <div className="mvp-inline-error">{filterError}</div> : null}
      <LeadActiveFilters filters={filters} />

      <div className="dash-status" aria-live="polite">
        <span className={`dash-live dash-live--${liveState}`}><Radio size={14} aria-hidden="true" />{LIVE_TEXT[liveState]}</span>
        {lastUpdated ? <span className="dash-status__time">Updated {lastUpdated.toLocaleTimeString("en-IN", { timeZone: latestStats?.timezone })}</span> : null}
      </div>

      {error ? <Notice tone="danger" title={error} action={<button type="button" className="button button--secondary" onClick={() => void refresh()}>Retry</button>} /> : null}
      {!stats && (isFetching || !error) ? <SkeletonRows count={4} /> : null}

      {stats ? (
        <div className={`dash-body${isFetching ? " dash-body--refreshing" : ""}`}>
          <section className="dash-hero" aria-label="This month">
            <div className="dash-hero__label">This Month {platform.label} Leads</div>
            <div className="dash-hero__value" data-testid="month-leads">{formatCount(stats.monthToDate)}</div>
            {delta ? <div className={`dash-hero__delta dash-hero__delta--${delta.direction}`}>
              {delta.direction === "up" ? <ArrowUpRight size={16} aria-hidden="true" /> : delta.direction === "down" ? <ArrowDownRight size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}
              <span>{delta.text}</span>
            </div> : null}
            <div className="dash-hero__note">Current month in your company timezone. {platform.label} leads only. Follows the {filterNames(platform)} filters.</div>
          </section>

          {stats.total === 0 ? (
            <EmptyState title={platform.emptyState.title} description={platform.emptyState.description} />
          ) : (
            <>
              <section className="dash-panel dash-panel--wide">
                <header className="dash-panel__head">
                  <div><h2>Leads over time</h2><p>{stats.granularity === "hour" ? "By hour" : stats.granularity === "day" ? "By day" : "By month"}{stats.timelineTruncated ? " · last 24 months" : ""}</p></div>
                  <div className="dash-panel__stat"><strong>{formatCount(stats.total)}</strong><span>leads in view</span></div>
                </header>
                <TimelineChart data={stats.timeline} granularity={stats.granularity} />
              </section>

              <div className="dash-grid">
                {platform.group ? <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>{platform.group.title}</h2><p>{platform.group.subtitle}</p></div></header>
                  <DonutChart data={groupDonutData(stats.byGroup)} ariaLabel={platform.group.ariaLabel} />
                </section> : null}
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Leads by label</h2><p>Hot, Warm, Cold and Not Interested</p></div></header>
                  <DonutChart data={labelDonutData(stats.byLabel)} ariaLabel="Leads by label" />
                </section>
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Leads by status</h2><p>Where leads are in your pipeline</p></div></header>
                  <StatusRankChart data={stats.byStatus} ariaLabel="Leads by status" />
                </section>
                {platform.items ? <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>{platform.items.title}</h2><p>{platform.items.subtitle}</p></div></header>
                  <HorizontalBarChart data={itemBarData(stats.topItems, platform.items.idSuffix)} ariaLabel={platform.items.ariaLabel} />
                </section> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The warning for the selected platform's connection only: a Google problem never shows on the Facebook view. */
function ConnectionNotice({ platform, health }: { platform: DashboardPlatform; health: ConnectionHealth }) {
  if (platform.connection === "meta" && (health.meta === "disconnected" || health.meta === "reauthorization_required")) {
    return <Notice tone="warning" title="Facebook connection requires attention. New leads may not be received."
      action={<Link className="button button--secondary" href="/connection">Reconnect Facebook</Link>} />;
  }
  if (platform.connection === "google" && health.google && !health.google.hasWebhook) {
    return <Notice tone="warning" title="Google Ads is not set up yet. Google Ads leads are not received."
      action={<Link className="button button--secondary" href="/connection">Set up Google Ads</Link>} />;
  }
  if (platform.connection === "google" && health.google?.needsReconnect) {
    return <Notice tone="warning" title="Google Ads sign-in needs attention. Campaign and ad group names may not update."
      action={<Link className="button button--secondary" href="/connection">Reconnect Google Ads</Link>} />;
  }
  return null;
}
