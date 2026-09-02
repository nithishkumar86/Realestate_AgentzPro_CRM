"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, Notice, PageHeader, SkeletonRows } from "@/components/ui";
import { type DashboardData } from "@/lib/types";
import { getDashboardData } from "@/services/crm-data-service";

const donutColors = ["#1f6feb", "#16823a", "#b45309", "#7c3aed"];

export function DashboardPageClient() {
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      try {
        setIsLoading(true);
        const data = await getDashboardData();
        if (isMounted) {
          setDashboardData(data);
        }
      } catch {
        if (isMounted) {
          setErrorMessage("Dashboard could not be loaded. Try again.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadDashboard();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <div className="stack">
      <PageHeader title="Dashboard" description="Track lead volume and this-month Page distribution." />

      <Notice
        tone="warning"
        title="Facebook connection requires attention. New leads may not be received."
        action={<Link className="button button--secondary" href="/connection">Reconnect Facebook</Link>}
      />

      {errorMessage ? <Notice tone="danger" title={errorMessage} /> : null}
      {isLoading ? <SkeletonRows count={4} /> : null}

      {!isLoading && dashboardData ? (
        <>
          <section className="grid-3" aria-label="Summary cards">
            <MetricCard title="Leads Today" value={dashboardData.counts.today} href="/leads" />
            <MetricCard title="Leads This Month" value={dashboardData.counts.month} href="/leads" />
            <MetricCard title="All Leads" value={dashboardData.counts.all} href="/leads" />
          </section>

          {dashboardData.counts.all === 0 ? (
            <EmptyState title="No leads available" description="Dashboard charts appear after leads are received." />
          ) : (
            <section className="grid-2">
              <MonthlyBarChart data={dashboardData.monthlyTotals} />
              <PageDonutChart data={dashboardData.pageDistribution} />
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function MetricCard({ title, value, href }: { title: string; value: number; href: string }) {
  return (
    <Link className="metric-card" href={href}>
      <span>{title}</span>
      <strong>{value.toLocaleString("en-IN")}</strong>
    </Link>
  );
}

function MonthlyBarChart({ data }: { data: DashboardData["monthlyTotals"] }) {
  const maxCount = Math.max(...data.map((item) => item.count), 1);

  return (
    <section className="panel">
      <div className="panel__body">
        <div className="section-title">
          <div>
            <h2>Monthly lead volume</h2>
            <p>Latest six months</p>
          </div>
        </div>
        <div className="bar-chart" role="img" aria-label="Monthly lead totals for the latest six months">
          {data.map((item) => (
            <div className="bar-chart__item" key={item.month} title={`${item.month}: ${item.count} leads`}>
              <div
                className={item.isCurrent ? "bar-chart__bar bar-chart__bar--current" : "bar-chart__bar"}
                style={{ height: `${Math.max((item.count / maxCount) * 190, 8)}px` }}
                aria-label={`${item.month}: ${item.count} leads`}
              />
              <span className="bar-chart__label">{item.month}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PageDonutChart({ data }: { data: DashboardData["pageDistribution"] }) {
  const total = data.reduce((sum, item) => sum + item.count, 0);
  const background = useMemo(() => {
    if (total === 0) {
      return "#eef1f6";
    }

    let cursor = 0;
    const segments = data.map((item, index) => {
      const start = cursor;
      const end = cursor + (item.count / total) * 100;
      cursor = end;
      return `${donutColors[index % donutColors.length]} ${start}% ${end}%`;
    });

    return `conic-gradient(${segments.join(", ")})`;
  }, [data, total]);

  return (
    <section className="panel">
      <div className="panel__body">
        <div className="section-title">
          <div>
            <h2>Page distribution</h2>
            <p>This month</p>
          </div>
        </div>
        <div className="donut-wrap">
          <div className="donut" style={{ background }} role="img" aria-label={`This month total ${total} leads`}>
            <div className="donut__center">
              <span>Total</span>
              <strong>{total}</strong>
            </div>
          </div>
          <div className="legend">
            {data.map((item, index) => (
              <div className="legend__item" key={item.pageName}>
                <span className="legend__swatch" style={{ background: donutColors[index % donutColors.length] }} />
                <span>{item.pageName}</span>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
