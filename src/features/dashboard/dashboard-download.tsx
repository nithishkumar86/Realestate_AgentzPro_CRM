"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "Download PDF" for the dashboard. It opens the browser's print window, where the globals.css print block (scoped
 * to the dashboard) turns the page into a light, A4-landscape report: no sidebar or controls, just the report header,
 * the active filter chips and every chart. The PDF is the page the user is looking at, so it only ever holds their own
 * company's numbers and it covers every platform in DASHBOARD_PLATFORMS with no per-platform code.
 */

/** `YYYY-MM-DD` in the company timezone (falls back to the browser's when the timezone is unknown or invalid). */
function localDate(date: Date, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

/** The tab title while printing; browsers use it as the saved PDF's file name. */
export function dashboardPdfTitle(platformLabel: string, date: Date, timezone?: string): string {
  return `AgentzPro Dashboard - ${platformLabel} - ${localDate(date, timezone)}`;
}

/**
 * The charts animate for ~1.9s after their numbers change (recharts: 400ms delay + 1500ms draw), and the print window
 * captures whatever frame is on screen. A click within this long of a data update waits out the rest first, so the PDF
 * never holds a half-drawn chart.
 */
export const CHART_SETTLE_MS = 2000;

export function DownloadDashboardButton({ platformLabel, timezone, dataUpdatedAt, disabled }: { platformLabel: string; timezone?: string; dataUpdatedAt: Date | null; disabled: boolean }) {
  const [preparing, setPreparing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function print() {
    setPreparing(false);
    const previousTitle = document.title;
    const restore = () => { document.title = previousTitle; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    document.title = dashboardPdfTitle(platformLabel, new Date(), timezone);
    try {
      window.print();
    } finally {
      // print() blocks until the dialog closes in most browsers; restoring here too means the title can never stay
      // changed if a browser doesn't fire afterprint.
      restore();
    }
  }

  function download() {
    const wait = dataUpdatedAt ? dataUpdatedAt.getTime() + CHART_SETTLE_MS - Date.now() : 0;
    if (wait <= 0) { print(); return; }
    setPreparing(true);
    timer.current = setTimeout(print, wait);
  }

  return <button className="mvp-gradient-button mvp-gradient-button--download dash-download" type="button" disabled={disabled || preparing}
    title={disabled ? "Available once the dashboard has loaded" : `Save this ${platformLabel} dashboard as a PDF`} onClick={download}>
    <Download size={16} aria-hidden="true" />{preparing ? "Preparing…" : "Download PDF"}
  </button>;
}

/** Shown only in the PDF (hidden on screen): what the report is, how fresh its numbers are, and the filters it follows. */
export function DashboardReportHeader({ platformLabel, lastUpdated, timezone, hasFilters }: { platformLabel: string; lastUpdated: Date | null; timezone?: string; hasFilters: boolean }) {
  let asOf: string | null = null;
  if (lastUpdated) {
    const options = { dateStyle: "medium", timeStyle: "short" } as const;
    try {
      asOf = lastUpdated.toLocaleString("en-IN", { ...options, timeZone: timezone });
    } catch {
      asOf = lastUpdated.toLocaleString("en-IN", options);
    }
  }
  return <header className="dash-report" data-testid="dash-report">
    <div className="dash-report__brand">AgentzPro CRM</div>
    <h1 className="dash-report__title">Lead Dashboard · {platformLabel} leads</h1>
    <p className="dash-report__meta">
      {asOf ? <span>Data as of {asOf}{timezone ? ` (${timezone})` : ""}</span> : null}
      {hasFilters ? null : <span>Filters: none (all leads, all time)</span>}
    </p>
  </header>;
}
