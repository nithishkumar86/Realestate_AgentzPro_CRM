import "server-only";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Server-side bridge from Supabase Realtime to dashboard SSE streams.
 *
 * A Postgres trigger on lead_data broadcasts a PII-free ping on the private topic
 * `dashboard:<tenant_id>` (see migration 20260929120000). Browsers cannot join that topic (no policy
 * on realtime.messages for anon/authenticated); only this module, using the service role, can.
 *
 * One Realtime channel is held per tenant per server instance and shared by every SSE stream of
 * that tenant on the instance, so open dashboards cost one Realtime connection, not one each.
 * A stream can only ever attach to the tenant id it was authenticated for.
 */

export type RelayEvent = "change" | "degraded" | "live";

interface TenantChannel {
  channel: RealtimeChannel;
  listeners: Set<(event: RelayEvent) => void>;
  state: "connecting" | "live" | "degraded";
  degradedTimer: ReturnType<typeof setTimeout> | undefined;
  hasBeenLive: boolean;
}

// A first join can fail once with "MissingPartition" and then succeed on Realtime's own retry, so a
// channel only counts as degraded after it has failed to (re)join for this long.
const DEGRADED_AFTER_MS = 10_000;

const tenantChannels = new Map<string, TenantChannel>();

function emit(entry: TenantChannel, event: RelayEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch {
      // One broken stream must not stop the others receiving the event.
    }
  }
}

function openTenantChannel(tenantId: string): TenantChannel {
  const channel = getSupabaseAdminClient().channel(`dashboard:${tenantId}`, { config: { private: true } });
  const entry: TenantChannel = { channel, listeners: new Set(), state: "connecting", degradedTimer: undefined, hasBeenLive: false };

  channel.on("broadcast", { event: "lead_change" }, () => emit(entry, "change"));
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      clearTimeout(entry.degradedTimer);
      entry.degradedTimer = undefined;
      const recovered = entry.state === "degraded" || (entry.hasBeenLive && entry.state === "connecting");
      entry.state = "live";
      entry.hasBeenLive = true;
      emit(entry, "live");
      // Leads can arrive while the channel is down; tell streams to refetch once it is back.
      if (recovered) emit(entry, "change");
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      if (entry.state === "live") entry.state = "connecting";
      if (!entry.degradedTimer && entry.state !== "degraded") {
        entry.degradedTimer = setTimeout(() => {
          entry.degradedTimer = undefined;
          entry.state = "degraded";
          emit(entry, "degraded");
        }, DEGRADED_AFTER_MS);
      }
    }
  });
  return entry;
}

/**
 * Attaches a listener to one tenant's change feed and returns its detach function. When the last
 * listener detaches the Realtime channel is torn down.
 */
export function subscribeToTenantChanges(tenantId: string, listener: (event: RelayEvent) => void): () => void {
  let entry = tenantChannels.get(tenantId);
  if (!entry) {
    entry = openTenantChannel(tenantId);
    tenantChannels.set(tenantId, entry);
  }
  entry.listeners.add(listener);
  // A late joiner needs the current state, not just future transitions.
  if (entry.state === "live") listener("live");
  if (entry.state === "degraded") listener("degraded");

  const attached = entry;
  return () => {
    attached.listeners.delete(listener);
    if (attached.listeners.size === 0) {
      clearTimeout(attached.degradedTimer);
      tenantChannels.delete(tenantId);
      void getSupabaseAdminClient().removeChannel(attached.channel);
    }
  };
}
