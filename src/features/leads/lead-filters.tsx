"use client";

import { BookOpen, CalendarDays, ChevronDown, Filter, LayoutGrid, Megaphone, PhoneIncoming, Search, Tag, Target, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LEAD_LABELS, LEAD_SOURCE_LABELS, LEAD_SOURCES, LEAD_STATUSES, type LeadLabel, type LeadSource, type LeadStatus } from "@/features/leads/lead-options";
import { isValidDateRange, type LeadFilters } from "@/features/leads/use-lead-filters";

type DropdownOption = { value: string; label: string };

/**
 * Every Page/Ad/Status/Label filter is the same custom dropdown: a boxed
 * trigger button plus a popover panel with a close (X) button in its
 * header and each option rendered as its own full-width button row (same
 * padding/gap for all four, so they all look and behave identically —
 * unlike a native <select>'s browser-drawn option list, this is fully
 * styleable and cannot land clicks on dead space).
 *
 * The trigger carries no visible caption — its icon and its current value
 * ("All Pages", "All ads") identify it, matching the search field beside
 * it. `label` therefore survives only as the panel heading and as the
 * button's aria-label, which is the trigger's sole accessible name now
 * that no text label is rendered.
 *
 * `disabledHint` greys the control out (a real disabled button that never opens) and is its tooltip, e.g. the
 * Facebook-only Page and Ad filters while Google Ads leads are shown.
 */
function FieldDropdown({ id, icon, label, value, options, placeholder, openField, onOpenChange, onChange, disabledHint, optionTitles = false }: {
  id: string; icon: ReactNode; label: string; value: string; options: DropdownOption[]; placeholder: string;
  openField: string | null; onOpenChange: (id: string | null) => void; onChange: (value: string) => void; disabledHint?: string;
  /** Shows each option's full text on hover (Google Ads campaign names are often too long for the panel). */
  optionTitles?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const disabled = Boolean(disabledHint);
  const open = !disabled && openField === id;
  const selectedLabel = options.find((option) => option.value === value)?.label ?? placeholder;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) onOpenChange(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("mousedown", handlePointerDown); document.removeEventListener("keydown", handleKeyDown); };
  }, [open, onOpenChange]);

  function choose(next: string) {
    onChange(next);
    onOpenChange(null);
  }

  return <div className="mvp-field-box" ref={containerRef} title={disabledHint}>
    <button type="button" className="mvp-field-box__control" aria-haspopup="listbox" aria-expanded={open} aria-label={label} disabled={disabled} onClick={() => onOpenChange(open ? null : id)}>
      <span className="mvp-field-box__icon">{icon}</span>
      <span className="mvp-field-box__value">{selectedLabel}</span>
      <ChevronDown size={16} className={`mvp-field-chevron${open ? " mvp-field-chevron--open" : ""}`} />
    </button>
    {open ? <div className="mvp-dropdown-panel" role="listbox">
      <div className="mvp-dropdown-panel__header">
        <span>{label}</span>
        <button type="button" className="mvp-dropdown-close" aria-label={`Close ${label} options`} onClick={() => onOpenChange(null)}><X size={14} /></button>
      </div>
      <div className="mvp-dropdown-panel__options">
        <button type="button" role="option" aria-selected={value === ""} className={`mvp-dropdown-option${value === "" ? " mvp-dropdown-option--active" : ""}`} onClick={() => choose("")}>{placeholder}</button>
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={value === option.value} className={`mvp-dropdown-option${value === option.value ? " mvp-dropdown-option--active" : ""}`} title={optionTitles ? option.label : undefined} onClick={() => choose(option.value)}><span className="mvp-dropdown-option__label">{option.label}</span></button>)}
      </div>
    </div> : null}
  </div>;
}

/**
 * One removable pill inside the "Active Filters" bar. Each active filter
 * (search text, page, ad, status, label, quick range, date range) renders
 * exactly one of these with a human-readable value and its own X so a
 * single filter can be lifted without clearing the rest.
 */
function FilterChip({ chipLabel, value, onRemove }: { chipLabel: string; value: string; onRemove: () => void }) {
  return <button type="button" className="mvp-filter-chip" onClick={onRemove} aria-label={`Remove ${chipLabel} filter: ${value}`}>
    <span>{chipLabel}: {value}</span>
    <X size={12} />
  </button>;
}

/**
 * The search box, Page/Ad/Status/Label dropdowns, Date popover and Today's Leads toggle. `actions`
 * fills the right-hand end of the second row (the leads page puts Delete/Download there; the
 * dashboard has none). The dashboard also hides the search box and the Today's Leads toggle, and
 * does not offer the Assignee filter (`showAssignee`, leads page only). `showPage` / `showAd` let the
 * dashboard hide the Facebook-only Page and Ad filters for a platform that has neither. `showCampaign` adds the
 * Google Ads Campaign filter and `pageAdDisabled` greys Page and Ad out (both while Google Ads leads are shown).
 * `sources` lists only the lead sources the company uses (see useLeadSources).
 */
export function LeadFilterBar({ filters, actions, showSearch = true, showQuickToggle = true, showAssignee = false, showSource = false, showPage = true, showAd = true, showCampaign = false, pageAdDisabled = false, sources = LEAD_SOURCES }: { filters: LeadFilters; actions?: ReactNode; showSearch?: boolean; showQuickToggle?: boolean; showAssignee?: boolean; showSource?: boolean; showPage?: boolean; showAd?: boolean; showCampaign?: boolean; pageAdDisabled?: boolean; sources?: readonly LeadSource[] }) {
  const { options, pageRecordId, adId, campaignId, search, quick, status, label, assignee, source, from, to } = filters;
  const facebookOnlyHint = pageAdDisabled ? "Facebook only" : undefined;
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  const openDateFilter = () => { setDraftFrom(from); setDraftTo(to); setIsDateOpen(true); };
  const cancelDateFilter = () => setIsDateOpen(false);
  // A typed date can skip the calendar's min/max (a To before From, a 5-digit year), so Apply checks the server's own rule.
  const canApplyDate = isValidDateRange(draftFrom, draftTo);
  const applyDateFilter = () => {
    if (!canApplyDate) return;
    filters.applyDateRange(draftFrom, draftTo);
    setIsDateOpen(false);
  };

  return <section className={`mvp-filter-card${showSearch ? "" : " mvp-filter-card--single-row"}${showAssignee ? " mvp-filter-card--assignee" : ""}`}>
    <div className="mvp-filter-row">
      {showSearch ? <label className="mvp-search-field">
        <Search size={16} />
        <span className="sr-only">Search leads</span>
        <input type="search" value={search} placeholder="Search leads by name, phone, or location..." onChange={(event) => filters.setSearch(event.target.value)} />
      </label> : null}
      {showPage ? <FieldDropdown id="page" icon={<BookOpen size={16} />} label="Page" placeholder="All Pages" value={pageRecordId}
        options={options.pages.map((page) => ({ value: page.id, label: page.name }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => { filters.setPageRecordId(next); filters.setAdId(""); }} disabledHint={facebookOnlyHint} /> : null}
      {showAd ? <FieldDropdown id="ad" icon={<Megaphone size={16} />} label="Ad" placeholder="All ads" value={adId}
        options={[{ value: "unattributed", label: "Unattributed" }, ...options.ads.map((ad) => ({ value: ad.id, label: `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` }))]}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={filters.setAdId} disabledHint={facebookOnlyHint} /> : null}
      <FieldDropdown id="status" icon={<LayoutGrid size={16} />} label="Status" placeholder="All statuses" value={status}
        options={LEAD_STATUSES.map((item) => ({ value: item, label: item }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => filters.setStatus(next as LeadStatus | "")} />
      <FieldDropdown id="label" icon={<Tag size={16} />} label="Label" placeholder="All labels" value={label}
        options={LEAD_LABELS.map((item) => ({ value: item, label: item }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => filters.setLabel(next as LeadLabel | "")} />
      {showAssignee ? <FieldDropdown id="assignee" icon={<UserRound size={16} />} label="Assignee" placeholder="All assignees" value={assignee}
        options={assigneeFilterOptions(options.assignees)}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={filters.setAssignee} /> : null}
    </div>
    <div className="mvp-filter-row mvp-filter-row--secondary">
      {showSource ? <FieldDropdown id="source" icon={<PhoneIncoming size={16} />} label="Source" placeholder="All sources" value={source}
        options={sources.map((item) => ({ value: item, label: LEAD_SOURCE_LABELS[item] }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => filters.changeSource(next as LeadSource | "")} /> : null}
      {/* Campaign sits right after the Source it depends on (Google Ads), so the first row keeps its width. */}
      {/* If the campaign lookup failed, the control says so (the other filters still work); a reload tries again. */}
      {showCampaign ? <FieldDropdown id="campaign" icon={<Target size={16} />} label="Campaign"
        placeholder={options.campaignsUnavailable ? "Campaigns unavailable" : "All campaigns"} value={options.campaignsUnavailable ? "" : campaignId}
        options={campaignFilterOptions(options)} optionTitles
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={filters.setCampaignId}
        disabledHint={options.campaignsUnavailable ? "Campaigns could not be loaded. Reload the page to try again." : undefined} /> : null}
      <div className="mvp-date-filter">
        <button type="button" className={`mvp-field-box__control mvp-date-filter__trigger${from || to ? " mvp-date-filter__trigger--active" : ""}`} aria-haspopup="dialog" aria-expanded={isDateOpen} onClick={() => (isDateOpen ? cancelDateFilter() : openDateFilter())}>
          <span className="mvp-field-box__icon"><CalendarDays size={16} /></span>
          <span className="mvp-field-box__value">Date</span>
          <ChevronDown size={16} className={`mvp-field-chevron${isDateOpen ? " mvp-field-chevron--open" : ""}`} aria-hidden="true" />
        </button>
        {isDateOpen ? <div className="mvp-date-popover" role="dialog" aria-label="Date range filter">
          <div className="mvp-date-popover__header">
            <strong>Date</strong>
            <button type="button" className="mvp-dropdown-close" aria-label="Cancel date filter" onClick={cancelDateFilter}><X size={14} /></button>
          </div>
          <div className="mvp-date-popover__fields">
            <label><span>From</span><input type="date" max={draftTo || undefined} value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} /></label>
            <label><span>To</span><input type="date" min={draftFrom || undefined} value={draftTo} onChange={(event) => setDraftTo(event.target.value)} /></label>
          </div>
          <button type="button" className="mvp-date-popover__apply" disabled={!canApplyDate} onClick={applyDateFilter}>Apply</button>
        </div> : null}
      </div>
      {showQuickToggle ? <button className={`mvp-gradient-button mvp-gradient-button--filter${quick !== "All Leads" ? " mvp-gradient-button--on" : ""}`} type="button" onClick={filters.toggleQuickRange}>
        <Filter size={16} />{quick === "All Leads" ? "Today's Leads" : "All Leads"}
      </button> : null}
      {actions ? <div className="mvp-filter-actions-right">{actions}</div> : null}
    </div>
  </section>;
}

/** "My leads" and "Unassigned" first, then every active member of the company. */
function assigneeFilterOptions(assignees: LeadFilters["options"]["assignees"]): DropdownOption[] {
  return [
    { value: "me", label: "My leads" },
    { value: "unassigned", label: "Unassigned" },
    ...assignees.map((member) => ({ value: member.userId, label: member.fullName })),
  ];
}

/** "Unattributed" (only when some Google Ads lead has no campaign), then every campaign by name. */
function campaignFilterOptions(options: LeadFilters["options"]): DropdownOption[] {
  return [
    ...(options.hasUnattributedCampaign ? [{ value: "unattributed", label: "Unattributed" }] : []),
    ...options.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name })),
  ];
}

/** The "Active Filters" bar: one removable chip per active filter, plus Clear all. */
export function LeadActiveFilters({ filters }: { filters: LeadFilters }) {
  const { options, pageRecordId, adId, campaignId, search, quick, status, label, assignee, source, from, to } = filters;
  if (!filters.hasActiveFilters) return null;
  const pageName = options.pages.find((page) => page.id === pageRecordId)?.name ?? pageRecordId;
  const adName = adId === "unattributed" ? "Unattributed" : (() => {
    const ad = options.ads.find((item) => item.id === adId);
    return ad ? `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` : adId;
  })();
  const campaignName = campaignId === "unattributed" ? "Unattributed" : options.campaigns.find((campaign) => campaign.id === campaignId)?.name ?? campaignId;
  const assigneeName = assigneeFilterOptions(options.assignees).find((option) => option.value === assignee)?.label ?? assignee;
  return <div className="mvp-active-filters">
    <span>Active Filters:</span>
    {search.trim() ? <FilterChip chipLabel="Search" value={`"${search.trim()}"`} onRemove={() => filters.setSearch("")} /> : null}
    {pageRecordId ? <FilterChip chipLabel="Page" value={pageName} onRemove={filters.clearPage} /> : null}
    {adId ? <FilterChip chipLabel="Ad" value={adName} onRemove={() => filters.setAdId("")} /> : null}
    {campaignId ? <FilterChip chipLabel="Campaign" value={campaignName} onRemove={() => filters.setCampaignId("")} /> : null}
    {status ? <FilterChip chipLabel="Status" value={status} onRemove={() => filters.setStatus("")} /> : null}
    {label ? <FilterChip chipLabel="Label" value={label} onRemove={() => filters.setLabel("")} /> : null}
    {assignee ? <FilterChip chipLabel="Assignee" value={assigneeName} onRemove={() => filters.setAssignee("")} /> : null}
    {source ? <FilterChip chipLabel="Source" value={LEAD_SOURCE_LABELS[source]} onRemove={() => filters.changeSource("")} /> : null}
    {quick !== "All Leads" ? <FilterChip chipLabel="Range" value={quick} onRemove={() => filters.setQuick("All Leads")} /> : null}
    {/* One chip for the whole range: its X clears both dates, so a half range is never sent. */}
    {from && to ? <FilterChip chipLabel="Date" value={`${from} → ${to}`} onRemove={filters.clearDateRange} /> : null}
    <button className="mvp-clear-all" type="button" onClick={filters.reset}>Clear all</button>
  </div>;
}
