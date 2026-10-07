"use client";

import { Repeat } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TASKS_CHANGED_EVENT, TaskBell } from "@/components/task-bell";
import type { LeadStatus, TaskRepeatRule } from "@/features/leads/lead-options";
import { LeadDrawer, type DrawerLead } from "@/features/leads/lead-drawer";
import { formatTaskDue } from "@/features/leads/lead-task-client";
import { readError } from "@/features/leads/use-lead-filters";
import type { TaskBucket, TaskOverview, TrackedTask } from "@/lib/server/task-tracking-service";

const TABS: { bucket: TaskBucket; label: string }[] = [
  { bucket: "overdue", label: "Overdue" },
  { bucket: "today", label: "Today" },
  { bucket: "upcoming", label: "Upcoming" },
  { bucket: "done", label: "Done" },
];
const RANGES = [{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "all", label: "All time" }] as const;
// A task slips from Today to Overdue as time passes, which produces no database event, so the list refetches.
const REFRESH_MS = 30_000;

/** "in 2 h", "15 min ago": how far the due time is from now. */
export function relativeDue(dueAt: string, now = Date.now()): string {
  const minutes = Math.round((new Date(dueAt).getTime() - now) / 60_000);
  const abs = Math.abs(minutes);
  const text = abs < 1 ? "now" : abs < 60 ? `${abs} min` : abs < 1_440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1_440)} d`;
  if (text === "now") return "due now";
  return minutes > 0 ? `in ${text}` : `${text} ago`;
}

export function TasksPageClient() {
  const [bucket, setBucket] = useState<TaskBucket>("today");
  const [member, setMember] = useState("");
  const [range, setRange] = useState<"7d" | "30d" | "all">("7d");
  const [data, setData] = useState<TaskOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<TrackedTask | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = new URLSearchParams({ bucket, range });
    if (member) params.set("member", member);
    try {
      const response = await fetch(`/api/tasks?${params}`);
      if (!response.ok) throw new Error(await readError(response, "Tasks could not be loaded."));
      const next = await response.json() as TaskOverview;
      if (id === requestId.current) { setData(next); setError(null); }
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "Tasks could not be loaded.");
    }
  }, [bucket, member, range]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [load]);

  // Task changes made elsewhere arrive on the shell's live stream (the bell re-dispatches them); refetch on one.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [load]);

  const counts = data?.counts;
  const countOf = (tab: TaskBucket) => (counts ? counts[tab] : null);
  const drawerLead: DrawerLead | null = open ? {
    id: open.leadId, leadName: open.leadName, phone: open.leadPhone, email: open.lead.email,
    facebookPage: open.lead.facebookPage, adName: open.lead.adName, status: open.lead.status as LeadStatus,
    assignedUserId: open.lead.assignedUserId, assigneeName: open.ownerName,
  } : null;

  return <div className="mvp-leads">
    <header className="mvp-page-header"><div><h1>Tasks</h1><p>{data?.isOwner ? "Follow-ups across your team." : "Your follow-ups."}</p></div><TaskBell /></header>
    <div className="mvp-tasks__bar">
      <div className="mvp-tasks__tabs" role="tablist" aria-label="Task buckets">
        {TABS.map((tab) => <button key={tab.bucket} role="tab" type="button" aria-selected={bucket === tab.bucket}
          className={bucket === tab.bucket ? "mvp-tasks__tab mvp-tasks__tab--active" : "mvp-tasks__tab"} onClick={() => setBucket(tab.bucket)}>
          {tab.label}{countOf(tab.bucket) !== null ? <span className="mvp-tasks__count">{countOf(tab.bucket)}</span> : null}
        </button>)}
      </div>
      <div className="mvp-tasks__filters">
        {data?.isOwner ? <select aria-label="Team member" value={member} onChange={(event) => setMember(event.target.value)}>
          <option value="">All members</option>
          {data.members.map((item) => <option key={item.userId} value={item.userId}>{item.fullName}</option>)}
        </select> : null}
        {bucket === "done" ? <select aria-label="Done range" value={range} onChange={(event) => setRange(event.target.value as typeof range)}>
          {RANGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select> : null}
      </div>
    </div>
    {bucket === "done" && counts ? <p className="mvp-tasks__summary">{counts.doneOnTime} on time / {counts.done} done</p> : null}
    {error ? <div className="mvp-inline-error">{error}</div> : null}
    <section className="mvp-table-wrap"><table className="mvp-table mvp-tasks__table"><thead><tr>
      {["Lead", "Task", "Due", "Assigned To", bucket === "done" ? "Result" : "When"].map((heading) => <th key={heading}>{heading}</th>)}
    </tr></thead><tbody>
      {!data ? <tr><td className="mvp-empty" colSpan={5}>Loading tasks...</td></tr> : null}
      {data && data.items.length === 0 ? <tr><td className="mvp-empty" colSpan={5}>No {bucket} tasks.</td></tr> : null}
      {data?.items.map((task) => <tr key={task.id} className="mvp-tasks__row" tabIndex={0} onClick={() => setOpen(task)} onKeyDown={(event) => { if (event.key === "Enter") setOpen(task); }}>
        <td>{task.leadName ?? "Unnamed Lead"}<small>{task.leadPhone ?? ""}</small></td>
        <td>{task.title}{task.repeatRule !== "none" ? <Repeat size={13} aria-label={`Repeats ${task.repeatRule}`} className="mvp-tasks__repeat" /> : null}</td>
        <td>{formatTaskDue(task.dueAt, data.timezone)}</td>
        <td>{task.ownerName ?? "Unassigned"}</td>
        <td>{bucket === "done"
          ? <><span className={task.onTime ? "mvp-pill mvp-tasks__ontime" : "mvp-pill mvp-tasks__late"}>{task.onTime ? "On time" : "Late"}</span>{task.rescheduled ? <small>Rescheduled</small> : null}</>
          : <span className={bucket === "overdue" ? "mvp-tasks__overdue" : undefined}>{relativeDue(task.dueAt)}</span>}</td>
      </tr>)}
    </tbody></table></section>
    {drawerLead && data ? <LeadDrawer key={drawerLead.id} lead={drawerLead} timezone={data.timezone} onClose={() => { setOpen(null); void load(); }}
      onStatusChange={() => void load()} onOpenTaskChange={() => void load()} /> : null}
  </div>;
}

export type { TaskRepeatRule };
