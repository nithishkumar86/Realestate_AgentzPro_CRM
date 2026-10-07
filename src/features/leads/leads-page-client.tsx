"use client";

import { Download, ListTodo, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LEAD_LABELS, LEAD_STATUSES, isFinalLeadStatus, type LeadLabel, type LeadStatus } from "@/features/leads/lead-options";
import { LeadDrawer } from "@/features/leads/lead-drawer";
import { LeadActiveFilters, LeadFilterBar } from "@/features/leads/lead-filters";
import { RowDropdown } from "@/features/leads/row-dropdown";
import { readError, useLeadFilters } from "@/features/leads/use-lead-filters";

type LeadLabelSource = "default" | "ai" | "telecaller";
type Lead = { id: string; leadName: string | null; phone: string | null; email?: string | null; facebookPage: string; adName: string; leadDate: string; status: LeadStatus; label: LeadLabel; labelSource: LeadLabelSource; assignedUserId?: string | null; assigneeName?: string | null; hasOpenTask?: boolean; openTaskTitle?: string | null };

/** Who owns the lead: initial + name, or a quiet "Unassigned". Changed from the lead's detail drawer. */
function AssigneeCell({ name }: { name: string | null }) {
  if (!name) return <span className="mvp-assignee mvp-assignee--none">Unassigned</span>;
  return <span className="mvp-assignee" title={name}>
    <span className="mvp-assignee__avatar" aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>
    <span className="mvp-assignee__name">{name}</span>
  </span>;
}

export function LeadsPageClient() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  // Which row's Status/Label panel is open ("<leadId>:status" | "<leadId>:label"); only one at a time.
  const [openRowDropdown, setOpenRowDropdown] = useState<string | null>(null);
  // The lead whose detail drawer (timeline, notes, task) is open.
  const [drawerLeadId, setDrawerLeadId] = useState<string | null>(null);
  // A status picked in the table row. It is not saved: the drawer opens with it as a pending choice, and it is saved
  // only together with a task or a note (so the timeline never shows a status change nobody followed up).
  const [drawerPendingStatus, setDrawerPendingStatus] = useState<LeadStatus | null>(null);
  // The leads page opens on ALL leads with no filter applied; the shared hook owns the filter state and its options.
  const filters = useLeadFilters({ autoSelectDefaultAd: false, onError: setError });
  const { quick, status, label, assignee, from, to, pageRecordId, adId, search } = filters;

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
  }, [quick, status, label, assignee, from, to, pageRecordId, adId, search]);

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

  /**
   * Picking a status in a row saves nothing. It opens the lead's drawer with the choice pending, so the telecaller
   * adds the follow-up (step 2 task / step 3 note) that the status is saved with. The row's dropdown stays bound to
   * lead.status, so it keeps showing the saved status until then.
   */
  function updateStatus(leadId: string, currentStatus: LeadStatus, nextStatus: LeadStatus): void {
    if (nextStatus === currentStatus) return;
    setDrawerPendingStatus(nextStatus);
    setDrawerLeadId(leadId);
  }

  const applyStatus = useCallback((leadId: string, nextStatus: LeadStatus) => {
    setLeads((current) => current.map((existing) => existing.id === leadId ? { ...existing, status: nextStatus } : existing));
  }, []);
  const applyOpenTask = useCallback((leadId: string, hasOpenTask: boolean, title?: string | null) => {
    setLeads((current) => current.map((existing) => existing.id === leadId ? { ...existing, hasOpenTask, openTaskTitle: hasOpenTask ? title ?? existing.openTaskTitle ?? null : null } : existing));
  }, []);
  const applyAssignee = useCallback((leadId: string, assignedUserId: string | null, assigneeName: string | null) => {
    setLeads((current) => current.map((existing) => existing.id === leadId ? { ...existing, assignedUserId, assigneeName } : existing));
  }, []);
  const closeDrawer = useCallback(() => setDrawerLeadId(null), []);
  const drawerLead = drawerLeadId ? leads.find((lead) => lead.id === drawerLeadId) ?? null : null;

  return <div className="mvp-leads">
    <LeadFilterBar filters={filters} showAssignee actions={<>
      <button className="mvp-gradient-button mvp-gradient-button--delete" type="button" disabled={selectedLeadIds.length === 0 || isDeleting} onClick={() => void deleteSelectedLeads()}>
        <Trash2 size={16} />{isDeleting ? "Deleting..." : selectedLeadIds.length > 0 ? `Delete (${selectedLeadIds.length})` : "Delete"}
      </button>
      <button className="mvp-gradient-button mvp-gradient-button--download" type="button" onClick={() => void download()}>
        <Download size={16} />Download
      </button>
    </>} />
    {error ? <div className="mvp-inline-error">{error}</div> : null}
    <LeadActiveFilters filters={filters} />
    <section className="mvp-table-wrap"><table className="mvp-table"><thead><tr><th aria-hidden="true" />{["Client Name", "Phone", "Page", "Ad Name", "Assigned To", "Status", "Label", "Date"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
      {loading ? <tr><td className="mvp-empty" colSpan={9}>Loading leads...</td></tr> : null}
      {!loading && leads.length === 0 ? <tr><td className="mvp-empty" colSpan={9}>No leads match these filters.</td></tr> : null}
      {leads.map((lead) => <tr key={lead.id}><td><input type="checkbox" aria-label={`Select ${lead.leadName ?? "Unnamed Lead"}`} checked={selectedLeadIds.includes(lead.id)} onChange={() => toggleLeadSelection(lead.id)} /></td><td><span className="mvp-lead-name-cell">
        <button type="button" className="mvp-lead-name-button" onClick={() => { setDrawerPendingStatus(null); setDrawerLeadId(lead.id); }} aria-label={`Open details for ${lead.leadName ?? "Unnamed Lead"}`}>{lead.leadName ?? "Unnamed Lead"}</button>
        {lead.hasOpenTask === false && !isFinalLeadStatus(lead.status) ? <span className="mvp-no-task-marker" title="No follow-up scheduled">No task</span> : null}
        {lead.hasOpenTask && lead.openTaskTitle ? <span className="mvp-lead-task-title" title={`Task: ${lead.openTaskTitle}`}><ListTodo size={12} aria-hidden="true" /><span>{lead.openTaskTitle}</span></span> : null}
      </span></td><td>{lead.phone ?? "-"}</td><td>{lead.facebookPage}</td><td>{lead.adName}</td><td>
        <AssigneeCell name={lead.assigneeName ?? null} />
      </td><td>
        <RowDropdown ariaLabel={`Change status for ${lead.leadName ?? "Unnamed Lead"}`} value={lead.status} options={LEAD_STATUSES} width={200}
          open={openRowDropdown === `${lead.id}:status`} onOpenChange={(next) => setOpenRowDropdown(next ? `${lead.id}:status` : null)}
          onChange={(next) => void updateStatus(lead.id, lead.status, next)} />
      </td><td className="mvp-label-cell">
        <RowDropdown ariaLabel={`Change label for ${lead.leadName ?? "Unnamed Lead"}`} value={lead.label} options={LEAD_LABELS} width={140}
          open={openRowDropdown === `${lead.id}:label`} onOpenChange={(next) => setOpenRowDropdown(next ? `${lead.id}:label` : null)}
          onChange={(next) => void updateLabel(lead.id, lead.label, next)} />
        {lead.labelSource === "ai" ? <span className="mvp-label-source mvp-label-source--ai" title="Set by AI">AI</span> : null}
        {lead.labelSource === "telecaller" ? <span className="mvp-label-source mvp-label-source--telecaller" title="Set by a telecaller">Telecaller</span> : null}
      </td><td>{new globalThis.Date(lead.leadDate).toLocaleDateString("en-IN", { timeZone: timezone })}</td></tr>)}
    </tbody></table></section>
    {drawerLead ? <LeadDrawer key={drawerLead.id} lead={drawerLead} initialPendingStatus={drawerPendingStatus ?? undefined} timezone={timezone} onClose={closeDrawer} assignees={filters.options.assignees} onAssigneeChange={applyAssignee} onStatusChange={applyStatus} onOpenTaskChange={applyOpenTask} /> : null}
  </div>;
}
