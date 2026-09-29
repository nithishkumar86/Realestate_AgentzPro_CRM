"use client";

import { useEffect, useRef, useState } from "react";
import type { LeadLabel, LeadStatus } from "@/features/leads/lead-options";

export type Quick = "All Leads" | "Today Leads" | "This Month Leads";
export type LeadFilterOptions = { pages: Array<{ id: string; name: string }>; ads: Array<{ id: string; name: string | null }>; defaultAdId: string | null };
type ApiError = { error?: { message?: string } };

export async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as ApiError | null;
  return body?.error?.message ?? fallback;
}

/**
 * The one description of a lead-filter selection, shared by /leads and /dashboard so the two pages
 * can never disagree about what "Page + Ad + Status + Label + date" means.
 *
 * `autoSelectDefaultAd` keeps the leads page's long-standing behaviour of pre-selecting the newest
 * lead's ad. The dashboard turns it off: an aggregate view must open on ALL ads, otherwise every
 * total and chart would be silently narrowed to one ad.
 */
export function useLeadFilters({ autoSelectDefaultAd, onError }: { autoSelectDefaultAd: boolean; onError?: (message: string) => void }) {
  const [options, setOptions] = useState<LeadFilterOptions>({ pages: [], ads: [], defaultAdId: null });
  const [pageRecordId, setPageRecordId] = useState("");
  const [adId, setAdId] = useState("");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Quick>("All Leads");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [label, setLabel] = useState<LeadLabel | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

  useEffect(() => {
    let active = true;
    async function loadOptions() {
      try {
        const response = await fetch(`/api/leads/filters${pageRecordId ? `?pageRecordId=${encodeURIComponent(pageRecordId)}` : ""}`);
        if (!response.ok) throw new Error(await readError(response, "Lead filters could not be loaded."));
        const next = await response.json() as LeadFilterOptions;
        if (!active) return;
        setOptions(next);
        setAdId((current) => next.ads.some((ad) => ad.id === current) || current === "unattributed" ? current : autoSelectDefaultAd ? next.defaultAdId ?? "" : "");
      } catch (cause) { if (active) onErrorRef.current?.(cause instanceof Error ? cause.message : "Lead filters could not be loaded."); }
    }
    void loadOptions();
    return () => { active = false; };
  }, [pageRecordId, autoSelectDefaultAd]);

  /**
   * What the user has filtered to — one filter or several combined. The leads table adds its own page
   * size on top; the export and the dashboard stats send exactly this, so a download or a chart can
   * never disagree with the rows on screen.
   */
  const filterBody = () => ({
    quickFilter: quick === "Today Leads" ? "today" : quick === "This Month Leads" ? "month" : "all",
    ...(status ? { status } : {}), ...(label ? { label } : {}),
    ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}),
    ...(pageRecordId ? { pageRecordId } : {}), ...(adId ? { adId } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const reset = () => { setPageRecordId(""); setAdId(""); setSearch(""); setQuick("All Leads"); setStatus(""); setLabel(""); setFrom(""); setTo(""); };
  /**
   * Today's Leads and a From/To range are two ways of naming the same thing — a date window — and
   * the query service resolves that collision by letting the quick range win (see resolveDateRange).
   * Showing both at once therefore left a From/To chip on screen that silently filtered nothing.
   * So the two are mutually exclusive here: switching one on clears the other, exactly one date
   * filter is ever active, and the chips always name the rows you get.
   */
  const toggleQuickRange = () => {
    const next: Quick = quick === "All Leads" ? "Today Leads" : "All Leads";
    setQuick(next);
    if (next !== "All Leads") { setFrom(""); setTo(""); }
  };
  const applyDateRange = (nextFrom: string, nextTo: string) => { setFrom(nextFrom); setTo(nextTo); setQuick("All Leads"); };
  const clearPage = () => { setPageRecordId(""); setAdId(""); };
  const hasActiveFilters = Boolean(pageRecordId || adId || search.trim() || quick !== "All Leads" || status || label || from || to);

  return {
    options, pageRecordId, adId, search, quick, status, label, from, to,
    setPageRecordId, setAdId, setSearch, setQuick, setStatus, setLabel, setFrom, setTo,
    filterBody, reset, toggleQuickRange, applyDateRange, clearPage, hasActiveFilters,
  };
}

export type LeadFilters = ReturnType<typeof useLeadFilters>;
