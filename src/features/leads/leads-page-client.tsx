"use client";

import { Download, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { LEAD_LABELS, type LeadLabel, type LeadStatus } from "@/features/leads/lead-options";
import { LeadActiveFilters, LeadFilterBar } from "@/features/leads/lead-filters";
import { readError, useLeadFilters } from "@/features/leads/use-lead-filters";

type LeadLabelSource = "default" | "ai" | "telecaller";
type Lead = { id: string; leadName: string | null; phone: string | null; facebookPage: string; adName: string; leadDate: string; status: LeadStatus; label: LeadLabel; labelSource: LeadLabelSource };

export function LeadsPageClient() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  // The leads page opens on the newest lead's ad; the shared hook owns the filter state and its options.
  const filters = useLeadFilters({ autoSelectDefaultAd: true, onError: setError });
  const { quick, status, label, from, to, pageRecordId, adId, search } = filters;

  useEffect(() => {
    let active = true;
    async function loadLeads() {
      setLoading(true);
      try {
        const response = await fetch("/api/leads/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...filters.filterBody(), pageSize: 100 }) });
        if (!response.ok) throw new Error(await readError(response, "Leads could not be loaded."));
        const result = await response.json() as { items: Lead[]; timezone: string };
        if (active) { setLeads(result.items); setTimezone(result.timezone); setSelectedLeadIds([]); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Leads could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    void loadLeads();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterBody() is a pure function of exactly these values
  }, [quick, status, label, from, to, pageRecordId, adId, search]);

  async function download(): Promise<void> {
    try {
      // The export sends the same filters as the table (no pagination fields: its strict schema rejects them),
      // so a download can never disagree with the rows on screen.
      const response = await fetch("/api/leads/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(filters.filterBody()) });
      if (!response.ok) throw new Error(await readError(response, "Leads could not be exported."));
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
      link.href = url; link.download = "agentzpro-leads.csv"; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Leads could not be exported."); }
  }

  const toggleLeadSelection = (leadId: string) => {
    setSelectedLeadIds((current) => current.includes(leadId) ? current.filter((id) => id !== leadId) : [...current, leadId]);
  };

  /**
   * Deletes every checked lead. Irreversible, so a browser confirm popup names the count and warns
   * the data can never be recovered before anything is sent; a second popup confirms once the
   * database rows are actually gone.
   */
  async function deleteSelectedLeads(): Promise<void> {
    if (selectedLeadIds.length === 0) return;
    const count = selectedLeadIds.length;
    const warned = globalThis.confirm(`Delete ${count} lead${count === 1 ? "" : "s"}? This cannot be undone and the data can never be recovered.`);
    if (!warned) return;
    setIsDeleting(true);
    try {
      const responses = await Promise.all(selectedLeadIds.map((id) => fetch(`/api/leads/${id}`, { method: "DELETE" })));
      const failed = responses.find((response) => !response.ok);
      if (failed) throw new Error(await readError(failed, "Selected leads could not be deleted."));
      setLeads((current) => current.filter((lead) => !selectedLeadIds.includes(lead.id)));
      setSelectedLeadIds([]);
      globalThis.alert(`${count} lead${count === 1 ? "" : "s"} deleted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Selected leads could not be deleted.");
    } finally {
      setIsDeleting(false);
    }
  }

  /**
   * A label change is the same "you're about to finalize something" shape as the bulk delete
   * above: a browser confirm popup names exactly what will change before anything is sent, and a
   * telecaller's choice here is final — it is the only thing that ever overrides the AI's label
   * (label_source flips to "telecaller" automatically in the database and is never touched again).
   * The <select> stays bound to lead.label, so declining the popup needs no separate revert: React
   * simply re-renders it back to the unchanged state.
   */
  async function updateLabel(leadId: string, currentLabel: LeadLabel, nextLabel: LeadLabel): Promise<void> {
    if (nextLabel === currentLabel) return;
    const warned = globalThis.confirm(`Change label from ${currentLabel} to ${nextLabel}? This will be saved as the final label.`);
    if (!warned) return;
    try {
      const response = await fetch(`/api/leads/${leadId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: nextLabel }) });
      if (!response.ok) throw new Error(await readError(response, "The label could not be updated."));
      const updated = await response.json() as { label: LeadLabel; labelSource: LeadLabelSource };
      setLeads((current) => current.map((existing) => existing.id === leadId ? { ...existing, label: updated.label, labelSource: updated.labelSource } : existing));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The label could not be updated.");
    }
  }

  return <div className="mvp-leads">
    <LeadFilterBar filters={filters} actions={<>
      <button className="mvp-gradient-button mvp-gradient-button--delete" type="button" disabled={selectedLeadIds.length === 0 || isDeleting} onClick={() => void deleteSelectedLeads()}>
        <Trash2 size={16} />{isDeleting ? "Deleting..." : selectedLeadIds.length > 0 ? `Delete (${selectedLeadIds.length})` : "Delete"}
      </button>
      <button className="mvp-gradient-button mvp-gradient-button--download" type="button" onClick={() => void download()}>
        <Download size={16} />Download
      </button>
    </>} />
    {error ? <div className="mvp-inline-error">{error}</div> : null}
    <LeadActiveFilters filters={filters} />
    <section className="mvp-table-wrap"><table className="mvp-table"><thead><tr><th aria-hidden="true" />{["Client Name", "Phone", "Page", "Ad Name", "Status", "Label", "Date"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
      {loading ? <tr><td className="mvp-empty" colSpan={8}>Loading leads...</td></tr> : null}
      {!loading && leads.length === 0 ? <tr><td className="mvp-empty" colSpan={8}>No leads match these filters.</td></tr> : null}
      {leads.map((lead) => <tr key={lead.id}><td><input type="checkbox" aria-label={`Select ${lead.leadName ?? "Unnamed Lead"}`} checked={selectedLeadIds.includes(lead.id)} onChange={() => toggleLeadSelection(lead.id)} /></td><td>{lead.leadName ?? "Unnamed Lead"}</td><td>{lead.phone ?? "-"}</td><td>{lead.facebookPage}</td><td>{lead.adName}</td><td>{lead.status}</td><td className="mvp-label-cell">
        <select className="mvp-label-select" aria-label={`Change label for ${lead.leadName ?? "Unnamed Lead"}`} value={lead.label} onChange={(event) => void updateLabel(lead.id, lead.label, event.target.value as LeadLabel)}>
          {LEAD_LABELS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {lead.labelSource === "ai" ? <span className="mvp-label-source mvp-label-source--ai" title="Set by AI">AI</span> : null}
        {lead.labelSource === "telecaller" ? <span className="mvp-label-source mvp-label-source--telecaller" title="Set by a telecaller">Telecaller</span> : null}
      </td><td>{new globalThis.Date(lead.leadDate).toLocaleDateString("en-IN", { timeZone: timezone })}</td></tr>)}
    </tbody></table></section>
  </div>;
}
