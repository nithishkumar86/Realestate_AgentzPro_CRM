"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskNotification } from "@/lib/server/task-notification-service";

interface Feed { items: TaskNotification[]; unread: number }
const TOAST_MS = 8_000;

export function reminderText(item: Pick<TaskNotification, "kind" | "taskTitle" | "leadName">): string {
  const who = item.leadName ? ` · ${item.leadName}` : "";
  return `${item.kind === "due_now" ? "Due now" : "Due in 15 min"}: ${item.taskTitle}${who}`;
}

/** Bell with an unread count and a list of the member's task alerts; a toast pops when a new one arrives live. */
export function TaskBell() {
  const [feed, setFeed] = useState<Feed>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<TaskNotification | null>(null);
  const known = useRef<Set<string> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async (announce: boolean) => {
    try {
      const response = await fetch("/api/notifications");
      if (!response.ok) return;
      const next = await response.json() as Feed;
      const seen = known.current;
      if (announce && seen) {
        const fresh = next.items.find((item) => !item.read && !seen.has(item.id));
        if (fresh) { setToast(fresh); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), TOAST_MS); }
      }
      known.current = new Set(next.items.map((item) => item.id));
      setFeed(next);
    } catch {
      // The bell is a convenience; a failed fetch just leaves the last list in place.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(false), 0);
    const source = new EventSource("/api/dashboard/stream");
    source.addEventListener("task_reminder", () => void load(true));
    return () => { clearTimeout(first); clearTimeout(toastTimer.current); source.close(); };
  }, [load]);

  async function markRead(body: { all: true } | { ids: string[] }) {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    await load(false);
  }

  return <div className="mvp-bell">
    <button type="button" className="mvp-nav-link mvp-bell__button" aria-label={`Task alerts, ${feed.unread} unread`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bell size={19} aria-hidden="true" />
      <span className="mvp-nav-link__label">Alerts</span>
      {feed.unread > 0 ? <span className="mvp-bell__badge">{feed.unread > 9 ? "9+" : feed.unread}</span> : null}
    </button>
    {open ? <div className="mvp-bell__panel" role="dialog" aria-label="Task alerts">
      <div className="mvp-bell__head"><strong>Task alerts</strong>
        {feed.unread > 0 ? <button type="button" onClick={() => void markRead({ all: true })}>Mark all read</button> : null}
      </div>
      {feed.items.length === 0 ? <p className="mvp-empty">No alerts yet.</p> : <ul>
        {feed.items.map((item) => <li key={item.id} className={item.read ? undefined : "mvp-bell__unread"}>
          <Link href="/tasks" onClick={() => { setOpen(false); if (!item.read) void markRead({ ids: [item.id] }); }}>{reminderText(item)}</Link>
        </li>)}
      </ul>}
    </div> : null}
    {toast ? <Link className="mvp-bell__toast" href="/tasks" role="status" onClick={() => { void markRead({ ids: [toast.id] }); setToast(null); }}>{reminderText(toast)}</Link> : null}
  </div>;
}
