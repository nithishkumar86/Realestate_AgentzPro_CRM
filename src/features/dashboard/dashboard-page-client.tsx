"use client";

import { ArrowDownRight, ArrowUpRight, Minus, Radio } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, Notice, PageHeader, SkeletonRows } from "@/components/ui";
import { DashboardReportHeader, DownloadDashboardButton } from "@/features/dashboard/dashboard-download";
import { DonutChart, HorizontalBarChart, StatusRankChart, TimelineChart, groupDonutData, labelDonutData } from "@/features/dashboard/dashboard-charts";
import { describeDelta, formatCount, itemBarData } from "@/features/dashboard/dashboard-format";
import { DASHBOARD_PLATFORMS, getDashboardPlatform, resolveDashboardPlatform, type DashboardPlatform, type DashboardPlatformId } from "@/features/dashboard/dashboard-platforms";
import { PlatformSwitcher } from "@/features/dashboard/platform-switcher";
import { useDashboardStats, type LiveState } from "@/features/dashboard/use-dashboard-live";
import { LeadActiveFilters, LeadFilterBar } from "@/features/leads/lead-filters";
import { GOOGLE_CAMPAIGN_ID_PATTERN } from "@/features/leads/lead-options";
import { useLeadFilters } from "@/features/leads/use-lead-filters";
import { useLeadSources, type ConnectionHealth } from "@/features/leads/use-lead-sources";
import { getConnectionOverview, getCustomWebhookOverview, getGoogleAdsOverview } from "@/services/crm-api-client";

const LIVE_TEXT: Record<LiveState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Live · refreshing every 15s",
};

const DESCRIPTION = "Live lead analytics for your company, one platform at a time. Filters work exactly like the Leads page.";

/** "Page, Ad, Status and Label" for Facebook, "Campaign, Status and Label" for Google Ads, "Status and Label" otherwise. */
function filterNames(platform: DashboardPlatform): string {
  return [...(platform.filters.page ? ["Page"] : []), ...(platform.filters.ad ? ["Ad"] : []), ...(platform.filters.campaign ? ["Campaign"] : []), "Status", "Label"].join(", ").replace(/, (?=[^,]*$)/, " and ");
}

/**
 * The dashboard offers only the platforms this company uses (Telecaller always; Facebook and Google Ads once
 * connected). Until that is known it shows a loader and asks for no numbers, so a new company never sees an empty
 * Facebook view first. `initialPlatform` is the `?platform=` the URL asked for; one the company doesn't use opens
 * the company's first platform instead.
 */
export function DashboardPageClient({ initialPlatform }: { initialPlatform?: DashboardPlatformId }) {
  const { sources, health } = useLeadSources();
  if (!sources) {
    return <div className="dash">
      <PageHeader title="Dashboard" description={DESCRIPTION} />
      <SkeletonRows count={4} />
    </div>;
  }
  const platforms = DASHBOARD_PLATFORMS.filter((platform) => sources.includes(platform.id));
  return <DashboardView platforms={platforms} initialPlatform={resolveDashboardPlatform(initialPlatform, platforms)} initialHealth={health} />;
}

/**
 * The dashboard shows ONE lead platform at a time, picked with the "Leads" switch at the top right (the company's
 * first platform by default). The platform lives in its own state and in the URL (?platform=google_ads), never in
 * useLeadFilters, so "Clear all" and the filter chips can't change it and a reload or a shared link opens the same
 * view. Everything that differs per platform (breakdowns, which filters apply, which connection to watch) comes from
 * DASHBOARD_PLATFORMS.
 */
function DashboardView({ platforms, initialPlatform, initialHealth }: { platforms: readonly DashboardPlatform[]; initialPlatform: DashboardPlatformId; initialHealth: ConnectionHealth }) {
  const defaultPlatform = platforms[0].id;
  const [platformId, setPlatformId] = useState<DashboardPlatformId>(initialPlatform);
  const platform = getDashboardPlatform(platformId);
  // Starts with the checks useLeadSources already made, so the effect below asks again only for one that failed.
  const [health, setHealth] = useState<ConnectionHealth>(initialHealth);
  const [filterError, setFilterError] = useState<string | null>(null);
  // An aggregate view opens on ALL ads: pre-selecting one ad (as /leads does) would silently narrow every number.
  const filters = useLeadFilters({ autoSelectDefaultAd: false, onError: setFilterError });

  // Page, Ad and Campaign are sent only for a platform that has them; switching platform also clears them (see
  // switchPlatform).
  const { pageRecordId, adId, campaignId, ...commonFilters } = filters.filterBody();
  const body = {
    ...commonFilters,
    ...(platform.filters.page && pageRecordId ? { pageRecordId } : {}),
    ...(platform.filters.ad && adId ? { adId } : {}),
    ...(platform.filters.campaign && campaignId ? { campaignId } : {}),
    platform: platformId,
  };
  const { stats: latestStats, isFetching, error, liveState, lastUpdated, refresh } = useDashboardStats(body);
  // Right after a switch the last response is still the previous platform's: show the loader, never those numbers
  // under the new platform's name.
  const stats = latestStats?.platform === platformId ? latestStats : null;

  // Live updates add and delete leads, so the Campaign filter's choices can go stale. The "Leads by campaign" chart and
  // the choices use the same campaign key (coalesce(google_campaign_id, lead_ad_ref), "unattributed" when none):
  // - the chart names a campaign the choices lack → a lead brought it → reload;
  // - with no other filter narrowing the chart, it lists exactly every campaign, so a choice it lacks was deleted → reload.
  // In normal use the two agree and nothing reloads (at most one extra reload in the moment a filter changes before
  // the new numbers arrive; the check is skipped while numbers are loading).
  const { reloadOptions } = filters;
  const { campaigns, hasUnattributedCampaign, campaignsUnavailable } = filters.options;
  // An id the choices never offer (not 1–30 digits, see useLeadFilters) is left out, so it cannot cause a reload every update.
  const chartKeys = new Set((stats?.byGroup ?? []).flatMap((group) => group.id == null ? ["unattributed"] : GOOGLE_CAMPAIGN_ID_PATTERN.test(group.id) ? [group.id] : []));
  const choiceKeys = new Set([...campaigns.map((campaign) => campaign.id), ...(hasUnattributedCampaign ? ["unattributed"] : [])]);
  const chartIsUnfiltered = !filters.campaignId && !filters.status && !filters.label && !filters.from && filters.quick === "All Leads";
  const campaignChoicesStale = Boolean(platform.filters.campaign && stats && !isFetching && filters.optionsLoaded && !campaignsUnavailable
    && ([...chartKeys].some((key) => !choiceKeys.has(key)) || (chartIsUnfiltered && [...choiceKeys].some((key) => !chartKeys.has(key)))));
  useEffect(() => { if (campaignChoicesStale) reloadOptions(); }, [campaignChoicesStale, lastUpdated, reloadOptions]);

  // Each connection's health is loaded the first time a platform that depends on it is shown. It is skipped only once
  // it has LOADED (not once it was requested), so React Strict Mode's mount → unmount → mount still shows the warning.
  const healthLoaded = platform.connection === "meta" ? health.meta !== null
    : platform.connection === "google" ? health.google !== null
      : platform.connection === "webhook" ? health.webhook !== null : true;
  useEffect(() => {
    const connection = platform.connection;
    if (!connection || healthLoaded) return;
    let isMounted = true;
    const load = connection === "meta"
      ? getConnectionOverview().then((overview) => { if (isMounted) setHealth((current) => ({ ...current, meta: overview.connectionStatus })); })
      : connection === "google"
        ? getGoogleAdsOverview().then((overview) => { if (isMounted) setHealth((current) => ({ ...current, google: { hasWebhook: overview.hasWebhook, webhookStopped: overview.webhookStopped, needsReconnect: overview.needsReconnect } })); })
        : getCustomWebhookOverview().then((overview) => { if (isMounted) setHealth((current) => ({ ...current, webhook: { hasWebhook: overview.hasWebhook, webhookStopped: overview.webhookStopped } })); });
    // Connection health is best-effort; leave the warning hidden if it can't be loaded (showing the platform again retries).
    void load.catch(() => {});
    return () => { isMounted = false; };
  }, [platform.connection, healthLoaded]);

  const writePlatformToUrl = (next: DashboardPlatformId) => {
    const url = new URL(window.location.href);
    if (next === defaultPlatform) url.searchParams.delete("platform");
    else url.searchParams.set("platform", next);
    window.history.replaceState(null, "", url);
  };

  // A link to a platform this company doesn't use opened the first platform instead: make the URL say so. Writing the
  // URL that is already there changes nothing, so this simply runs once on open.
  useEffect(() => {
    writePlatformToUrl(initialPlatform);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the URL the page opened with is corrected
  }, []);

  function switchPlatform(next: DashboardPlatformId) {
    setPlatformId(next);
    filters.clearPage();
    filters.setCampaignId("");
    writePlatformToUrl(next);
  }

  const delta = stats ? describeDelta(stats.monthToDate, stats.previousMonthSamePeriod) : null;

  return (
    <div className="dash">
      <PageHeader title="Dashboard" description={DESCRIPTION}
        actions={<div className="dash-header-actions">
          <PlatformSwitcher value={platformId} platforms={platforms} onChange={switchPlatform} />
          <DownloadDashboardButton platformLabel={platform.label} timezone={stats?.timezone} dataUpdatedAt={lastUpdated} disabled={!stats} />
        </div>} />
      <DashboardReportHeader platformLabel={platform.label} lastUpdated={lastUpdated} timezone={latestStats?.timezone} hasFilters={filters.hasActiveFilters} />

      <ConnectionNotice platform={platform} health={health} />

      {/* On Google Ads, Page and Ad stay on screen greyed out (Facebook only) and Campaign is added, as on the Leads page. */}
      <LeadFilterBar filters={filters} showSearch={false} showQuickToggle={false}
        showPage={platform.filters.page || platform.filters.campaign} showAd={platform.filters.ad || platform.filters.campaign}
        showCampaign={platform.filters.campaign} pageAdDisabled={platform.filters.campaign} />
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
  if (platform.connection === "google" && health.google?.webhookStopped) {
    return <Notice tone="warning" title="Google Ads leads are disconnected. New Google Ads leads are not received."
      action={<Link className="button button--secondary" href="/connection">Reconnect Google Ads</Link>} />;
  }
  if (platform.connection === "google" && health.google && !health.google.hasWebhook) {
    return <Notice tone="warning" title="Google Ads is not set up yet. Google Ads leads are not received."
      action={<Link className="button button--secondary" href="/connection">Set up Google Ads</Link>} />;
  }
  if (platform.connection === "google" && health.google?.needsReconnect) {
    return <Notice tone="warning" title="Google Ads sign-in needs attention. Campaign and ad group names may not update."
      action={<Link className="button button--secondary" href="/connection">Reconnect Google Ads</Link>} />;
  }
  if (platform.connection === "webhook" && health.webhook?.webhookStopped) {
    return <Notice tone="warning" title="Webhook is stopped. New webhook leads are refused."
      action={<Link className="button button--secondary" href="/connection">Open Connection</Link>} />;
  }
  return null;
}
