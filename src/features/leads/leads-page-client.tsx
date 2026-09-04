"use client";

import { CalendarDays, Download, Filter, Tag, X } from "lucide-react";
import { useEffect, useState } from "react";
import { LEAD_LABELS, LEAD_STATUSES, type LeadLabel, type LeadStatus } from "@/features/leads/lead-options";

type Quick = "All Leads" | "Today Leads" | "This Month Leads";
type Lead = { id: string; name: string; phone: string; source: string; status: LeadStatus; label: LeadLabel; project: string; date: string };
type LeadApiRow = { id: string; leadName: string | null; phone: string | null; project: string | null; facebookPage: string; leadDate: string; status: LeadStatus; label: LeadLabel };
type LeadQueryResponse = { items: LeadApiRow[]; timezone: string };
type ApiError = { error?: { message?: string } };

function toLead(row: LeadApiRow): Lead {
  return { id: row.id, name: row.leadName ?? "Unnamed Lead", phone: row.phone ?? "—", source: row.facebookPage, status: row.status, label: row.label, project: row.project ?? "Unassigned", date: row.leadDate };
}
function buildFilterBody(quick: Quick, status: LeadStatus | "", label: LeadLabel | "", from: string, to: string) {
  return { quickFilter: quick === "Today Leads" ? "today" : quick === "This Month Leads" ? "month" : "all", ...(status ? { status } : {}), ...(label ? { label } : {}), ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}), pageSize: 100 };
}
async function readErrorMessage(response: Response, fallback: string): Promise<string> { const body = (await response.json().catch(() => null)) as ApiError | null; return body?.error?.message ?? fallback; }

export function LeadsPageClient() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [quick, setQuick] = useState<Quick>("All Leads"); const [status, setStatus] = useState<LeadStatus | "">(""); const [label, setLabel] = useState<LeadLabel | "">(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [dialog, setDialog] = useState<"filter" | "date" | "status" | "label" | null>(null);
  const [editing, setEditing] = useState<{ lead: Lead; field: "status" | "label" } | null>(null);

  useEffect(() => {
    let active = true;
    async function loadLeads() {
      setIsLoading(true); setLoadError(null);
      try {
        const response = await fetch("/api/leads/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildFilterBody(quick, status, label, from, to)) });
        if (!response.ok) throw new Error(await readErrorMessage(response, "Leads could not be loaded."));
        const data = (await response.json()) as LeadQueryResponse;
        if (active) { setLeads(data.items.map(toLead)); setTimezone(data.timezone); }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "Leads could not be loaded.");
      } finally {
        if (active) setIsLoading(false);
      }
    }
    void loadLeads();
    return () => { active = false; };
  }, [quick, status, label, from, to]);

  const saveTriageUpdate = async (lead: Lead, field: "status" | "label", value: string) => {
    const previous = leads;
    setLeads((current) => current.map((item) => (item.id !== lead.id ? item : field === "status" ? { ...item, status: value as LeadStatus } : { ...item, label: value as LeadLabel })));
    setEditing(null); setActionError(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [field]: value }) });
      if (!response.ok) throw new Error(await readErrorMessage(response, "The lead could not be updated."));
    } catch (error) { setLeads(previous); setActionError(error instanceof Error ? error.message : "The lead could not be updated."); }
  };

  const download = async () => {
    setActionError(null);
    try {
      const response = await fetch("/api/leads/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildFilterBody(quick, status, label, from, to)) });
      if (!response.ok) throw new Error(await readErrorMessage(response, "Leads could not be exported."));
      const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = "agentzpro-leads.csv"; link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { setActionError(error instanceof Error ? error.message : "Leads could not be exported."); }
  };

  const formatDate = (value: string) => new Intl.DateTimeFormat("en-IN", { timeZone: timezone, dateStyle: "medium" }).format(new Date(value));

  return <div className="mvp-leads"><section className="mvp-filter-actions"><ToolButton icon={<Filter size={17} />} label="Filter" onClick={() => setDialog("filter")} /><ToolButton icon={<CalendarDays size={17} />} label="Date-wise Filter" onClick={() => setDialog("date")} /><ToolButton icon={<Filter size={17} />} label="Status" onClick={() => setDialog("status")} /><ToolButton icon={<Tag size={17} />} label="Label" onClick={() => setDialog("label")} /><button className="button" type="button" onClick={() => void download()}><Download size={17} />Download</button></section>{actionError ? <div className="mvp-inline-error"><span>{actionError}</span><button type="button" onClick={() => setActionError(null)}><X size={15} /></button></div> : null}{quick !== "All Leads" || status || label || from || to ? <div className="mvp-active-filters"><span>Active Filters:</span>{quick !== "All Leads" ? <button type="button" onClick={() => setQuick("All Leads")}>Filter: {quick} <X size={13} /></button> : null}{status ? <button type="button" onClick={() => setStatus("")}>Status: {status} <X size={13} /></button> : null}{label ? <button type="button" onClick={() => setLabel("")}>Label: {label} <X size={13} /></button> : null}{from || to ? <button type="button" onClick={() => { setFrom(""); setTo(""); }}>Date: {from || "…"} – {to || "…"} <X size={13} /></button> : null}<button type="button" className="mvp-clear-all" onClick={() => { setQuick("All Leads"); setStatus(""); setLabel(""); setFrom(""); setTo(""); }}>Clear all</button></div> : null}<section className="mvp-table-wrap"><table className="mvp-table"><thead><tr>{["Client Name", "Phone", "Source", "Status", "Label", "Project", "Date"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{isLoading ? <tr><td className="mvp-empty" colSpan={7}>Loading leads…</td></tr> : loadError ? <tr><td className="mvp-empty" colSpan={7}>{loadError}</td></tr> : leads.length === 0 ? <tr><td className="mvp-empty" colSpan={7}>No leads match these filters.</td></tr> : leads.map((lead) => <tr key={lead.id}><td>{lead.name}</td><td>{lead.phone}</td><td>{lead.source}</td><td><button type="button" className={`mvp-edit-button mvp-edit-button--${tone(lead.status)}`} onClick={() => setEditing({ lead, field: "status" })}>{lead.status}</button></td><td><button type="button" className={`mvp-edit-button mvp-edit-button--${labelTone(lead.label)}`} onClick={() => setEditing({ lead, field: "label" })}>{lead.label}</button></td><td>{lead.project}</td><td>{formatDate(lead.date)}</td></tr>)}</tbody></table></section>{dialog === "filter" ? <Choice title="Filter Leads" values={["All Leads", "Today Leads", "This Month Leads"]} value={quick} instant onCancel={() => setDialog(null)} onSave={(value) => { setQuick(value as Quick); setDialog(null); }} /> : null}{dialog === "status" ? <Choice title="Select Status" values={["All Statuses", ...LEAD_STATUSES]} value={status || "All Statuses"} instant onCancel={() => setDialog(null)} onSave={(value) => { setStatus(value === "All Statuses" ? "" : (value as LeadStatus)); setDialog(null); }} /> : null}{dialog === "label" ? <Choice title="Select Label" values={["All Labels", ...LEAD_LABELS]} value={label || "All Labels"} instant onCancel={() => setDialog(null)} onSave={(value) => { setLabel(value === "All Labels" ? "" : (value as LeadLabel)); setDialog(null); }} /> : null}{dialog === "date" ? <DateDialog from={from} to={to} onCancel={() => setDialog(null)} onSave={(start, end) => { setFrom(start); setTo(end); setQuick("All Leads"); setDialog(null); }} /> : null}{editing ? <Choice title={`Update ${editing.field === "status" ? "Status" : "Label"} — ${editing.lead.name}`} values={editing.field === "status" ? [...LEAD_STATUSES] : [...LEAD_LABELS]} value={editing.lead[editing.field]} instant onCancel={() => setEditing(null)} onSave={(value) => void saveTriageUpdate(editing.lead, editing.field, value)} /> : null}</div>;
}
function ToolButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) { return <button type="button" className="mvp-tool-button" onClick={onClick}>{icon}{label}</button>; }
function Choice({ title, values, value, instant, onCancel, onSave }: { title: string; values: readonly string[]; value: string; instant?: boolean; onCancel: () => void; onSave: (value: string) => void }) { const [selected, setSelected] = useState(value); return <div className="mvp-status-dialog-backdrop"><section className="mvp-status-dialog" role="dialog" aria-modal="true"><header><h2>{title}</h2><button type="button" className="mvp-dialog-close" onClick={onCancel}><X size={18} /></button></header><div className="mvp-status-dialog__options" role="radiogroup">{values.map((item) => <button type="button" role="radio" aria-checked={selected === item} className={selected === item ? "mvp-status-dialog-option mvp-status-dialog-option--selected" : "mvp-status-dialog-option"} key={item} onClick={() => { setSelected(item); if (instant) onSave(item); }}><span className="mvp-status-radio">{selected === item ? <span /> : null}</span><span>{item}</span></button>)}</div>{!instant ? <footer><button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button><button className="button" type="button" onClick={() => onSave(selected)}>Save</button></footer> : null}</section></div>; }
function DateDialog({ from, to, onCancel, onSave }: { from: string; to: string; onCancel: () => void; onSave: (from: string, to: string) => void }) { const [start, setStart] = useState(from); const [end, setEnd] = useState(to); return <div className="mvp-status-dialog-backdrop"><section className="mvp-status-dialog" role="dialog" aria-modal="true"><header><h2>Date-wise Filter</h2><button type="button" className="mvp-dialog-close" onClick={onCancel}><X size={18} /></button></header><div className="mvp-date-dialog"><label>From<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>To<input type="date" min={start || undefined} value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><footer><button className="button" type="button" onClick={() => onSave(start, end)}>Apply</button></footer></section></div>; }
function tone(value: LeadStatus): string { return value === "New Lead" || value === "Archived" || value === "Disqualified" ? "red" : value === "Not reachable" || value === "Site visit pending" || value === "Final call" ? "yellow" : value === "Working" || value === "Next project" || value === "Didn't pick the call" ? "pink" : value === "Closed" ? "teal" : value === "Sale" || value === "Site visit done" || value === "Details send via WhatsApp" ? "green" : "blue"; }
function labelTone(value: LeadLabel): string { return value === "Hot" ? "red" : value === "Warm" ? "yellow" : value === "Cold" ? "blue" : "gray"; }
