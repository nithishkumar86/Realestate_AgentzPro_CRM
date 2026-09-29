"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardStats } from "@/lib/server/dashboard-service";
import { goToLogin, reloadPage } from "@/features/dashboard/navigation";
import { readError } from "@/features/leads/use-lead-filters";

export type LiveState = "connecting" | "live" | "reconnecting" | "polling";

const FILTER_DEBOUNCE_MS = 250;
const CHANGE_DEBOUNCE_MS = 750;
const POLL_INTERVAL_MS = 15_000;
const STREAM_RETRY_AFTER_GIVE_UP_MS = 30_000;
/** How long the browser may keep retrying a dropped stream before the dashboard polls instead. */
const STREAM_GRACE_MS = 10_000;

/** Milliseconds until the next midnight in `timezone`, so "today" / "this month" roll over without a reload. */
export function msUntilNextMidnight(timezone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsedSeconds = value("hour") * 3600 + value("minute") * 60 + value("second");
  return Math.max((86_400 - elapsedSeconds) * 1000 + 1000, 1000);
}

/**
 * Loads the dashboard aggregate for the current filters and keeps it live.
 *
 * - Every filter change refetches; a sequence number discards any response that is no longer the latest.
 * - A server-sent `change` (a lead was added/updated/deleted for THIS tenant) refetches after a short debounce.
 * - If the stream is unavailable the hook polls every 15s instead, and keeps retrying the stream. That covers
 *   the server saying so, the browser giving up, and a dropped connection the browser keeps retrying for more
 *   than 10s (network error, proxy cutting the stream).
 * - When a dropped stream comes back, one refetch catches up on anything that changed while it was down.
 * - The stream is closed while the tab is hidden (no connection held for a background tab) and reopened,
 *   with a refetch, when the tab returns.
 * - A 401 (signed out / idle-expired) goes to /login; it never keeps polling a dead session.
 * - Tenant guard: every response and the stream's `ready` event carry the tenant id. If it ever differs
 *   from the tenant this page mounted with (company switched in another tab) the page reloads instead of
 *   rendering another company's numbers under this company's name.
 */
export function useDashboardStats(filterBody: Record<string, unknown>) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const bodyKey = JSON.stringify(filterBody);
  const bodyRef = useRef(bodyKey);
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const tenantRef = useRef<string | null>(null);
  const timezoneRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++sequenceRef.current;
    setIsFetching(true);
    try {
      const response = await fetch("/api/dashboard/stats", { method: "POST", headers: { "content-type": "application/json" }, body: bodyRef.current, signal: controller.signal });
      if (response.status === 401) { goToLogin(); return; }
      if (!response.ok) throw new Error(await readError(response, "The dashboard could not be loaded."));
      const next = await response.json() as DashboardStats;
      if (sequence !== sequenceRef.current) return;
      if (tenantRef.current && next.tenantId !== tenantRef.current) { reloadPage(); return; }
      tenantRef.current = next.tenantId;
      timezoneRef.current = next.timezone;
      setStats(next);
      setError(null);
      setLastUpdated(new Date());
    } catch (cause) {
      if (controller.signal.aborted || sequence !== sequenceRef.current) return;
      setError(cause instanceof Error ? cause.message : "The dashboard could not be loaded.");
    } finally {
      if (sequence === sequenceRef.current) setIsFetching(false);
    }
  }, []);

  // Filters changed: refetch. The first load is immediate; later changes wait 250 ms so typing in the
  // search box sends one request, not one per keystroke.
  const hasLoadedOnce = useRef(false);
  useEffect(() => {
    bodyRef.current = bodyKey;
    const timer = setTimeout(() => void load(), hasLoadedOnce.current ? FILTER_DEBOUNCE_MS : 0);
    hasLoadedOnce.current = true;
    return () => clearTimeout(timer);
  }, [bodyKey, load]);

  // Live updates.
  useEffect(() => {
    let source: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let missedWhileDown = false;
    let midnight: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const stopPolling = () => { if (poll) { clearInterval(poll); poll = undefined; } };
    const startPolling = () => { if (!poll) poll = setInterval(() => void load(), POLL_INTERVAL_MS); };
    const scheduleChange = () => { clearTimeout(debounce); debounce = setTimeout(() => void load(), CHANGE_DEBOUNCE_MS); };
    const scheduleMidnight = () => {
      clearTimeout(midnight);
      if (!timezoneRef.current) { midnight = setTimeout(scheduleMidnight, 5_000); return; }
      midnight = setTimeout(() => { void load(); scheduleMidnight(); }, msUntilNextMidnight(timezoneRef.current));
    };

    const closeStream = () => { source?.close(); source = null; clearTimeout(grace); grace = undefined; };
    const openStream = () => {
      closeStream();
      clearTimeout(retry);
      const next = new EventSource("/api/dashboard/stream");
      source = next;
      next.addEventListener("ready", (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as { tenantId: string };
        if (tenantRef.current && data.tenantId !== tenantRef.current) { reloadPage(); return; }
        tenantRef.current = data.tenantId;
        clearTimeout(grace); grace = undefined;
        stopPolling();
        setLiveState("live");
        // Back after a drop: pick up whatever changed meanwhile (the first connect needs no refetch).
        if (missedWhileDown) { missedWhileDown = false; scheduleChange(); }
      });
      next.addEventListener("change", scheduleChange);
      next.addEventListener("status", (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as { state: "live" | "degraded" };
        if (data.state === "degraded") { setLiveState("polling"); startPolling(); }
        else { clearTimeout(grace); grace = undefined; stopPolling(); setLiveState("live"); }
      });
      next.onerror = () => {
        if (disposed) return;
        missedWhileDown = true;
        if (next.readyState === EventSource.CLOSED) {
          // The browser gave up (the server answered with a non-stream response, e.g. 401 or 429).
          // Refetching reveals a dead session (-> /login); otherwise poll and try the stream again later.
          closeStream();
          setLiveState("polling");
          startPolling();
          void load();
          retry = setTimeout(openStream, STREAM_RETRY_AFTER_GIVE_UP_MS);
        } else {
          // EventSource is retrying by itself. Once polling has taken over, keep saying so: retry errors must
          // not flip the pill back to "reconnecting", nor add refetches on top of the 15s poll.
          if (poll) return;
          setLiveState("reconnecting");
          // Armed once: re-arming on every retry error would push it back forever and it would never fire.
          grace ??= setTimeout(() => {
            grace = undefined;
            if (disposed) return;
            setLiveState("polling");
            startPolling();
            void load();
          }, STREAM_GRACE_MS);
        }
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        closeStream(); stopPolling(); clearTimeout(retry); clearTimeout(debounce);
      } else {
        missedWhileDown = false; // the refetch below covers it
        void load();
        openStream();
      }
    };

    if (!document.hidden) openStream();
    scheduleMidnight();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      closeStream(); stopPolling();
      clearTimeout(debounce); clearTimeout(retry); clearTimeout(midnight);
      controllerRef.current?.abort();
    };
  }, [load]);

  return { stats, isFetching, error, liveState, lastUpdated, refresh: load };
}
