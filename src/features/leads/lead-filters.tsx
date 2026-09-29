"use client";

import { BookOpen, CalendarDays, ChevronDown, Filter, LayoutGrid, Megaphone, Search, Tag, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LEAD_LABELS, LEAD_STATUSES, type LeadLabel, type LeadStatus } from "@/features/leads/lead-options";
import type { LeadFilters } from "@/features/leads/use-lead-filters";

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
 */
function FieldDropdown({ id, icon, label, value, options, placeholder, openField, onOpenChange, onChange }: {
  id: string; icon: ReactNode; label: string; value: string; options: DropdownOption[]; placeholder: string;
  openField: string | null; onOpenChange: (id: string | null) => void; onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const open = openField === id;
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

  return <div className="mvp-field-box" ref={containerRef}>
    <button type="button" className="mvp-field-box__control" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => onOpenChange(open ? null : id)}>
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
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={value === option.value} className={`mvp-dropdown-option${value === option.value ? " mvp-dropdown-option--active" : ""}`} onClick={() => choose(option.value)}>{option.label}</button>)}
      </div>
    </div> : null}
  </div>;
}

/**
 * One removable pill inside the "Active Filters" bar. Each active filter
 * (search text, page, ad, status, label, quick range, date bounds) renders
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
 * dashboard has none).
 */
export function LeadFilterBar({ filters, actions, showSearch = true }: { filters: LeadFilters; actions?: ReactNode; showSearch?: boolean }) {
  const { options, pageRecordId, adId, search, quick, status, label, from, to } = filters;
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  const openDateFilter = () => { setDraftFrom(from); setDraftTo(to); setIsDateOpen(true); };
  const cancelDateFilter = () => setIsDateOpen(false);
  const applyDateFilter = () => {
    if (!draftFrom || !draftTo) return;
    filters.applyDateRange(draftFrom, draftTo);
    setIsDateOpen(false);
  };

  return <section className={`mvp-filter-card${showSearch ? "" : " mvp-filter-card--single-row"}`}>
    <div className="mvp-filter-row">
      {showSearch ? <label className="mvp-search-field">
        <Search size={16} />
        <span className="sr-only">Search leads</span>
        <input type="search" value={search} placeholder="Search leads by name, phone, or location..." onChange={(event) => filters.setSearch(event.target.value)} />
      </label> : null}
      <FieldDropdown id="page" icon={<BookOpen size={16} />} label="Page" placeholder="All Pages" value={pageRecordId}
        options={options.pages.map((page) => ({ value: page.id, label: page.name }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => { filters.setPageRecordId(next); filters.setAdId(""); }} />
      <FieldDropdown id="ad" icon={<Megaphone size={16} />} label="Ad" placeholder="All ads" value={adId}
        options={[{ value: "unattributed", label: "Unattributed" }, ...options.ads.map((ad) => ({ value: ad.id, label: `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` }))]}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={filters.setAdId} />
      <FieldDropdown id="status" icon={<LayoutGrid size={16} />} label="Status" placeholder="All statuses" value={status}
        options={LEAD_STATUSES.map((item) => ({ value: item, label: item }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => filters.setStatus(next as LeadStatus | "")} />
      <FieldDropdown id="label" icon={<Tag size={16} />} label="Label" placeholder="All labels" value={label}
        options={LEAD_LABELS.map((item) => ({ value: item, label: item }))}
        openField={openDropdown} onOpenChange={setOpenDropdown}
        onChange={(next) => filters.setLabel(next as LeadLabel | "")} />
    </div>
    <div className="mvp-filter-row mvp-filter-row--secondary">
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
            <label><span>From</span><input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} /></label>
            <label><span>To</span><input type="date" min={draftFrom || undefined} value={draftTo} onChange={(event) => setDraftTo(event.target.value)} /></label>
          </div>
          <button type="button" className="mvp-date-popover__apply" disabled={!draftFrom || !draftTo} onClick={applyDateFilter}>Apply</button>
        </div> : null}
      </div>
      <button className={`mvp-gradient-button mvp-gradient-button--filter${quick !== "All Leads" ? " mvp-gradient-button--on" : ""}`} type="button" onClick={filters.toggleQuickRange}>
        <Filter size={16} />{quick === "All Leads" ? "Today's Leads" : "All Leads"}
      </button>
      {actions ? <div className="mvp-filter-actions-right">{actions}</div> : null}
    </div>
  </section>;
}

/** The "Active Filters" bar: one removable chip per active filter, plus Clear all. */
export function LeadActiveFilters({ filters }: { filters: LeadFilters }) {
  const { options, pageRecordId, adId, search, quick, status, label, from, to } = filters;
  if (!filters.hasActiveFilters) return null;
  const pageName = options.pages.find((page) => page.id === pageRecordId)?.name ?? pageRecordId;
  const adName = adId === "unattributed" ? "Unattributed" : (() => {
    const ad = options.ads.find((item) => item.id === adId);
    return ad ? `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` : adId;
  })();
  return <div className="mvp-active-filters">
    <span>Active Filters:</span>
    {search.trim() ? <FilterChip chipLabel="Search" value={`"${search.trim()}"`} onRemove={() => filters.setSearch("")} /> : null}
    {pageRecordId ? <FilterChip chipLabel="Page" value={pageName} onRemove={filters.clearPage} /> : null}
    {adId ? <FilterChip chipLabel="Ad" value={adName} onRemove={() => filters.setAdId("")} /> : null}
    {status ? <FilterChip chipLabel="Status" value={status} onRemove={() => filters.setStatus("")} /> : null}
    {label ? <FilterChip chipLabel="Label" value={label} onRemove={() => filters.setLabel("")} /> : null}
    {quick !== "All Leads" ? <FilterChip chipLabel="Range" value={quick} onRemove={() => filters.setQuick("All Leads")} /> : null}
    {from ? <FilterChip chipLabel="From" value={from} onRemove={() => filters.setFrom("")} /> : null}
    {to ? <FilterChip chipLabel="To" value={to} onRemove={() => filters.setTo("")} /> : null}
    <button className="mvp-clear-all" type="button" onClick={filters.reset}>Clear all</button>
  </div>;
}
