"use client";

import { useEffect, useRef, useState } from "react";
import { LEADS_CHANGED_EVENT } from "@/components/task-bell";

/**
 * The table's last successful load: the exact request it sent and the cursor it got back (when the company's newest
 * lead was saved, as the database wrote it; null = no leads yet). Checks always send this saved request, never the
 * live filter state, so a filter change that has not reloaded the table yet can never be counted.
 */
export interface NewLeadsSnapshot { body: Record<string, unknown>; cursor: string | null }

/** Same pause as the dashboard: several lead writes in a burst become one check. */
const CHANGE_DEBOUNCE_MS = 750;
/** Fallback while the tab is visible, for when the live signal is down. */
export const NEW_LEADS_POLL_MS = 60_000;

/**
 * How many new leads the /leads table would show if it were reloaded now; 0 while it is loading.
 *
 * - The shell's live stream fires LEADS_CHANGED_EVENT on any lead write and when the tab comes back into view; a
 *   check follows after a short pause. Only new leads raise the count: a status, label or assignee change does not.
 * - Every 60 s while the tab is visible a check runs anyway, so the count still arrives with the live signal down.
 *   Background checks never renew the idle-logout clock (only real activity does).
 * - One request at a time; events during a request queue exactly one more. An event during a table load is kept and
 *   checked right after the load. A reply for an older load is never shown (the count belongs to its snapshot).
 * - Best effort: a failed check shows nothing, and a signed-out session (401) stops checking until the next load.
 */
export function useNewLeadsCount(snapshot: NewLeadsSnapshot | undefined): number {
  const [result, setResult] = useState<{ snapshot: NewLeadsSnapshot; count: number } | null>(null);
  const missedWhileLoading = useRef(false);

  useEffect(() => {
    if (!snapshot) {
      // No table to compare with yet: remember a lead write so the load that is running gets checked when it lands.
      const remember = () => { missedWhileLoading.current = true; };
      window.addEventListener(LEADS_CHANGED_EVENT, remember);
      return () => window.removeEventListener(LEADS_CHANGED_EVENT, remember);
    }

    let disposed = false;
    let stopped = false;
    let inFlight = false;
    let queued = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const check = async (): Promise<void> => {
      // A hidden tab sends nothing; the shell fires the event again when the tab comes back.
      if (disposed || stopped || document.hidden) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/leads/new-count", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...snapshot.body, since: snapshot.cursor }), signal: controller.signal });
        if (response.status === 401) { stopped = true; return; }
        if (!response.ok) return;
        const { count } = await response.json() as { count?: unknown };
        if (!disposed && typeof count === "number" && Number.isInteger(count) && count >= 0) setResult({ snapshot, count });
      } catch {
        // Best effort: the bar is a convenience, a failed or aborted check leaves it as it was.
      } finally {
        inFlight = false;
        controller = null;
        if (queued && !disposed) { queued = false; void check(); }
      }
    };
    const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => void check(), CHANGE_DEBOUNCE_MS); };

    window.addEventListener(LEADS_CHANGED_EVENT, schedule);
    const poll = setInterval(() => void check(), NEW_LEADS_POLL_MS);
    if (missedWhileLoading.current) { missedWhileLoading.current = false; schedule(); }
    return () => {
      disposed = true;
      window.removeEventListener(LEADS_CHANGED_EVENT, schedule);
      clearInterval(poll);
      clearTimeout(debounce);
      controller?.abort();
    };
  }, [snapshot]);

  // A count belongs to the load it was checked for; a newer load (or one still running) shows none.
  if (!snapshot || !result || result.snapshot !== snapshot) return 0;
  return result.count;
}
