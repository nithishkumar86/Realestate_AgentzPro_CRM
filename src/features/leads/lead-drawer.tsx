"use client";

import { BookOpen, Mail, Megaphone, Phone, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LEAD_STATUSES, NOTE_MAX_LENGTH, TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH, isFinalLeadStatus, type LeadStatus } from "@/features/leads/lead-options";
import { LeadRequestError, fetchOpenTask, formatActivityTime, formatTaskDate, offerToCancelOpenTask, todayIn, updateTask } from "@/features/leads/lead-task-client";
import { LeadTimeline, type LeadTimelineHandle } from "@/features/leads/lead-timeline";
import { RowDropdown } from "@/features/leads/row-dropdown";
import { readError } from "@/features/leads/use-lead-filters";
import type { LeadTask } from "@/lib/server/lead-timeline-service";

export interface DrawerLead { id: string; leadName: string | null; phone: string | null; email?: string | null; facebookPage: string; adName: string; leadDate?: string; label?: string; status: LeadStatus }

/** Colour of the status banner: where the lead is in the pipeline at a glance (UI only). */
const STATUS_TONES: Partial<Record<LeadStatus, "blue" | "green" | "yellow" | "red" | "gray">> = {
  "New Lead": "blue",
  Working: "yellow", "Details send via WhatsApp": "yellow", "Site visit pending": "yellow", "Final call": "yellow", "Next project": "yellow",
  Sale: "green", "Site visit done": "green",
  "Not reachable": "red", "Didn't pick the call": "red", Disqualified: "red",
  Closed: "gray", Archived: "gray",
};

const LABEL_PILLS: Record<string, string> = { Hot: "red", Warm: "yellow", Cold: "blue", "Not Interested": "gray" };

function initialsOf(name: string | null): string {
  const letters = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  return letters || "?";
}

function FactTile({ icon: Icon, label, children, wide }: { icon: LucideIcon; label: string; children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "mvp-lead-fact mvp-lead-fact--wide" : "mvp-lead-fact"}>
    <span className="mvp-lead-fact__icon" aria-hidden="true"><Icon size={16} /></span>
    <div className="mvp-lead-fact__text"><dt>{label}</dt><dd>{children}</dd></div>
  </div>;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Lead detail drawer: header with the status picker, a note box, the lead's single follow-up task, and the
 * timeline. Every write goes through the tenant-scoped API routes; the timeline rows themselves are written
 * by the database, so after each change the drawer only asks the timeline to refresh.
 */
export function LeadDrawer({ lead, timezone, onClose, onStatusChange, onOpenTaskChange, showLatest }: {
  lead: DrawerLead;
  timezone: string;
  onClose: () => void;
  onStatusChange: (leadId: string, status: LeadStatus) => void;
  onOpenTaskChange: (leadId: string, hasOpenTask: boolean, title?: string | null) => void;
  /** Scroll to the newest timeline entry once it loads (the drawer was opened by a status change). */
  showLatest?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const timelineRef = useRef<LeadTimelineHandle>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes the drawer (unless the status list is open — it closes itself first); Tab stays inside.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !statusOpen) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); };
  }, [onClose, statusOpen]);

  const refreshTimeline = useCallback(() => { void timelineRef.current?.refresh(); }, []);

  const tasks = useLeadTask(lead.id, (hasOpenTask, title) => onOpenTaskChange(lead.id, hasOpenTask, title), refreshTimeline);

  /** Saves at once (no confirmation: the new timeline entry is the visible record); a final status then offers to cancel the open task. */
  async function changeStatus(next: LeadStatus): Promise<void> {
    if (next === lead.status) return;
    setError(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!response.ok) throw new Error(await readError(response, "The status could not be updated."));
      const updated = await response.json() as { status: LeadStatus };
      onStatusChange(lead.id, updated.status);
      refreshTimeline();
      if (isFinalLeadStatus(updated.status) && tasks.openTask) {
        const stillOpen = await offerToCancelOpenTask(lead.id, updated.status);
        if (!stillOpen) await tasks.reload();
      }
    } catch (cause) {
      setError(message(cause, "The status could not be updated."));
    }
  }

  return <>
    <div className="mvp-lead-drawer-backdrop" onPointerDown={onClose} />
    <aside ref={panelRef} className="mvp-detail-panel mvp-lead-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="mvp-detail-panel__header">
        <div>
          <span className="mvp-lead-drawer__eyebrow">Lead</span>
          <h2 id={titleId}>{lead.leadName ?? "Unnamed Lead"}</h2>
        </div>
        <button ref={closeRef} type="button" className="mvp-profile-dialog__close" aria-label="Close lead details" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="mvp-detail-panel__body">
        {error ? <div className="mvp-inline-error" role="alert">{error}</div> : null}
        <section className="mvp-lead-profile" aria-label="Lead details">
          <div className="mvp-lead-profile__head">
            <span className="mvp-lead-profile__avatar" aria-hidden="true">{initialsOf(lead.leadName)}</span>
            <div className="mvp-lead-profile__who">
              <strong>{lead.leadDate ? "Lead received" : "Lead details"}</strong>
              {lead.leadDate ? <span>{formatActivityTime(lead.leadDate, timezone)}</span> : null}
            </div>
            {lead.label ? <span className={`mvp-pill mvp-pill--${LABEL_PILLS[lead.label] ?? "gray"}`}>{lead.label}</span> : null}
          </div>
          <dl className="mvp-lead-profile__grid">
            <FactTile icon={Phone} label="Phone">{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : "-"}</FactTile>
            <FactTile icon={BookOpen} label="Page">{lead.facebookPage}</FactTile>
            <FactTile icon={Mail} label="Email" wide>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "-"}</FactTile>
            <FactTile icon={Megaphone} label="Ad" wide>{lead.adName}</FactTile>
          </dl>
          <div className="mvp-lead-status" data-tone={STATUS_TONES[lead.status] ?? "gray"}>
            <div className="mvp-lead-status__head">
              <span className="mvp-lead-status__dot" aria-hidden="true" />
              <span className="mvp-lead-status__title">Current status</span>
            </div>
            <RowDropdown ariaLabel={`Change status for ${lead.leadName ?? "Unnamed Lead"}`} value={lead.status} options={LEAD_STATUSES} width={220}
              open={statusOpen} onOpenChange={setStatusOpen} onChange={(next) => void changeStatus(next)} />
            <p className="mvp-lead-status__hint">Update it after every call, then add the next task and a note.</p>
          </div>
        </section>

        <TaskCard leadId={lead.id} timezone={timezone} tasks={tasks} />
        <NoteForm leadId={lead.id} onSaved={refreshTimeline} />
        <LeadTimeline ref={timelineRef} leadId={lead.id} timezone={timezone} scrollToLatest={showLatest} />
      </div>
    </aside>
  </>;
}

type LeadTaskState = ReturnType<typeof useLeadTask>;

/** The lead's one open task: loading (undefined), none (null) or the task. */
function useLeadTask(leadId: string, onOpenTaskChange: (hasOpenTask: boolean, title?: string | null) => void, onChanged: () => void) {
  const [openTask, setOpenTask] = useState<LeadTask | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set right after a task is completed or cancelled: prompts the next step until a new task is added.
  const [justClosed, setJustClosed] = useState(false);
  const reportRef = useRef(onOpenTaskChange);
  useEffect(() => { reportRef.current = onOpenTaskChange; }, [onOpenTaskChange]);

  const reload = useCallback(async () => {
    try {
      const task = await fetchOpenTask(leadId);
      setOpenTask(task);
      setLoadError(null);
      reportRef.current(task !== null, task?.title ?? null);
    } catch (cause) {
      setLoadError(message(cause, "The task could not be loaded."));
    }
  }, [leadId]);

  // First load for this lead. Inline so the state updates happen only after the request resolves.
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const task = await fetchOpenTask(leadId);
        if (!active) return;
        setOpenTask(task);
        setLoadError(null);
        reportRef.current(task !== null, task?.title ?? null);
      } catch (cause) {
        if (active) setLoadError(message(cause, "The task could not be loaded."));
      }
    }
    void load();
    return () => { active = false; };
  }, [leadId]);

  return { openTask, loadError, justClosed, setJustClosed, setOpenTask, reload, onChanged, report: (hasOpenTask: boolean, title?: string | null) => reportRef.current(hasOpenTask, title) };
}

function TaskCard({ leadId, timezone, tasks }: { leadId: string; timezone: string; tasks: LeadTaskState }) {
  const { openTask } = tasks;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescheduleTo, setRescheduleTo] = useState<string | null>(null);

  async function handleFailure(cause: unknown, fallback: string) {
    setError(message(cause, fallback));
    // 409: the task changed elsewhere (closed, or another one was opened). Show the current state.
    if (cause instanceof LeadRequestError && cause.status === 409) await tasks.reload();
  }

  async function close(action: "complete" | "cancel") {
    if (!openTask) return;
    const prompt = action === "complete" ? `Mark "${openTask.title}" as complete? This cannot be undone.` : `Cancel "${openTask.title}"? This cannot be undone.`;
    if (!globalThis.confirm(prompt)) return;
    setBusy(true); setError(null);
    try {
      await updateTask(leadId, openTask.id, { action }, action === "complete" ? "The task could not be completed." : "The task could not be cancelled.");
      tasks.setOpenTask(null);
      tasks.setJustClosed(true);
      tasks.report(false);
      tasks.onChanged();
    } catch (cause) {
      await handleFailure(cause, "The task could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function reschedule(event: FormEvent) {
    event.preventDefault();
    if (!openTask || !rescheduleTo) return;
    setBusy(true); setError(null);
    try {
      const updated = await updateTask(leadId, openTask.id, { dueDate: rescheduleTo }, "The task could not be rescheduled.");
      tasks.setOpenTask(updated);
      setRescheduleTo(null);
      tasks.onChanged();
    } catch (cause) {
      await handleFailure(cause, "The task could not be rescheduled.");
    } finally {
      setBusy(false);
    }
  }

  const overdue = openTask ? openTask.dueDate < todayIn(timezone) : false;

  return <section className="mvp-task-card" aria-label="Follow-up task">
    <h3 className="mvp-lead-drawer__section-title">Follow-up task</h3>
    {error ? <div className="mvp-inline-error" role="alert">{error}</div> : null}
    {tasks.loadError ? <div className="mvp-inline-error" role="alert">{tasks.loadError}<button type="button" onClick={() => void tasks.reload()}>Retry</button></div> : null}
    {openTask === undefined && !tasks.loadError ? <p className="mvp-timeline__empty">Loading task...</p> : null}
    {openTask ? <div className="mvp-task-card__open">
      <div className="mvp-task-card__heading">
        <strong>{openTask.title}</strong>
        {overdue ? <span className="mvp-pill mvp-pill--red">Overdue</span> : <span className="mvp-pill mvp-pill--blue">Open</span>}
      </div>
      {openTask.description ? <p className="mvp-task-card__description">{openTask.description}</p> : null}
      <p className="mvp-task-card__dates">{formatTaskDate(openTask.startDate)} → {formatTaskDate(openTask.dueDate)}</p>
      {rescheduleTo !== null ? <form className="mvp-task-card__reschedule" onSubmit={(event) => void reschedule(event)}>
        <label className="mvp-task-card__field"><span>New due date</span>
          <input className="mvp-settings-input" type="date" required min={openTask.startDate} value={rescheduleTo} onChange={(event) => setRescheduleTo(event.target.value)} />
        </label>
        <div className="mvp-task-card__actions">
          <button type="submit" className="mvp-task-button mvp-task-button--primary" disabled={busy || !rescheduleTo || rescheduleTo === openTask.dueDate}>Save date</button>
          <button type="button" className="mvp-task-button" disabled={busy} onClick={() => setRescheduleTo(null)}>Keep current date</button>
        </div>
      </form> : <div className="mvp-task-card__actions">
        <button type="button" className="mvp-task-button mvp-task-button--primary" disabled={busy} onClick={() => void close("complete")}>Mark complete</button>
        <button type="button" className="mvp-task-button" disabled={busy} onClick={() => setRescheduleTo(openTask.dueDate)}>Reschedule</button>
        <button type="button" className="mvp-task-button mvp-task-button--danger" disabled={busy} onClick={() => void close("cancel")}>Cancel task</button>
      </div>}
    </div> : null}
    {openTask === null ? <NewTaskForm leadId={leadId} timezone={timezone} tasks={tasks} /> : null}
  </section>;
}

function NewTaskForm({ leadId, timezone, tasks }: { leadId: string; timezone: string; tasks: LeadTaskState }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(() => todayIn(timezone));
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !startDate || !dueDate) return;
    if (dueDate < startDate) { setError("The due date must be on or after the start date."); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null, startDate, dueDate }),
      });
      if (!response.ok) {
        const failure = new LeadRequestError(await readError(response, "The task could not be saved."), response.status);
        setError(failure.message);
        if (failure.status === 409) await tasks.reload();
        return;
      }
      tasks.setOpenTask(await response.json() as LeadTask);
      tasks.setJustClosed(false);
      tasks.report(true, title.trim());
      tasks.onChanged();
    } catch (cause) {
      setError(message(cause, "The task could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return <form className="mvp-task-card__form" onSubmit={(event) => void submit(event)}>
    {tasks.justClosed ? <p className="mvp-task-card__next" role="status">Add next task or close the lead</p> : <p className="mvp-timeline__empty">No open task for this lead.</p>}
    {error ? <div className="mvp-inline-error" role="alert">{error}</div> : null}
    <label className="mvp-task-card__field"><span>Title</span>
      <input className="mvp-settings-input" required maxLength={TASK_TITLE_MAX_LENGTH} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Call back about site visit" />
    </label>
    <label className="mvp-task-card__field"><span>Description <em>(optional)</em></span>
      <textarea className="mvp-settings-input mvp-lead-drawer__textarea" rows={3} maxLength={TASK_DESCRIPTION_MAX_LENGTH} value={description}
        onChange={(event) => setDescription(event.target.value)} placeholder="What needs to be done between the start and due dates" />
    </label>
    <div className="mvp-task-card__dates-row">
      <label className="mvp-task-card__field"><span>Start date</span>
        <input className="mvp-settings-input" type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} />
      </label>
      <label className="mvp-task-card__field"><span>Due date</span>
        <input className="mvp-settings-input" type="date" required min={startDate || undefined} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
      </label>
    </div>
    <div className="mvp-task-card__actions">
      <button type="submit" className="mvp-task-button mvp-task-button--primary" disabled={busy || !title.trim() || !startDate || !dueDate}>{busy ? "Saving..." : "Add task"}</button>
    </div>
  </form>;
}

function NoteForm({ leadId, onSaved }: { leadId: string; onSaved: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: text }) });
      if (!response.ok) throw new Error(await readError(response, "The note could not be saved."));
      setBody("");
      onSaved();
    } catch (cause) {
      setError(message(cause, "The note could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return <form className="mvp-note-form" onSubmit={(event) => void submit(event)}>
    <label htmlFor={noteId} className="mvp-lead-drawer__section-title">Add a note</label>
    {error ? <div className="mvp-inline-error" role="alert">{error}</div> : null}
    <textarea id={noteId} className="mvp-settings-input mvp-lead-drawer__textarea" rows={3} maxLength={NOTE_MAX_LENGTH} value={body}
      onChange={(event) => setBody(event.target.value)} placeholder="What did the customer say?" />
    <div className="mvp-note-form__footer">
      <span className="mvp-note-form__count">{body.length}/{NOTE_MAX_LENGTH}</span>
      <button type="submit" className="mvp-task-button mvp-task-button--primary" disabled={busy || !body.trim()}>{busy ? "Saving..." : "Save note"}</button>
    </div>
    <p className="mvp-note-form__hint">Notes can&apos;t be edited or deleted once saved.</p>
  </form>;
}
