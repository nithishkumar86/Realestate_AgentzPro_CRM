"use client";

import { AlarmClock, Bell, BellOff, BellRing, Clock, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/date-utils";
import type { TaskNotification } from "@/lib/server/task-notification-service";
import logoIcon from "@/logo-icon.png";

interface Feed { items: TaskNotification[]; unread: number }
/** Reminder cards shown at once; older ones are still in the bell. */
const MAX_TOASTS = 3;
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

/** "Follow up with Ravi in 15 min" / "Follow up with Ravi now": the heading of every reminder. */
export function reminderHeading(item: Pick<TaskNotification, "kind" | "leadName">): string {
  return `Follow up with ${item.leadName ?? "this lead"} ${item.kind === "due_now" ? "now" : "in 15 min"}`;
}

type PushState = "unsupported" | "ask" | "on" | "blocked";
interface TaskAlerts {
  feed: Feed;
  pushState: PushState;
  enablePush: () => Promise<void>;
  disablePush: () => Promise<void>;
  markRead: (body: { all: true } | { ids: string[] }) => Promise<void>;
  clearAll: () => Promise<void>;
}
const TaskAlertsContext = createContext<TaskAlerts | null>(null);

/**
 * Lives in the shell so reminders reach the member on every page: it owns the live stream, the alert list, browser
 * push and the reminder cards. The bell that shows the list is `TaskBell`, placed on the Tasks page.
 */
export function TaskAlertsProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [feed, setFeed] = useState<Feed>({ items: [], unread: 0 });
  const [toasts, setToasts] = useState<TaskNotification[]>([]);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async (announce: boolean) => {
    try {
      const response = await fetch("/api/notifications");
      if (!response.ok) return;
      const next = await response.json() as Feed;
      const seen = known.current;
      // Several can arrive together (a tab coming back from the background), newest first like the feed.
      const fresh = announce && seen ? next.items.filter((item) => !item.read && !seen.has(item.id)) : [];
      // A card stays until the member clicks OK or opens the lead; one marked read elsewhere (the bell, another tab)
      // leaves too.
      const unread = new Set(next.items.filter((item) => !item.read).map((item) => item.id));
      setToasts((current) => [...fresh, ...current.filter((item) => unread.has(item.id))].slice(0, MAX_TOASTS));
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
    return () => { clearTimeout(first); document.removeEventListener("visibilitychange", onVisibility); source?.close(); };
  }, [load]);

  // Browser push: offered only where the browser supports it and the member has not decided yet.
  const [pushState, setPushState] = useState<PushState>("unsupported");
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

  async function markRead(body: { all: true } | { ids: string[] }) {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    await load(false);
  }

  async function clearAll() {
    await fetch("/api/notifications/clear", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => undefined);
    await load(false);
  }

  function dismissToast(id: string) {
    setToasts((current) => current.filter((item) => item.id !== id));
    void markRead({ ids: [id] });
  }

  return <TaskAlertsContext.Provider value={{ feed, pushState, enablePush, disablePush, markRead, clearAll }}>
    {children}
    {/* Always mounted so screen readers announce a card the moment it is added. */}
    <div className="mvp-reminder-stack" aria-live="polite">
      {toasts.map((item) => <div key={item.id} className={item.kind === "due_now" ? "mvp-reminder mvp-reminder--now" : "mvp-reminder"} role="group" aria-label="Task reminder">
        <div className="mvp-reminder__brand">
          <Image className="mvp-reminder__logo" src={logoIcon} alt="" width={30} height={30} />
          <span><strong>AgentzPro</strong><small>Task reminder</small></span>
        </div>
        <strong className="mvp-reminder__title">{reminderHeading(item)}</strong>
        <p className="mvp-reminder__task">{item.taskTitle}</p>
        <p className="mvp-reminder__due"><Clock size={13} aria-hidden="true" /> Due {formatDateTime(item.dueAt)}</p>
        <div className="mvp-reminder__actions">
          <Link className="mvp-reminder__open" href={`/leads?lead=${item.leadId}`} onClick={() => dismissToast(item.id)}>Open lead</Link>
          <button type="button" className="mvp-reminder__ok" onClick={() => dismissToast(item.id)}>OK</button>
        </div>
      </div>)}
    </div>
  </TaskAlertsContext.Provider>;
}

function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1_440)}d`;
}

/** Bell with an unread count and the member's task alerts in a popover. Shown at the top right of the Tasks page. */
export function TaskBell() {
  const alerts = useContext(TaskAlertsContext);
  const [open, setOpen] = useState(false);
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
  if (!alerts) return null;
  const { feed, pushState, enablePush, disablePush, markRead, clearAll } = alerts;

  return <div className="mvp-bell" ref={root}>
    <button type="button" className="mvp-bell__button" aria-label={`Task alerts, ${feed.unread} unread`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bell size={20} aria-hidden="true" />
      {feed.unread > 0 ? <span className="mvp-bell__badge">{feed.unread > 9 ? "9+" : feed.unread}</span> : null}
    </button>
    {open ? <div className="mvp-bell__panel" role="dialog" aria-label="Task alerts">
      <div className="mvp-bell__head">
        <div className="mvp-bell__title"><strong>Task alerts</strong>{feed.unread > 0 ? <span className="mvp-bell__new">{feed.unread} new</span> : null}</div>
        <span className="mvp-bell__actions">
          {feed.unread > 0 ? <button type="button" className="mvp-bell__markall" onClick={() => void markRead({ all: true })}>Mark all read</button> : null}
          {feed.items.length > 0 ? <button type="button" className="mvp-bell__markall" onClick={() => void clearAll()}>Clear all</button> : null}
          <button type="button" className="mvp-bell__close" aria-label="Close alerts" onClick={() => setOpen(false)}><X size={16} aria-hidden="true" /></button>
        </span>
      </div>
      {pushState === "ask" || pushState === "on" ? <div className="mvp-bell__setting">
        <span className="mvp-bell__setting-icon"><BellRing size={16} aria-hidden="true" /></span>
        <span className="mvp-bell__setting-text"><strong>Browser notifications</strong><small>{pushState === "on" ? "On: alerts reach you even when this tab is in the background." : "Get alerts even when this tab is in the background."}</small></span>
        <button type="button" role="switch" aria-checked={pushState === "on"} aria-label="Browser notifications" className="mvp-bell__switch"
          onClick={() => void (pushState === "on" ? disablePush() : enablePush())}><span /></button>
      </div> : null}
      {pushState === "blocked" ? <p className="mvp-bell__hint"><BellOff size={14} aria-hidden="true" /> Notifications are blocked in this browser. Allow them in the site settings to get alerts in the background.</p> : null}
      {feed.items.length === 0 ? <div className="mvp-bell__empty">
        <span className="mvp-bell__empty-icon"><Bell size={26} aria-hidden="true" /></span>
        <strong>You&apos;re all caught up</strong>
        <p>Reminders show up here 15 minutes before a task is due, and again when it is due.</p>
      </div> : <ul>
        {feed.items.map((item) => <li key={item.id}>
          <Link href={`/leads?lead=${item.leadId}`} className={item.read ? "mvp-bell__item" : "mvp-bell__item mvp-bell__item--unread"} onClick={() => { setOpen(false); if (!item.read) void markRead({ ids: [item.id] }); }}>
            <span className={item.kind === "due_now" ? "mvp-bell__item-icon mvp-bell__item-icon--now" : "mvp-bell__item-icon"}>
              {item.kind === "due_now" ? <AlarmClock size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
            </span>
            <span className="mvp-bell__item-body">
              <strong>{reminderHeading(item)}</strong>
              <small>{item.taskTitle}</small>
            </span>
            <span className="mvp-bell__item-time">{timeAgo(item.createdAt)}{item.read ? null : <i aria-label="Unread" />}</span>
          </Link>
        </li>)}
      </ul>}
    </div> : null}
  </div>;
}
