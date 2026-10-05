"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { goToLogin } from "@/features/dashboard/navigation";
import type { TimelineFilter } from "@/features/leads/lead-options";
import { readError } from "@/features/leads/use-lead-filters";
import type { LeadActivityItem, LeadActivityPage } from "@/lib/server/lead-timeline-service";

const ACTIVITY_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 30_000;

/**
 * Loads one lead's timeline for the selected tab and keeps it current.
 *
 * - Changing the tab (or lead) reloads from the newest entry; a sequence number drops stale responses.
 * - "Load more" appends the next page using the opaque server cursor.
 * - refresh() re-reads the newest page and merges it in by id, keeping any older pages already loaded.
 *   The drawer calls it after the telecaller's own change.
 * - Changes made by anyone else arrive as `activity` events on the tenant's live stream; one for this
 *   lead triggers a debounced refresh. If the stream is unavailable the timeline polls every 30s instead.
 *   The stream is closed while the browser tab is hidden and reopened (with a refresh) when it returns.
 * - A 401 (signed out / idle-expired) goes to /login.
 */
export function useLeadTimeline(leadId: string, filter: TimelineFilter) {
  const [items, setItems] = useState<LeadActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const pagesLoadedRef = useRef(0);

  const fetchPage = useCallback(async (cursor: string | null): Promise<LeadActivityPage | null> => {
    const params = new URLSearchParams({ filter });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/leads/${leadId}/activities?${params.toString()}`);
    if (response.status === 401) { goToLogin(); return null; }
    if (!response.ok) throw new Error(await readError(response, "The timeline could not be loaded."));
    return await response.json() as LeadActivityPage;
  }, [leadId, filter]);

  // Bumped by retry() (and by refresh() before anything loaded) to re-run the initial load below.
  const [reloadToken, setReloadToken] = useState(0);
  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  // Initial load, and a fresh start whenever the lead, the tab or the retry token changes.
  useEffect(() => {
    const sequence = ++sequenceRef.current;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchPage(null);
        if (!page || sequence !== sequenceRef.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        pagesLoadedRef.current = 1;
      } catch (cause) {
        if (sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : "The timeline could not be loaded.");
      } finally {
        if (sequence === sequenceRef.current) setLoading(false);
      }
    }
    pagesLoadedRef.current = 0;
    void load();
  }, [fetchPage, reloadToken]);

  const refresh = useCallback(async () => {
    if (pagesLoadedRef.current === 0) { retry(); return; }
    const sequence = sequenceRef.current;
    try {
      const page = await fetchPage(null);
      if (!page || sequence !== sequenceRef.current) return;
      const fresh = new Set(page.items.map((item) => item.id));
      // New rows only ever appear at the top, so the merged list stays newest-first.
      setItems((current) => [...page.items, ...current.filter((item) => !fresh.has(item.id))]);
      if (pagesLoadedRef.current === 1) setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : "The timeline could not be loaded.");
    }
  }, [fetchPage, retry]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const sequence = sequenceRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      if (!page || sequence !== sequenceRef.current) return;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      pagesLoadedRef.current += 1;
    } catch (cause) {
      if (sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : "The timeline could not be loaded.");
    } finally {
      if (sequence === sequenceRef.current) setLoadingMore(false);
    }
  }, [fetchPage, nextCursor, loadingMore]);

  // The latest refresh, for the live-update effect below without re-opening the stream on every render.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    let source: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let missedWhileDown = false;
    let disposed = false;

    const scheduleRefresh = () => { clearTimeout(debounce); debounce = setTimeout(() => void refreshRef.current(), ACTIVITY_DEBOUNCE_MS); };
    const startPolling = () => { if (!poll) poll = setInterval(() => void refreshRef.current(), POLL_INTERVAL_MS); };
    const stopPolling = () => { if (poll) { clearInterval(poll); poll = undefined; } };
    const closeStream = () => { source?.close(); source = null; };
    const openStream = () => {
      closeStream();
      if (typeof EventSource === "undefined") { startPolling(); return; }
      const next = new EventSource("/api/dashboard/stream");
      source = next;
      next.addEventListener("ready", () => {
        stopPolling();
        if (missedWhileDown) { missedWhileDown = false; scheduleRefresh(); }
      });
      next.addEventListener("activity", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { leadId?: string };
          if (data.leadId === leadId) scheduleRefresh();
        } catch {
          // A malformed event is ignored; polling and the next event still keep the timeline current.
        }
      });
      next.addEventListener("status", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { state?: string };
          if (data.state === "degraded") startPolling(); else stopPolling();
        } catch {
          startPolling();
        }
      });
      next.onerror = () => {
        if (disposed) return;
        missedWhileDown = true;
        startPolling();
        // EventSource retries by itself unless the server refused the stream (e.g. 401 or 429). The poll
        // above covers both; a refused stream is not reopened until the tab becomes visible again.
        if (next.readyState === EventSource.CLOSED) closeStream();
      };
    };

    const onVisibility = () => {
      if (document.hidden) { closeStream(); stopPolling(); clearTimeout(debounce); }
      else { missedWhileDown = false; void refreshRef.current(); openStream(); }
    };

    if (!document.hidden) openStream();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      closeStream(); stopPolling(); clearTimeout(debounce);
    };
  }, [leadId]);

  return { items, loading, loadingMore, error, hasMore: nextCursor !== null, loadMore, refresh, retry };
}
