"use client";

import { BookOpen, CalendarDays, ChevronDown, Download, Filter, LayoutGrid, Megaphone, Search, Tag, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LEAD_LABELS, LEAD_STATUSES, type LeadLabel, type LeadStatus } from "@/features/leads/lead-options";

type Quick = "All Leads" | "Today Leads" | "This Month Leads";
type Lead = { id: string; leadName: string | null; phone: string | null; facebookPage: string; adName: string; leadDate: string; status: LeadStatus; label: LeadLabel };
type Options = { pages: Array<{ id: string; name: string }>; ads: Array<{ id: string; name: string | null }>; defaultAdId: string | null };
type ApiError = { error?: { message?: string } };
type DropdownOption = { value: string; label: string };

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as ApiError | null;
  return body?.error?.message ?? fallback;
}

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

export function LeadsPageClient() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [options, setOptions] = useState<Options>({ pages: [], ads: [], defaultAdId: null });
  const [pageRecordId, setPageRecordId] = useState("");
  const [adId, setAdId] = useState("");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Quick>("All Leads");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [label, setLabel] = useState<LeadLabel | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  useEffect(() => {
    let active = true;
    async function loadOptions() {
      try {
        const response = await fetch(`/api/leads/filters${pageRecordId ? `?pageRecordId=${encodeURIComponent(pageRecordId)}` : ""}`);
        if (!response.ok) throw new Error(await readError(response, "Lead filters could not be loaded."));
        const next = await response.json() as Options;
        if (!active) return;
        setOptions(next);
        setAdId((current) => next.ads.some((ad) => ad.id === current) || current === "unattributed" ? current : next.defaultAdId ?? "");
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Lead filters could not be loaded."); }
    }
    void loadOptions();
    return () => { active = false; };
  }, [pageRecordId]);

  /**
   * The single description of what the user has filtered to — one filter or several combined.
   * The table request adds its own page size on top of this; the export sends these filters
   * alone, because /api/leads/export returns every matching row and its strict schema rejects
   * pagination fields. Both calls read from here, so a download can never disagree with the
   * rows on screen: no filters exports all leads, an Ad filter exports only that ad's leads,
   * and Ad + Status + date bounds together export exactly that intersection.
   */
  const filterBody = () => ({
    quickFilter: quick === "Today Leads" ? "today" : quick === "This Month Leads" ? "month" : "all",
    ...(status ? { status } : {}), ...(label ? { label } : {}),
    ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}),
    ...(pageRecordId ? { pageRecordId } : {}), ...(adId ? { adId } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  useEffect(() => {
    let active = true;
    async function loadLeads() {
      setLoading(true);
      try {
        const response = await fetch("/api/leads/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...filterBody(), pageSize: 100 }) });
        if (!response.ok) throw new Error(await readError(response, "Leads could not be loaded."));
        const result = await response.json() as { items: Lead[]; timezone: string };
        if (active) { setLeads(result.items); setTimezone(result.timezone); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Leads could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    void loadLeads();
    return () => { active = false; };
  }, [quick, status, label, from, to, pageRecordId, adId, search]);

  async function download(): Promise<void> {
    try {
      const response = await fetch("/api/leads/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(filterBody()) });
      if (!response.ok) throw new Error(await readError(response, "Leads could not be exported."));
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
      link.href = url; link.download = "agentzpro-leads.csv"; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Leads could not be exported."); }
  }

  const reset = () => { setPageRecordId(""); setAdId(""); setSearch(""); setQuick("All Leads"); setStatus(""); setLabel(""); setFrom(""); setTo(""); };
  const openDateFilter = () => { setDraftFrom(from); setDraftTo(to); setIsDateOpen(true); };
  const cancelDateFilter = () => setIsDateOpen(false);
  /**
   * Today's Leads and a From/To range are two ways of naming the same thing — a date window — and
   * the query service resolves that collision by letting the quick range win (see resolveDateRange).
   * Showing both at once therefore left a From/To chip on screen that silently filtered nothing, in
   * the table and in the CSV alike. So the two are mutually exclusive here: switching one on clears
   * the other, exactly one date filter is ever active, and the chips always name the rows you get.
   */
  const toggleQuickRange = () => {
    const next: Quick = quick === "All Leads" ? "Today Leads" : "All Leads";
    setQuick(next);
    if (next !== "All Leads") { setFrom(""); setTo(""); }
  };
  const applyDateFilter = () => {
    if (!draftFrom || !draftTo) return;
    setFrom(draftFrom);
    setTo(draftTo);
    setQuick("All Leads");
    setIsDateOpen(false);
  };
  const clearPage = () => { setPageRecordId(""); setAdId(""); };
  const pageName = options.pages.find((page) => page.id === pageRecordId)?.name ?? pageRecordId;
  const adName = adId === "unattributed" ? "Unattributed" : (() => {
    const ad = options.ads.find((item) => item.id === adId);
    return ad ? `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` : adId;
  })();
  const hasActiveFilters = Boolean(pageRecordId || adId || search.trim() || quick !== "All Leads" || status || label || from || to);
  return <div className="mvp-leads">
    <section className="mvp-filter-card">
      <div className="mvp-filter-row">
        <label className="mvp-search-field">
          <Search size={16} />
          <span className="sr-only">Search leads</span>
          <input type="search" value={search} placeholder="Search leads by name, phone, or location..." onChange={(event) => setSearch(event.target.value)} />
        </label>
        <FieldDropdown id="page" icon={<BookOpen size={16} />} label="Page" placeholder="All Pages" value={pageRecordId}
          options={options.pages.map((page) => ({ value: page.id, label: page.name }))}
          openField={openDropdown} onOpenChange={setOpenDropdown}
          onChange={(next) => { setPageRecordId(next); setAdId(""); }} />
        <FieldDropdown id="ad" icon={<Megaphone size={16} />} label="Ad" placeholder="All ads" value={adId}
          options={[{ value: "unattributed", label: "Unattributed" }, ...options.ads.map((ad) => ({ value: ad.id, label: `${ad.name ?? "Name pending"} (${ad.id.slice(-4)})` }))]}
          openField={openDropdown} onOpenChange={setOpenDropdown}
          onChange={setAdId} />
        <FieldDropdown id="status" icon={<LayoutGrid size={16} />} label="Status" placeholder="All statuses" value={status}
          options={LEAD_STATUSES.map((item) => ({ value: item, label: item }))}
          openField={openDropdown} onOpenChange={setOpenDropdown}
          onChange={(next) => setStatus(next as LeadStatus | "")} />
        <FieldDropdown id="label" icon={<Tag size={16} />} label="Label" placeholder="All labels" value={label}
          options={LEAD_LABELS.map((item) => ({ value: item, label: item }))}
          openField={openDropdown} onOpenChange={setOpenDropdown}
          onChange={(next) => setLabel(next as LeadLabel | "")} />
      </div>
      <div className="mvp-filter-row mvp-filter-row--secondary">
        <div className="mvp-date-filter">
          <button type="button" className={`mvp-field-box__control mvp-date-filter__trigger${from || to ? " mvp-date-filter__trigger--active" : ""}`} aria-haspopup="dialog" aria-expanded={isDateOpen} onClick={openDateFilter}>
            <span className="mvp-field-box__icon"><CalendarDays size={16} /></span>
            <span className="mvp-field-box__value">Date</span>
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
        <button className={`mvp-gradient-button mvp-gradient-button--filter${quick !== "All Leads" ? " mvp-gradient-button--on" : ""}`} type="button" onClick={toggleQuickRange}>
          <Filter size={16} />{quick === "All Leads" ? "Today's Leads" : "All Leads"}
        </button>
        <div className="mvp-filter-actions-right">
          <button className="mvp-gradient-button mvp-gradient-button--download" type="button" onClick={() => void download()}>
            <Download size={16} />Download
          </button>
        </div>
      </div>
    </section>
    {error ? <div className="mvp-inline-error">{error}</div> : null}
    {hasActiveFilters ? <div className="mvp-active-filters">
      <span>Active Filters:</span>
      {search.trim() ? <FilterChip chipLabel="Search" value={`"${search.trim()}"`} onRemove={() => setSearch("")} /> : null}
      {pageRecordId ? <FilterChip chipLabel="Page" value={pageName} onRemove={clearPage} /> : null}
      {adId ? <FilterChip chipLabel="Ad" value={adName} onRemove={() => setAdId("")} /> : null}
      {status ? <FilterChip chipLabel="Status" value={status} onRemove={() => setStatus("")} /> : null}
      {label ? <FilterChip chipLabel="Label" value={label} onRemove={() => setLabel("")} /> : null}
      {quick !== "All Leads" ? <FilterChip chipLabel="Range" value={quick} onRemove={() => setQuick("All Leads")} /> : null}
      {from ? <FilterChip chipLabel="From" value={from} onRemove={() => setFrom("")} /> : null}
      {to ? <FilterChip chipLabel="To" value={to} onRemove={() => setTo("")} /> : null}
      <button className="mvp-clear-all" type="button" onClick={reset}>Clear all</button>
    </div> : null}
    <section className="mvp-table-wrap"><table className="mvp-table"><thead><tr>{["Client Name", "Phone", "Page", "Ad Name", "Status", "Label", "Date"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
      {loading ? <tr><td className="mvp-empty" colSpan={7}>Loading leads...</td></tr> : null}
      {!loading && leads.length === 0 ? <tr><td className="mvp-empty" colSpan={7}>No leads match these filters.</td></tr> : null}
      {leads.map((lead) => <tr key={lead.id}><td>{lead.leadName ?? "Unnamed Lead"}</td><td>{lead.phone ?? "-"}</td><td>{lead.facebookPage}</td><td>{lead.adName}</td><td>{lead.status}</td><td>{lead.label}</td><td>{new globalThis.Date(lead.leadDate).toLocaleDateString("en-IN", { timeZone: timezone })}</td></tr>)}
    </tbody></table></section>
  </div>;
}
