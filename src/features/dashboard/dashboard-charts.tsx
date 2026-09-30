"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardStats } from "@/lib/server/dashboard-service";
import { CHART_COLORS, formatBucketLabel, formatBucketTooltip, formatCount, rankStatuses } from "@/features/dashboard/dashboard-format";
import { LEAD_STATUSES, type LeadStatus } from "@/features/leads/lead-options";

const LABEL_COLORS: Record<string, string> = { Hot: "var(--chart-hot)", Warm: "var(--chart-warm)", Cold: "var(--chart-cold)", "Not Interested": "var(--chart-muted)" };

const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--text)", fontSize: 13 } as const;
const axisTick = { fill: "var(--text-muted)", fontSize: 12 } as const;

const GRANULARITY_UNIT = { month: "month", day: "day", hour: "hour" } as const;

/** "16 leads across 1 month" / "3 months" — singular when there is a single bucket. */
export function timelineSummary(total: number, buckets: number, granularity: DashboardStats["granularity"]): string {
  const unit = GRANULARITY_UNIT[granularity];
  return `Leads over time: ${formatCount(total)} ${total === 1 ? "lead" : "leads"} across ${buckets} ${unit}${buckets === 1 ? "" : "s"}.`;
}

/**
 * Monthly buckets are separate totals, so they are drawn as columns: a single month is one clear bar
 * (an area/line needs two points and shows only a dot) and an empty month is a visible gap. Day and hour
 * buckets are a continuous trend, so those keep the area chart.
 */
export function TimelineChart({ data, granularity }: { data: DashboardStats["timeline"]; granularity: DashboardStats["granularity"] }) {
  const rows = data.map((point) => ({ ...point, label: formatBucketLabel(point.bucket, granularity) }));
  const total = data.reduce((sum, point) => sum + point.count, 0);
  const summary = timelineSummary(total, data.length, granularity);
  const tooltipLabel = (_label: unknown, payload: ReadonlyArray<{ payload?: { bucket?: string } }>) => formatBucketTooltip(String(payload?.[0]?.payload?.bucket ?? ""), granularity);
  const tooltipValue = (value: unknown): [string, string] => [formatCount(Number(value)), "Leads"];
  if (granularity === "month") {
    return <div className="dash-chart dash-chart--timeline" role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-muted)" }} labelFormatter={tooltipLabel} formatter={tooltipValue} />
          <Bar dataKey="count" fill="var(--chart-1)" radius={[6, 6, 0, 0]} maxBarSize={48} minPointSize={0} isAnimationActive />
        </BarChart>
      </ResponsiveContainer>
    </div>;
  }
  return <div className="dash-chart dash-chart--timeline" role="img" aria-label={summary}>
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="dash-timeline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval="preserveStartEnd" minTickGap={24} />
        <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={44} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "var(--border-strong)" }} labelFormatter={tooltipLabel} formatter={tooltipValue} />
        <Area type="monotone" dataKey="count" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#dash-timeline-fill)" isAnimationActive activeDot={{ r: 5 }} />
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

export interface DonutDatum { name: string; count: number; color?: string }

/** A donut with the total in the middle and a legend that shows every value (colour is never the only cue). */
export function DonutChart({ data, ariaLabel, centerLabel = "Total" }: { data: DonutDatum[]; ariaLabel: string; centerLabel?: string }) {
  const total = data.reduce((sum, item) => sum + item.count, 0);
  const visible = data.filter((item) => item.count > 0);
  return <div className="dash-donut">
    <div className="dash-chart dash-chart--donut" role="img" aria-label={`${ariaLabel}: ${data.map((item) => `${item.name} ${item.count}`).join(", ")}.`}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={visible} dataKey="count" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={visible.length > 1 ? 2 : 0} stroke="var(--surface)" strokeWidth={2} isAnimationActive>
            {visible.map((item, index) => <Cell key={item.name} fill={item.color ?? CHART_COLORS[index % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [formatCount(Number(value)), String(name)]} />
        </PieChart>
      </ResponsiveContainer>
      <div className="dash-donut__center" aria-hidden="true"><span>{centerLabel}</span><strong>{formatCount(total)}</strong></div>
    </div>
    <ul className="dash-legend">
      {data.map((item, index) => <li key={item.name}>
        <span className="dash-legend__swatch" style={{ background: item.color ?? CHART_COLORS[index % CHART_COLORS.length] }} />
        <span className="dash-legend__name" title={item.name}>{item.name}</span>
        <strong>{formatCount(item.count)}</strong>
      </li>)}
    </ul>
  </div>;
}

export function pageDonutData(byPage: DashboardStats["byPage"]): DonutDatum[] {
  return byPage.map((page) => ({ name: page.pageName, count: page.count }));
}

export function labelDonutData(byLabel: DashboardStats["byLabel"]): DonutDatum[] {
  return byLabel.map((item) => ({ name: item.label, count: item.count, color: LABEL_COLORS[item.label] }));
}

/**
 * Ranked status bars: all 13 statuses every time, biggest first (0-lead statuses at the bottom), each
 * with its count and share. Plain HTML rather than an SVG chart so long status names wrap instead of
 * being cut off. Each status keeps the same colour whatever its rank, so a colour means the same
 * status after a filter change.
 */
export function StatusRankChart({ data, ariaLabel }: { data: DashboardStats["byStatus"]; ariaLabel: string }) {
  const rows = rankStatuses(data);
  const max = rows[0]?.count ?? 0;
  const summary = rows.map((row) => `${row.status} ${row.count} (${row.share}%)`).join(", ");
  return <div className="dash-rank">
    <ol className="dash-rank__list" aria-label={`${ariaLabel}: ${summary}.`}>
      {rows.map((row) => {
        const statusIndex = LEAD_STATUSES.indexOf(row.status as LeadStatus);
        const color = statusIndex >= 0 ? `var(--status-${statusIndex + 1})` : "var(--chart-muted)";
        return <li key={row.status} className="dash-rank__row">
          <span className="dash-rank__name">{row.status}</span>
          <span className="dash-rank__track" aria-hidden="true">
            {row.count > 0 ? <span className="dash-rank__bar" style={{ width: `${(row.count / max) * 100}%`, background: color }} /> : null}
          </span>
          <span className="dash-rank__value"><strong>{formatCount(row.count)}</strong> · {row.share}%</span>
        </li>;
      })}
    </ol>
  </div>;
}

/** `color` paints this row's bar; rows without one use the chart's `color` prop. */
export interface BarDatum { name: string; count: number; color?: string }

export function HorizontalBarChart({ data, ariaLabel, color = "var(--chart-1)", rowHeight = 34 }: { data: BarDatum[]; ariaLabel: string; color?: string; rowHeight?: number }) {
  return <div className="dash-chart" style={{ height: Math.max(data.length * rowHeight + 24, 120) }} role="img" aria-label={`${ariaLabel}: ${data.map((item) => `${item.name} ${item.count}`).join(", ")}.`}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={150} tick={axisTick} tickLine={false} axisLine={false} interval={0} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-muted)" }} formatter={(value) => [formatCount(Number(value)), "Leads"]} />
        <Bar dataKey="count" fill={color} radius={[0, 6, 6, 0]} barSize={18} isAnimationActive>
          {data.map((item, index) => <Cell key={index} fill={item.color ?? color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>;
}
