"use client";

import Link from "next/link";
import { Download, Eye, Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Notice, PageHeader, SkeletonRows, displayValue } from "@/components/ui";
import { formatDateTime, formatRangeForFilename, toReadableLabel } from "@/lib/date-utils";
import { type DateFilter, type Lead, type LeadCounts, type LeadQuery, type LeadView, type PaginatedLeads } from "@/lib/types";
import {
  exportLeadsToCsv,
  getAllMatchingLeads,
  getLeadCounts,
  getLeadDateRange,
  getLeads,
} from "@/services/crm-data-service";

const PAGE_SIZE = 6;

const viewLabels: Record<LeadView, string> = {
  today: "Leads Today",
  month: "Leads This Month",
  all: "All Leads",
};

export function LeadsPageClient() {
  const [activeView, setActiveView] = useState<LeadView>("today");
  const [counts, setCounts] = useState<LeadCounts | null>(null);
  const [leadsState, setLeadsState] = useState<PaginatedLeads | null>(null);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>(null);
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csvMessage, setCsvMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [isCsvPreparing, setIsCsvPreparing] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const lastViewButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(searchText.trim());
      setPage(1);
    }, 280);

    return () => window.clearTimeout(timeoutId);
  }, [searchText]);

  useEffect(() => {
    let isMounted = true;

    async function loadCounts() {
      try {
        const data = await getLeadCounts();
        if (isMounted) {
          setCounts(data);
        }
      } catch {
        if (isMounted) {
          setErrorMessage("Lead totals could not be loaded.");
        }
      }
    }

    void loadCounts();

    return () => {
      isMounted = false;
    };
  }, []);

  const query = useMemo<LeadQuery>(
    () => ({
      view: activeView,
      search: activeView === "all" ? debouncedSearch : "",
      dateFilter: activeView === "all" ? dateFilter : null,
      customStartDate: activeView === "all" && dateFilter === "custom" ? customStartDate || null : null,
      customEndDate: activeView === "all" && dateFilter === "custom" ? customEndDate || null : null,
      page,
      pageSize: PAGE_SIZE,
    }),
    [activeView, customEndDate, customStartDate, dateFilter, debouncedSearch, page],
  );

  useEffect(() => {
    let isMounted = true;

    async function loadLeads() {
      try {
        setErrorMessage(null);
        setCsvMessage(null);
        setIsLoading(page === 1);
        setIsPageLoading(page > 1);
        const data = await getLeads(query);
        if (isMounted) {
          setLeadsState(data);
        }
      } catch (error) {
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : "Leads could not be loaded.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
          setIsPageLoading(false);
        }
      }
    }

    void loadLeads();

    return () => {
      isMounted = false;
    };
  }, [page, query]);

  function selectView(view: LeadView) {
    setActiveView(view);
    setPage(1);
    if (view !== "all") {
      setDateFilter(null);
      setSearchText("");
      setDebouncedSearch("");
    }
  }

  function setFilter(nextFilter: DateFilter) {
    setDateFilter((current) => (current === nextFilter ? null : nextFilter));
    setPage(1);
  }

  async function handleCsvDownload() {
    try {
      setCsvMessage(null);
      setIsCsvPreparing(true);
      const matchingLeads = await getAllMatchingLeads({
        view: activeView,
        search: activeView === "all" ? debouncedSearch : "",
        dateFilter: activeView === "all" ? dateFilter : null,
        customStartDate: activeView === "all" && dateFilter === "custom" ? customStartDate || null : null,
        customEndDate: activeView === "all" && dateFilter === "custom" ? customEndDate || null : null,
      });

      if (!matchingLeads.length) {
        setCsvMessage({ tone: "warning", text: "No leads match the selected filter." });
        return;
      }

      const csv = exportLeadsToCsv(matchingLeads);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");
      const range = getLeadDateRange({
        view: activeView,
        search: debouncedSearch,
        dateFilter,
        customStartDate: customStartDate || null,
        customEndDate: customEndDate || null,
      });
      downloadLink.href = objectUrl;
      downloadLink.download = `${formatRangeForFilename(range)}.csv`;
      downloadLink.click();
      URL.revokeObjectURL(objectUrl);
      setCsvMessage({ tone: "success", text: "CSV download prepared." });
    } catch (error) {
      setCsvMessage({ tone: "danger", text: error instanceof Error ? error.message : "CSV download failed. Try again." });
    } finally {
      setIsCsvPreparing(false);
    }
  }

  const isFiltered = Boolean(debouncedSearch || dateFilter);
  const emptyTitle = getEmptyTitle(activeView, isFiltered, debouncedSearch);

  return (
    <div className="stack">
      <PageHeader title="Leads" description="Review, search, filter, and download Meta Lead Ads enquiries." />

      <Notice
        tone="warning"
        title="Facebook connection requires attention. New leads may not be received."
        action={<Link className="button button--secondary" href="/connection">Reconnect Facebook</Link>}
      />

      <section className="panel">
        <div className="panel__body stack">
          <div className="tabs" role="tablist" aria-label="Lead views">
            {(["today", "month", "all"] as const).map((view) => (
              <button
                key={view}
                ref={activeView === view ? lastViewButtonRef : undefined}
                className="tab-button"
                type="button"
                role="tab"
                aria-selected={activeView === view}
                onClick={() => selectView(view)}
              >
                {viewLabels[view]} {counts ? `(${counts[view]})` : ""}
              </button>
            ))}
          </div>

          {activeView === "all" ? (
            <div className="stack">
              <div className="toolbar">
                <label className="field">
                  <span>Search</span>
                  <span style={{ position: "relative" }}>
                    <Search aria-hidden="true" size={18} style={{ left: 12, position: "absolute", top: 12 }} />
                    <input
                      aria-label="Search by name, phone, or email"
                      style={{ paddingLeft: 38 }}
                      value={searchText}
                      onChange={(event) => setSearchText(event.target.value)}
                      placeholder="Name, phone, or email"
                    />
                  </span>
                </label>
                <button className="button button--secondary" type="button" onClick={() => void handleCsvDownload()} disabled={isCsvPreparing}>
                  {isCsvPreparing ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Download aria-hidden="true" size={18} />}
                  {isCsvPreparing ? "Preparing download..." : isFiltered ? "Download Filtered Leads" : "Download All Leads"}
                </button>
              </div>

              <div className="filter-row" aria-label="Date filters">
                {(["today", "week", "month"] as const).map((filter) => (
                  <button
                    key={filter}
                    className="filter-button"
                    type="button"
                    aria-pressed={dateFilter === filter}
                    onClick={() => setFilter(filter)}
                  >
                    {filter === "today" ? "Today" : filter === "week" ? "This Week" : "This Month"}
                  </button>
                ))}
                <button className="filter-button" type="button" aria-pressed={dateFilter === "custom"} onClick={() => setFilter("custom")}>
                  Custom date range
                </button>
                {dateFilter ? (
                  <button className="button button--secondary" type="button" onClick={() => setFilter(null)}>
                    <X aria-hidden="true" size={16} />
                    Clear filter
                  </button>
                ) : null}
              </div>

              {dateFilter === "custom" ? (
                <div className="custom-dates">
                  <label className="field">
                    <span>Start date</span>
                    <input type="date" value={customStartDate} onChange={(event) => { setCustomStartDate(event.target.value); setPage(1); }} />
                  </label>
                  <label className="field">
                    <span>End date</span>
                    <input type="date" value={customEndDate} onChange={(event) => { setCustomEndDate(event.target.value); setPage(1); }} />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {errorMessage ? <Notice tone="danger" title={errorMessage} /> : null}
      {csvMessage ? <Notice tone={csvMessage.tone} title={csvMessage.text} /> : null}

      {isLoading ? <SkeletonRows count={5} /> : null}

      {!isLoading && leadsState && leadsState.items.length > 0 ? (
        <section className="panel">
          <div className="panel__body">
            <LeadList leads={leadsState.items} onViewLead={setSelectedLead} />
            <div className="pagination">
              <button className="button button--secondary" type="button" disabled={page <= 1 || isPageLoading} onClick={() => setPage((current) => Math.max(current - 1, 1))}>
                Previous
              </button>
              <span className="field-help">
                Page {leadsState.page} of {leadsState.totalPages} · {leadsState.total} leads
                {isPageLoading ? " · Loading..." : ""}
              </span>
              <button
                className="button button--secondary"
                type="button"
                disabled={page >= leadsState.totalPages || isPageLoading}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!isLoading && leadsState && leadsState.items.length === 0 ? (
        <EmptyState title={emptyTitle} description={activeView === "all" ? "Adjust search or date filters to widen the results." : emptyTitle} />
      ) : null}

      {selectedLead ? <LeadDetailsModal lead={selectedLead} onClose={() => setSelectedLead(null)} /> : null}
    </div>
  );
}

function LeadList({ leads, onViewLead }: { leads: Lead[]; onViewLead: (lead: Lead) => void }) {
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Facebook Page</th>
            <th>Received</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td className="truncate" title={displayValue(lead.fullName)}>{displayValue(lead.fullName)}</td>
              <td>{lead.phoneNumber ? <a href={`tel:${lead.phoneNumber}`}>{lead.phoneNumber}</a> : "—"}</td>
              <td className="truncate" title={displayValue(lead.emailAddress)}>{lead.emailAddress ? <a href={`mailto:${lead.emailAddress}`}>{lead.emailAddress}</a> : "—"}</td>
              <td className="truncate" title={lead.facebookPageName}>{lead.facebookPageName}</td>
              <td>{formatDateTime(lead.receivedAt)}</td>
              <td>
                <button className="button button--secondary" type="button" onClick={() => onViewLead(lead)}>
                  <Eye aria-hidden="true" size={17} />
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="lead-card-list">
        {leads.map((lead) => (
          <article className="lead-card" key={lead.id}>
            <div className="lead-card__top">
              <strong>{displayValue(lead.fullName)}</strong>
              <button className="button button--secondary" type="button" onClick={() => onViewLead(lead)}>
                <Eye aria-hidden="true" size={17} />
                View
              </button>
            </div>
            <span>{lead.phoneNumber ? <a href={`tel:${lead.phoneNumber}`}>{lead.phoneNumber}</a> : "—"}</span>
            <span>{lead.emailAddress ? <a href={`mailto:${lead.emailAddress}`}>{lead.emailAddress}</a> : "—"}</span>
            <span>{lead.facebookPageName}</span>
            <span>{formatDateTime(lead.receivedAt)}</span>
          </article>
        ))}
      </div>
    </>
  );
}

function LeadDetailsModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="lead-details-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <h2 id="lead-details-title">Lead details</h2>
          <button className="icon-button" type="button" aria-label="Close lead details" onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="modal__body">
          <dl className="detail-list">
            <dt>Received</dt>
            <dd>{formatDateTime(lead.receivedAt)}</dd>
            <dt>Facebook Page</dt>
            <dd>{lead.facebookPageName}</dd>
            <dt>Full name</dt>
            <dd>{displayValue(lead.fullName)}</dd>
            <dt>Phone number</dt>
            <dd>{displayValue(lead.phoneNumber)}</dd>
            <dt>Email address</dt>
            <dd>{displayValue(lead.emailAddress)}</dd>
            {lead.fields.map((field) => (
              <DetailField key={field.key} label={toReadableLabel(field.key)} values={field.values} />
            ))}
          </dl>
        </div>
        <div className="modal__footer">
          <span className="field-help">All available form answers are shown dynamically.</span>
          <button className="button button--secondary" type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}

function DetailField({ label, values }: { label: string; values: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{values.length ? values.join(", ") : "—"}</dd>
    </>
  );
}

function getEmptyTitle(view: LeadView, isFiltered: boolean, search: string): string {
  if (isFiltered || search) {
    return "No matching leads found";
  }

  if (view === "today") {
    return "No leads received today.";
  }

  if (view === "month") {
    return "No leads received this month.";
  }

  return "No leads available";
}
