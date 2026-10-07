"use client";

import { BookOpen, Check, ChevronDown, Lock, Mail, Megaphone, Phone, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LEAD_STATUSES, NOTE_MAX_LENGTH, TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH, isFinalLeadStatus, isTaskCreationLocked, type LeadStatus } from "@/features/leads/lead-options";
import { LeadRequestError, fetchOpenTask, formatActivityTime, formatTaskDate, offerToCancelOpenTask, todayIn, updateTask } from "@/features/leads/lead-task-client";
import { LeadTimeline, type LeadTimelineHandle } from "@/features/leads/lead-timeline";
import { RowDropdown } from "@/features/leads/row-dropdown";
import { readError, type AssigneeOption } from "@/features/leads/use-lead-filters";
import type { LeadTask } from "@/lib/server/lead-timeline-service";

export interface DrawerLead { id: string; leadName: string | null; phone: string | null; email?: string | null; facebookPage: string; adName: string; leadDate?: string; label?: string; status: LeadStatus; assignedUserId?: string | null; assigneeName?: string | null }

/** Colour of the status banner: where the lead is in the pipeline at a glance (UI only). */
const STATUS_TONES: Partial<Record<LeadStatus, "blue" | "green" | "yellow" | "red" | "gray">> = {
  "New Lead": "blue",
  Working: "yellow", "Details send via WhatsApp": "yellow", "Site visit pending": "yellow", "Final call": "yellow", "Next project": "yellow",
  Sale: "green", "Site visit done": "green",
  "Not reachable": "red", "Didn't pick the call": "red", Disqualified: "red",
  Closed: "gray", Archived: "gray",
};

const LABEL_PILLS: Record<string, string> = { Hot: "red", Warm: "yellow", Cold: "blue", "Not Interested": "gray" };

const DRAWER_MIN_WIDTH = 520;
const DRAWER_MAX_WIDTH = 760;

function clampDrawerWidth(width: number): number {
  const viewport = typeof window === "undefined" ? DRAWER_MAX_WIDTH : window.innerWidth - 48;
  return Math.round(Math.max(DRAWER_MIN_WIDTH, Math.min(width, DRAWER_MAX_WIDTH, viewport)));
}

/**
 * The drawer's width, which the user changes by dragging its left edge (or with the arrow keys on that edge).
 * The width lasts only while the drawer is open: every time it opens it is back at the default, and a double click resets it too.
 */
function useDrawerWidth() {
  const [width, setWidth] = useState(DRAWER_MIN_WIDTH);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => () => document.body.classList.remove("mvp-drawer-resizing"), []);

  return {
    width,
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { startX: event.clientX, startWidth: width };
      document.body.classList.add("mvp-drawer-resizing");
    },
    onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      if (!drag.current) return;
      // The drawer is anchored to the right edge, so dragging left makes it wider.
      setWidth(clampDrawerWidth(drag.current.startWidth + (drag.current.startX - event.clientX)));
    },
    onPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
      if (!drag.current) return;
      const next = clampDrawerWidth(drag.current.startWidth + (drag.current.startX - event.clientX));
      drag.current = null;
      document.body.classList.remove("mvp-drawer-resizing");
      setWidth(next);
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const next = clampDrawerWidth(width + (event.key === "ArrowLeft" ? 40 : -40));
      setWidth(next);
    },
    reset() { setWidth(DRAWER_MIN_WIDTH); },
  };
}

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

type StepKey = "status" | "task" | "note";
type StepProgress = Record<StepKey, boolean>;
const STEP_ORDER: readonly StepKey[] = ["status", "task", "note"];

/** Numbered circle that turns into a tick once the step is done. The state is spoken too, not just drawn. */
function StepBadge({ number, done }: { number: number; done: boolean }) {
  return <span className="mvp-step-badge" data-done={done || undefined}>
    {done ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : <span aria-hidden="true">{number}</span>}
    <span className="sr-only">{done ? `Step ${number} done` : `Step ${number}`}</span>
  </span>;
}

/**
 * One step of the vertical 1-2-3 a telecaller follows after each call: the badge sits on a rail that joins it to
 * the next step and turns green once this step is done. Ticks mean "done during this visit to the lead": they
 * start empty every time the drawer opens. The first step not yet done is the current one. The badge is the
 * only place progress is announced to screen readers.
 */
function StepItem({ number, done, current, children }: { number: number; done: boolean; current: boolean; children: ReactNode }) {
  return <li className="mvp-flow__item" data-done={done || undefined} data-current={current || undefined} aria-current={current ? "step" : undefined}>
    <StepBadge number={number} done={done} />
    <div className="mvp-flow__body">{children}</div>
  </li>;
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
export function LeadDrawer({ lead, timezone, assignees = [], onClose, onStatusChange, onOpenTaskChange, onAssigneeChange, initialPendingStatus }: {
  lead: DrawerLead;
  timezone: string;
  /** Active members the lead can be assigned to. The "Assigned to" card shows only when onAssigneeChange is given. */
  assignees?: AssigneeOption[];
  onClose: () => void;
  /**
   * A status picked in the leads table. It is NOT saved: the drawer opens with it as a pending choice, exactly as
   * if it had been picked inside the drawer, and it is saved only together with a task or a note.
   */
  initialPendingStatus?: LeadStatus;
  onStatusChange: (leadId: string, status: LeadStatus) => void;
  onOpenTaskChange: (leadId: string, hasOpenTask: boolean, title?: string | null) => void;
  onAssigneeChange?: (leadId: string, assignedUserId: string | null, assigneeName: string | null) => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const timelineRef = useRef<LeadTimelineHandle>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A status the telecaller picked but has not saved. It is saved only when a task or a note is saved with it, so the
  // timeline never shows a status change nobody followed up; closing the drawer simply drops it.
  const pendingRef = useRef<LeadStatus | null>(initialPendingStatus ?? null);
  const [pendingStatus, setPendingStatus] = useState<LeadStatus | null>(initialPendingStatus ?? null);
  const [committing, setCommitting] = useState(false);
  const savedStatusRef = useRef(false);
  const displayStatus = pendingStatus ?? lead.status;
  // Which of the three steps were completed in this visit. The drawer is unmounted when it closes, so this resets each time it opens.
  const [progress, setProgress] = useState<StepProgress>({ status: initialPendingStatus !== undefined, task: false, note: false });
  const markDone = useCallback((step: StepKey) => setProgress((current) => current[step] ? current : { ...current, [step]: true }), []);
  // Going back to "New Lead" un-does step 1: the task form is locked again, so the tick must not stay.
  const shown: StepProgress = { ...progress, status: progress.status && !isTaskCreationLocked(displayStatus) };
  const currentStep = STEP_ORDER.find((step) => !shown[step]);

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

  /** The pending status is now saved (by the server): it becomes the lead's real status everywhere. */
  const applySavedStatus = useCallback((status: LeadStatus) => {
    savedStatusRef.current = true;
    pendingRef.current = null;
    setPendingStatus(null);
    onStatusChange(lead.id, status);
    refreshTimeline();
  }, [lead.id, onStatusChange, refreshTimeline]);

  /**
   * Saves the pending status, if there is one. Called right after a follow-up (a note, or a change to the open
   * task) has been saved; the follow-up goes first so a failure here can never leave a status change on its own.
   * Resolves with the saved status, or null when nothing was pending; throws when the save fails (the choice stays pending).
   */
  const commitPendingStatus = useCallback(async (): Promise<LeadStatus | null> => {
    const next = pendingRef.current;
    if (!next) return null;
    setCommitting(true);
    try {
      const response = await fetch(`/api/leads/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!response.ok) throw new Error(`Saved, but the status was not updated. ${await readError(response, "The status could not be updated.")}`);
      const updated = await response.json() as { status: LeadStatus };
      applySavedStatus(updated.status);
      return updated.status;
    } finally {
      setCommitting(false);
    }
  }, [lead.id, applySavedStatus]);

  /** Picking a status only remembers the choice; nothing is saved until the follow-up is. */
  function chooseStatus(next: LeadStatus) {
    if (committing || next === displayStatus) return;
    setError(null);
    pendingRef.current = next === lead.status ? null : next;
    setPendingStatus(pendingRef.current);
    // Back on the saved status: step 1 is only done if a status was saved earlier in this visit.
    setProgress((current) => ({ ...current, status: pendingRef.current !== null || savedStatusRef.current }));
  }

  /** The note is saved first; then the pending status, and a final status offers to cancel the open task. */
  async function afterNoteSaved() {
    markDone("note");
    refreshTimeline();
    const saved = await commitPendingStatus();
    if (saved && isFinalLeadStatus(saved) && tasks.openTask) {
      const stillOpen = await offerToCancelOpenTask(lead.id, saved);
      if (!stillOpen) await tasks.reload();
    }
  }

  const resize = useDrawerWidth();

  return <>
    <div className="mvp-lead-drawer-backdrop" onPointerDown={onClose} />
    <div className="mvp-lead-drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize lead details. Use the left and right arrow keys."
      aria-valuemin={DRAWER_MIN_WIDTH} aria-valuemax={DRAWER_MAX_WIDTH} aria-valuenow={resize.width} tabIndex={0} style={{ right: `min(${resize.width}px, 100vw)` }}
      onPointerDown={resize.onPointerDown} onPointerMove={resize.onPointerMove} onPointerUp={resize.onPointerEnd} onPointerCancel={resize.onPointerEnd}
      onKeyDown={resize.onKeyDown} onDoubleClick={resize.reset} />
    <aside ref={panelRef} className="mvp-detail-panel mvp-lead-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width: `min(${resize.width}px, 100vw)` }}>
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
          {onAssigneeChange ? <AssigneeCard lead={lead} assignees={assignees} onChanged={(assignedUserId, assigneeName) => { onAssigneeChange(lead.id, assignedUserId, assigneeName); refreshTimeline(); }} /> : null}
        </section>

        <ol className="mvp-flow" aria-label="After every call">
          <StepItem number={1} done={shown.status} current={currentStep === "status"}>
            <div className="mvp-lead-status" data-tone={STATUS_TONES[displayStatus] ?? "gray"}>
              <span className="mvp-lead-status__title">Current status</span>
              <RowDropdown ariaLabel={`Change status for ${lead.leadName ?? "Unnamed Lead"}`} value={displayStatus} options={LEAD_STATUSES} width={220}
                open={statusOpen} onOpenChange={setStatusOpen} onChange={chooseStatus} />
              <p className="mvp-lead-status__hint">{pendingStatus ? "Not saved yet. Add a task or a note to save it." : "Update it after every call."}</p>
            </div>
          </StepItem>
          <StepItem number={2} done={shown.task} current={currentStep === "task"}>
            <TaskCard leadId={lead.id} timezone={timezone} tasks={tasks} locked={isTaskCreationLocked(displayStatus)} pendingStatus={pendingStatus}
              commitStatus={commitPendingStatus} onTaskCreated={(savedStatus) => { markDone("task"); if (savedStatus) applySavedStatus(savedStatus); }} />
          </StepItem>
          <StepItem number={3} done={shown.note} current={currentStep === "note"}>
            <NoteForm leadId={lead.id} onSaved={afterNoteSaved} />
          </StepItem>
        </ol>
        <LeadTimeline ref={timelineRef} leadId={lead.id} timezone={timezone} />
      </div>
    </aside>
  </>;
}

/**
 * Who owns the lead. Any member can reassign it (the database records who did, on the timeline). A person who
 * was assigned and has since been blocked is still shown, but cannot be picked again.
 */
function AssigneeCard({ lead, assignees, onChanged }: {
  lead: DrawerLead;
  assignees: AssigneeOption[];
  onChanged: (assignedUserId: string | null, assigneeName: string | null) => void;
}) {
  const selectId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = lead.assignedUserId ?? "";
  const currentIsActive = !current || assignees.some((member) => member.userId === current);

  async function change(next: string): Promise<void> {
    if (next === current) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}/assignee`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ assigneeUserId: next || null }) });
      if (!response.ok) throw new Error(await readError(response, "The lead could not be assigned."));
      const updated = await response.json() as { assignedUserId: string | null; assigneeName: string | null };
      onChanged(updated.assignedUserId, updated.assigneeName);
    } catch (cause) {
      setError(message(cause, "The lead could not be assigned."));
    } finally {
      setBusy(false);
    }
  }

  return <div className="mvp-assign-card">
    <label htmlFor={selectId} className="mvp-lead-drawer__section-title">Assigned to</label>
    {error ? <div className="mvp-inline-error" role="alert">{error}</div> : null}
    <div className="mvp-settings-select">
      <select id={selectId} value={current} disabled={busy} onChange={(event) => void change(event.target.value)}>
        <option value="">Unassigned</option>
        {currentIsActive ? null : <option value={current} disabled>{lead.assigneeName ?? "Team member"} (no longer active)</option>}
        {assignees.map((member) => <option key={member.userId} value={member.userId}>{member.fullName}</option>)}
      </select>
      <ChevronDown size={17} aria-hidden="true" />
    </div>
    <p className="mvp-assign-card__hint">New leads from an ad go to the person your company owner chose for it. You can reassign this lead at any time.</p>
  </div>;
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

function TaskCard({ leadId, timezone, tasks, locked, pendingStatus, commitStatus, onTaskCreated }: {
  leadId: string; timezone: string; tasks: LeadTaskState; locked: boolean;
  /** The unsaved status choice: saved with a new task, or right after the open task is completed, cancelled or rescheduled. */
  pendingStatus: LeadStatus | null;
  commitStatus: () => Promise<LeadStatus | null>;
  onTaskCreated: (savedStatus: LeadStatus | null) => void;
}) {
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
      setBusy(false);
      return;
    }
    await saveStatusAfterTask();
    setBusy(false);
  }

  /** The task change is saved; now the status chosen with it (if any). A failure leaves the choice pending. */
  async function saveStatusAfterTask() {
    try { await commitStatus(); } catch (cause) { setError(message(cause, "The status could not be updated.")); }
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
      setBusy(false);
      return;
    }
    await saveStatusAfterTask();
    setBusy(false);
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
    {openTask === null && locked ? <div className="mvp-task-card__locked" role="status">
      <Lock size={16} aria-hidden="true" />
      <p>Do step 1 first: change the status above. Then you can add a task.</p>
    </div> : null}
    {openTask === null && !locked ? <NewTaskForm leadId={leadId} timezone={timezone} tasks={tasks} pendingStatus={pendingStatus} onCreated={onTaskCreated} /> : null}
  </section>;
}

function NewTaskForm({ leadId, timezone, tasks, pendingStatus, onCreated }: { leadId: string; timezone: string; tasks: LeadTaskState; pendingStatus: LeadStatus | null; onCreated: (savedStatus: LeadStatus | null) => void }) {
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
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null, startDate, dueDate, ...(pendingStatus ? { status: pendingStatus } : {}) }),
      });
      if (!response.ok) {
        const failure = new LeadRequestError(await readError(response, "The task could not be saved."), response.status);
        setError(failure.message);
        // 409: another open task exists. 500 with a status: the task may have been saved before the status failed.
        if (failure.status === 409 || (pendingStatus && failure.status >= 500)) await tasks.reload();
        return;
      }
      tasks.setOpenTask(await response.json() as LeadTask);
      tasks.setJustClosed(false);
      tasks.report(true, title.trim());
      onCreated(pendingStatus);
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

function NoteForm({ leadId, onSaved }: { leadId: string; onSaved: () => Promise<void> }) {
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
      await onSaved();
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
