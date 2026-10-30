"use client";

import { useEffect, useState } from "react";
import { LEAD_SOURCES, type LeadSource } from "@/features/leads/lead-options";
import type { ConnectionOverview } from "@/lib/types";
import { getConnectionOverview, getGoogleAdsOverview, type GoogleAdsOverview } from "@/services/crm-api-client";

/** The connection details the dashboard's warning needs; null where that check could not be loaded. */
export type ConnectionHealth = { meta: ConnectionOverview["connectionStatus"] | null; google: { hasWebhook: boolean; webhookStopped: boolean; needsReconnect: boolean } | null };

/** What each connection check returned; null where it could not be loaded. */
export type SourceChecks = {
  meta: Pick<ConnectionOverview, "pages"> | null;
  google: Pick<GoogleAdsOverview, "connection" | "hasWebhook" | "webhookStopped"> | null;
};

/**
 * The lead sources this company uses, in LEAD_SOURCES order. Telecaller (the + button) always works. Facebook counts
 * once a Page was connected, not at Facebook login: the login is saved before the owner picks a Page. Google Ads counts
 * once the webhook was created or Google sign-in was done. Disconnected Pages and a stopped webhook still count, so
 * the company's existing leads stay filterable. A check that could not be loaded keeps its source, so an error never
 * hides real leads.
 */
export function availableLeadSources({ meta, google }: SourceChecks): LeadSource[] {
  const shown: Record<LeadSource, boolean> = {
    facebook: meta === null || meta.pages.length > 0,
    google_ads: google === null || Boolean(google.connection) || google.hasWebhook || google.webhookStopped,
    telecaller: true,
  };
  return LEAD_SOURCES.filter((source) => shown[source]);
}

/**
 * Loads both connection checks once, for the /leads Source filter and the dashboard's platform switch. `sources` is
 * null while loading. `health` is handed to the dashboard's connection warning so it doesn't ask again.
 */
export function useLeadSources(): { sources: LeadSource[] | null; health: ConnectionHealth } {
  const [state, setState] = useState<{ sources: LeadSource[] | null; health: ConnectionHealth }>({ sources: null, health: { meta: null, google: null } });

  useEffect(() => {
    let active = true;
    void Promise.allSettled([getConnectionOverview(), getGoogleAdsOverview()]).then(([metaResult, googleResult]) => {
      if (!active) return;
      const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
      const google = googleResult.status === "fulfilled" ? googleResult.value : null;
      setState({
        sources: availableLeadSources({ meta, google }),
        health: {
          meta: meta?.connectionStatus ?? null,
          google: google ? { hasWebhook: google.hasWebhook, webhookStopped: google.webhookStopped, needsReconnect: google.needsReconnect } : null,
        },
      });
    });
    return () => { active = false; };
  }, []);

  return state;
}
