"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GOOGLE_CAMPAIGN_ID_PATTERN, type LeadLabel, type LeadSource, type LeadStatus } from "@/features/leads/lead-options";

export type Quick = "All Leads" | "Today Leads" | "This Month Leads";
export type AssigneeOption = { userId: string; fullName: string };
export type LeadFilterOptions = { pages: Array<{ id: string; name: string }>; ads: Array<{ id: string; name: string | null }>; defaultAdId: string | null; campaigns: Array<{ id: string; name: string }>; hasUnattributedCampaign: boolean; campaignsUnavailable: boolean; assignees: AssigneeOption[]; isOwner: boolean };
type ApiError = { error?: { message?: string } };
type DateRange = { from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The same rule the query service enforces (resolveDateRange): two complete YYYY-MM-DD dates, From on or
 * before To. A range the Date popover lets you apply is therefore always one the server accepts.
 */
export function isValidDateRange(from: string, to: string): boolean {
  return ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to;
}

export async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as ApiError | null;
  return body?.error?.message ?? fallback;
}

/**
 * The one description of a lead-filter selection, shared by /leads and /dashboard so the two pages
 * can never disagree about what "Page + Ad + Status + Label + date" means.
 *
 * `autoSelectDefaultAd` pre-selects the newest lead's ad when it is true. Both the leads page and the
 * dashboard turn it off: each must open on ALL ads, otherwise the rows, totals and charts would be
 * silently narrowed to one ad before the user chose any filter.
 */
export function useLeadFilters({ autoSelectDefaultAd, onError }: { autoSelectDefaultAd: boolean; onError?: (message: string) => void }) {
  const [options, setOptions] = useState<LeadFilterOptions>({ pages: [], ads: [], defaultAdId: null, campaigns: [], hasUnattributedCampaign: false, campaignsUnavailable: false, assignees: [], isOwner: false });
  const [pageRecordId, setPageRecordId] = useState("");
  const [adId, setAdId] = useState("");
  // A Google Ads campaign id, "unattributed", or "" for all campaigns. Only offered while Google Ads leads are shown.
  const [campaignId, setCampaignId] = useState("");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Quick>("All Leads");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [label, setLabel] = useState<LeadLabel | "">("");
  // "me", "unassigned", a member's user id, or "" for everyone. Only the leads page offers it; the dashboard never sets it.
  const [assignee, setAssignee] = useState("");
  // A lead source, or "" for all of them. Leads page only, like assignee: the dashboard never sets it.
  const [source, setSource] = useState<LeadSource | "">("");
  // From and To are one value: both dates or none. The server rejects a half range, so it must never exist here.
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const from = dateRange?.from ?? "";
  const to = dateRange?.to ?? "";
  // Bumped to load the filter choices again after leads are added or deleted (a campaign, or "Unattributed", can
  // appear or disappear). The choices are otherwise loaded once, and again when the Page changes.
  const [optionsVersion, setOptionsVersion] = useState(0);
  // False until the choices have loaded once: an empty list before that means "not loaded yet", not "none".
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const reloadOptions = useCallback(() => setOptionsVersion((version) => version + 1), []);
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
        // Only ids the lead routes accept are offered: any other id would be rejected (400) the moment it was picked.
        const nextCampaigns = (Array.isArray(next.campaigns) ? next.campaigns : [])
          .filter((campaign) => typeof campaign?.id === "string" && GOOGLE_CAMPAIGN_ID_PATTERN.test(campaign.id) && typeof campaign.name === "string");
        // A campaign lookup that fails on a later reload keeps the last list that loaded (a selected campaign keeps its
        // name and stays selectable); "unavailable" is shown only when no list has loaded yet.
        setOptions((previous) => {
          const keepPrevious = next.campaignsUnavailable === true && !previous.campaignsUnavailable && (previous.campaigns.length > 0 || previous.hasUnattributedCampaign);
          return {
            ...next,
            campaigns: keepPrevious ? previous.campaigns : nextCampaigns,
            hasUnattributedCampaign: keepPrevious ? previous.hasUnattributedCampaign : next.hasUnattributedCampaign === true,
            campaignsUnavailable: next.campaignsUnavailable === true && !keepPrevious,
            assignees: next.assignees ?? [],
          };
        });
        setOptionsLoaded(true);
        setAdId((current) => next.ads.some((ad) => ad.id === current) || current === "unattributed" ? current : autoSelectDefaultAd ? next.defaultAdId ?? "" : "");
        // Like the Ad above: a selected campaign that is no longer offered (its last lead was deleted) is dropped, so the
        // dropdown, the chip and the rows never disagree. Skipped when the lookup failed: the last list is still shown.
        if (next.campaignsUnavailable !== true) {
          setCampaignId((current) => !current || (current === "unattributed" ? next.hasUnattributedCampaign === true : nextCampaigns.some((campaign) => campaign.id === current)) ? current : "");
        }
      } catch (cause) { if (active) onErrorRef.current?.(cause instanceof Error ? cause.message : "Lead filters could not be loaded."); }
    }
    void loadOptions();
    return () => { active = false; };
  }, [pageRecordId, autoSelectDefaultAd, optionsVersion]);

  /**
   * What the user has filtered to — one filter or several combined. The leads table adds its own page
   * size on top; the export and the dashboard stats send exactly this, so a download or a chart can
   * never disagree with the rows on screen.
   */
  const filterBody = () => ({
    quickFilter: quick === "Today Leads" ? "today" : quick === "This Month Leads" ? "month" : "all",
    ...(status ? { status } : {}), ...(label ? { label } : {}), ...(assignee ? { assignee } : {}), ...(source ? { source } : {}),
    ...(dateRange ? { dateFrom: dateRange.from, dateTo: dateRange.to } : {}),
    ...(pageRecordId ? { pageRecordId } : {}), ...(adId ? { adId } : {}), ...(campaignId ? { campaignId } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const reset = () => { setPageRecordId(""); setAdId(""); setCampaignId(""); setSearch(""); setQuick("All Leads"); setStatus(""); setLabel(""); setAssignee(""); setSource(""); setDateRange(null); };
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
    if (next !== "All Leads") setDateRange(null);
  };
  /** Applies both dates together, and only a range the server accepts; anything else is ignored. */
  const applyDateRange = (nextFrom: string, nextTo: string) => {
    if (!isValidDateRange(nextFrom, nextTo)) return;
    setDateRange({ from: nextFrom, to: nextTo });
    setQuick("All Leads");
  };
  const clearDateRange = () => setDateRange(null);
  const clearPage = () => { setPageRecordId(""); setAdId(""); };
  /**
   * Page and Ad are Facebook-only and Campaign is Google Ads-only, so a source change drops the filters the new
   * source cannot have: a Facebook Page or ad left over on Google Ads or Webhook (or a campaign on another source)
   * would silently empty the table while its control is greyed out or gone.
   */
  const changeSource = (next: LeadSource | "") => {
    setSource(next);
    if (next === "google_ads" || next === "custom_webhook") clearPage();
    if (next !== "google_ads") setCampaignId("");
  };
  const hasActiveFilters = Boolean(pageRecordId || adId || campaignId || search.trim() || quick !== "All Leads" || status || label || assignee || source || dateRange);

  return {
    options, optionsLoaded, pageRecordId, adId, campaignId, search, quick, status, label, assignee, source, from, to,
    setPageRecordId, setAdId, setCampaignId, setSearch, setQuick, setStatus, setLabel, setAssignee, changeSource,
    filterBody, reset, toggleQuickRange, applyDateRange, clearDateRange, clearPage, hasActiveFilters, reloadOptions,
  };
}

export type LeadFilters = ReturnType<typeof useLeadFilters>;
