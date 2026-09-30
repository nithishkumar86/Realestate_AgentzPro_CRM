"use client";

import { ArrowDownRight, ArrowUpRight, Minus, Radio } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, Notice, PageHeader, SkeletonRows } from "@/components/ui";
import { DonutChart, HorizontalBarChart, StatusRankChart, TimelineChart, labelDonutData, pageDonutData } from "@/features/dashboard/dashboard-charts";
import { adBarData, describeDelta, formatCount } from "@/features/dashboard/dashboard-format";
import { useDashboardStats, type LiveState } from "@/features/dashboard/use-dashboard-live";
import { LeadActiveFilters, LeadFilterBar } from "@/features/leads/lead-filters";
import { useLeadFilters } from "@/features/leads/use-lead-filters";
import { type ConnectionStatus } from "@/lib/types";
import { getConnectionOverview } from "@/services/crm-api-client";

const LIVE_TEXT: Record<LiveState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Live · refreshing every 15s",
};

export function DashboardPageClient() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | "not_connected" | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  // An aggregate view opens on ALL ads: pre-selecting one ad (as /leads does) would silently narrow every number.
  const filters = useLeadFilters({ autoSelectDefaultAd: false, onError: setFilterError });
  const { stats, isFetching, error, liveState, lastUpdated, refresh } = useDashboardStats(filters.filterBody());

  useEffect(() => {
    let isMounted = true;
    void getConnectionOverview()
      .then((overview) => { if (isMounted) setConnectionStatus(overview.connectionStatus); })
      .catch(() => { /* connection status is best-effort; leave the warning hidden if it can't be loaded */ });
    return () => { isMounted = false; };
  }, []);

  const delta = stats ? describeDelta(stats.monthToDate, stats.previousMonthSamePeriod) : null;

  return (
    <div className="dash">
      <PageHeader title="Dashboard" description="Live lead analytics for your company. Filters work exactly like the Leads page." />

      {connectionStatus === "disconnected" || connectionStatus === "reauthorization_required" ? (
        <Notice
          tone="warning"
          title="Facebook connection requires attention. New leads may not be received."
          action={<Link className="button button--secondary" href="/connection">Reconnect Facebook</Link>}
        />
      ) : null}

      <LeadFilterBar filters={filters} showSearch={false} showQuickToggle={false} />
      {filterError ? <div className="mvp-inline-error">{filterError}</div> : null}
      <LeadActiveFilters filters={filters} />

      <div className="dash-status" aria-live="polite">
        <span className={`dash-live dash-live--${liveState}`}><Radio size={14} aria-hidden="true" />{LIVE_TEXT[liveState]}</span>
        {lastUpdated ? <span className="dash-status__time">Updated {lastUpdated.toLocaleTimeString("en-IN", { timeZone: stats?.timezone })}</span> : null}
      </div>

      {error ? <Notice tone="danger" title={error} action={<button type="button" className="button button--secondary" onClick={() => void refresh()}>Retry</button>} /> : null}
      {!stats && isFetching ? <SkeletonRows count={4} /> : null}

      {stats ? (
        <div className={`dash-body${isFetching ? " dash-body--refreshing" : ""}`}>
          <section className="dash-hero" aria-label="This month">
            <div className="dash-hero__label">This Month Leads</div>
            <div className="dash-hero__value" data-testid="month-leads">{formatCount(stats.monthToDate)}</div>
            {delta ? <div className={`dash-hero__delta dash-hero__delta--${delta.direction}`}>
              {delta.direction === "up" ? <ArrowUpRight size={16} aria-hidden="true" /> : delta.direction === "down" ? <ArrowDownRight size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}
              <span>{delta.text}</span>
            </div> : null}
            <div className="dash-hero__note">Current month in your company timezone. Follows the Page, Ad, Status and Label filters.</div>
          </section>

          {stats.total === 0 ? (
            <EmptyState title="No leads match these filters" description="Charts appear as soon as leads match. New leads show up here instantly." />
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
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Leads by Page</h2><p>Share of leads in view</p></div></header>
                  <DonutChart data={pageDonutData(stats.byPage)} ariaLabel="Leads by Facebook Page" />
                </section>
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Leads by label</h2><p>Hot, Warm, Cold and Not Interested</p></div></header>
                  <DonutChart data={labelDonutData(stats.byLabel)} ariaLabel="Leads by label" />
                </section>
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Leads by status</h2><p>Where leads are in your pipeline</p></div></header>
                  <StatusRankChart data={stats.byStatus} ariaLabel="Leads by status" />
                </section>
                <section className="dash-panel">
                  <header className="dash-panel__head"><div><h2>Top ads</h2><p>Highest-volume ads</p></div></header>
                  <HorizontalBarChart data={adBarData(stats.topAds)} ariaLabel="Leads by ad" />
                </section>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
