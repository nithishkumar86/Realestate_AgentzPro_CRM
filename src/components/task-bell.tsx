"use client";

import { Bell, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskNotification } from "@/lib/server/task-notification-service";

interface Feed { items: TaskNotification[]; unread: number }
const TOAST_MS = 8_000;
/** Fired on window when the live stream says tasks may have changed; the Tasks page refetches on it. */
export const TASKS_CHANGED_EVENT = "agentz:tasks-changed";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

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
    // One live stream for the whole shell (the Tasks page listens to the window events below instead of opening
    // its own). It is closed while the tab is hidden, like the dashboard's, and a catch-up fetch runs on return.
    let source: EventSource | null = null;
    const open = () => {
      source?.close();
      source = new EventSource("/api/dashboard/stream");
      source.addEventListener("task_reminder", () => { void load(true); window.dispatchEvent(new Event(TASKS_CHANGED_EVENT)); });
      source.addEventListener("change", () => window.dispatchEvent(new Event(TASKS_CHANGED_EVENT)));
    };
    const onVisibility = () => {
      if (document.hidden) { source?.close(); source = null; return; }
      open();
      void load(true);
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
    };
    if (!document.hidden) open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearTimeout(first); clearTimeout(toastTimer.current); document.removeEventListener("visibilitychange", onVisibility); source?.close(); };
  }, [load]);

  // Browser push: offered only where the browser supports it and the member has not decided yet.
  const [pushState, setPushState] = useState<"unsupported" | "ask" | "on" | "blocked">("unsupported");
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !VAPID_PUBLIC_KEY) return;
      setPushState(Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "blocked" : "ask");
      // Already allowed on this device: hand the existing subscription to whoever is signed in now, so a second
      // member on a shared device gets their own pushes (and the previous member stops getting them).
      if (Notification.permission === "granted") {
        void navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready)
          .then((registration) => registration.pushManager.getSubscription())
          .then((subscription) => {
            const json = subscription?.toJSON();
            // Allowed but turned off here (no subscription): offer to enable again instead of claiming it is on.
            if (!json?.endpoint) { setPushState("ask"); return; }
            return fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
          })
          .catch(() => undefined);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function enablePush() {
    try {
      if (await Notification.requestPermission() !== "granted") { setPushState("blocked"); return; }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(VAPID_PUBLIC_KEY) });
      const json = subscription.toJSON();
      const response = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
      setPushState(response.ok ? "on" : "ask");
    } catch {
      setPushState("ask");
    }
  }

  async function disablePush() {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setPushState("ask");
    } catch {
      // Stay "on" so the button does not claim a state change that did not happen.
    }
  }

  // The panel closes on Escape or a click anywhere outside it, as well as with its close button.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  async function markRead(body: { all: true } | { ids: string[] }) {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    await load(false);
  }

  return <div className="mvp-bell" ref={root}>
    <button type="button" className="mvp-nav-link mvp-bell__button" aria-label={`Task alerts, ${feed.unread} unread`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bell size={19} aria-hidden="true" />
      <span className="mvp-nav-link__label">Alerts</span>
      {feed.unread > 0 ? <span className="mvp-bell__badge">{feed.unread > 9 ? "9+" : feed.unread}</span> : null}
    </button>
    {open ? <div className="mvp-bell__panel" role="dialog" aria-label="Task alerts">
      <div className="mvp-bell__head"><strong>Task alerts</strong>
        <span className="mvp-bell__actions">
          {feed.unread > 0 ? <button type="button" onClick={() => void markRead({ all: true })}>Mark all read</button> : null}
          <button type="button" className="mvp-bell__close" aria-label="Close alerts" onClick={() => setOpen(false)}><X size={16} aria-hidden="true" /></button>
        </span>
      </div>
      {pushState === "ask" ? <button type="button" className="mvp-bell__push" onClick={() => void enablePush()}>Enable browser notifications</button> : null}
      {pushState === "on" ? <button type="button" className="mvp-bell__push" onClick={() => void disablePush()}>Browser notifications on · Turn off</button> : null}
      {pushState === "blocked" ? <p className="mvp-bell__hint">Notifications are blocked in this browser.</p> : null}
      {feed.items.length === 0 ? <p className="mvp-empty">No alerts yet.</p> : <ul>
        {feed.items.map((item) => <li key={item.id} className={item.read ? undefined : "mvp-bell__unread"}>
          <Link href="/tasks" onClick={() => { setOpen(false); if (!item.read) void markRead({ ids: [item.id] }); }}>{reminderText(item)}</Link>
        </li>)}
      </ul>}
    </div> : null}
    {toast ? <Link className="mvp-bell__toast" href="/tasks" role="status" onClick={() => { void markRead({ ids: [toast.id] }); setToast(null); }}>{reminderText(toast)}</Link> : null}
  </div>;
}
