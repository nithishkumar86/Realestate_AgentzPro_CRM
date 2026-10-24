"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/ui";
import type { ConnectionOverview } from "@/lib/types";
import { getConnectionOverview } from "@/services/crm-api-client";

const CONNECTION_PATH = "/connection";
// Each check is a full access check plus two queries, so a page change or returning to the tab re-checks
// at most this often. Leaving /connection always re-checks, so the warning clears right after a reconnect.
const RECHECK_INTERVAL_MS = 60_000;
// Opening a lead does not change the page, so someone working inside /leads all day is still re-checked
// this often while the tab is visible: the warning appears mid-day and clears after the owner reconnects.
const BACKGROUND_CHECK_MS = 5 * 60_000;
const CONNECTION_CHANGED_EVENT = "crm:facebook-connection-changed";

/** Called after the owner reconnects or disconnects a Page, so the warning updates straight away. */
export function notifyFacebookConnectionChanged(): void {
  window.dispatchEvent(new Event(CONNECTION_CHANGED_EVENT));
}

/**
 * Only when the long-lived access token has actually failed. The one writer of a Page's
 * 'reauthorization_required' status is schedule_meta_lead_retrieval_retry, after a lead fetch with that
 * Page's token is rejected. Connection-level flags (data-access date, permission checks) and Pages the
 * owner disconnected on purpose show nothing.
 */
export function needsFacebookReconnect(overview: ConnectionOverview): boolean {
  return overview.pages.some((page) => page.status === "reauthorization_required");
}

/** Shown at the top of every CRM page, to every member, while Facebook needs reconnecting. */
export function FacebookReconnectBanner() {
  const pathname = usePathname();
  const [overview, setOverview] = useState<ConnectionOverview | null>(null);
  const lastCheckedAt = useRef(0);
  const latestRequest = useRef(0);
  const previousPathname = useRef(pathname);

  const check = useCallback((force: boolean) => {
    if (!force && Date.now() - lastCheckedAt.current < RECHECK_INTERVAL_MS) return;
    lastCheckedAt.current = Date.now();
    const request = ++latestRequest.current;
    void getConnectionOverview()
      .then((next) => { if (request === latestRequest.current) setOverview(next); })
      // Best-effort: a failed check leaves the last known state and never blocks the page.
      .catch(() => {});
  }, []);

  useEffect(() => {
    const leftConnectionPage = previousPathname.current === CONNECTION_PATH && pathname !== CONNECTION_PATH;
    previousPathname.current = pathname;
    check(lastCheckedAt.current === 0 || leftConnectionPage);
  }, [pathname, check]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") check(false); };
    const onConnectionChanged = () => check(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CONNECTION_CHANGED_EVENT, onConnectionChanged);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") check(false); }, BACKGROUND_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CONNECTION_CHANGED_EVENT, onConnectionChanged);
      window.clearInterval(timer);
    };
  }, [check]);

  if (!overview || !needsFacebookReconnect(overview)) return null;

  return (
    <div className="mvp-reconnect-banner">
      <Notice tone="danger" title="Long-lived access token expired. Lead retrieval is currently paused.">
        Please immediately ask the owner to reconnect the Facebook Page.
      </Notice>
    </div>
  );
}
