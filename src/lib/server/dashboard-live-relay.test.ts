// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCallback = (status: string) => void;

const mocks = vi.hoisted(() => {
  const channels: Array<{ topic: string; config: unknown; onBroadcast: () => void; handlers: Record<string, (message?: unknown) => void>; status: (status: string) => void }> = [];
  return {
    channels,
    removeChannel: vi.fn(() => Promise.resolve("ok")),
    channel: vi.fn((topic: string, config: unknown) => {
      const record = { topic, config, onBroadcast: () => {}, handlers: {} as Record<string, (message?: unknown) => void>, status: (() => {}) as StatusCallback };
      channels.push(record);
      return {
        on: vi.fn((_type: string, filter: { event: string }, callback: (message?: unknown) => void) => {
          record.handlers[filter.event] = callback;
          if (filter.event === "lead_change") record.onBroadcast = callback;
        }),
        subscribe: vi.fn((callback: StatusCallback) => { record.status = callback; }),
        record,
      };
    }),
  };
});
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ channel: mocks.channel, removeChannel: mocks.removeChannel }) }));

import { subscribeToTenantChanges } from "@/lib/server/dashboard-live-relay";

beforeEach(() => { vi.useFakeTimers(); mocks.channels.length = 0; mocks.channel.mockClear(); mocks.removeChannel.mockClear(); });
afterEach(() => vi.useRealTimers());

describe("dashboard live relay", () => {
  it("opens one private channel per tenant and shares it across streams", () => {
    const a1 = vi.fn(); const a2 = vi.fn(); const b = vi.fn();
    const stopA1 = subscribeToTenantChanges("tenant-a", a1);
    const stopA2 = subscribeToTenantChanges("tenant-a", a2);
    const stopB = subscribeToTenantChanges("tenant-b", b);
    expect(mocks.channel).toHaveBeenCalledTimes(2);
    expect(mocks.channel).toHaveBeenCalledWith("dashboard:tenant-a", { config: { private: true } });
    expect(mocks.channel).toHaveBeenCalledWith("dashboard:tenant-b", { config: { private: true } });

    mocks.channels[0].onBroadcast();
    expect(a1).toHaveBeenCalledWith("change");
    expect(a2).toHaveBeenCalledWith("change");
    expect(b).not.toHaveBeenCalled(); // a tenant only ever hears its own topic

    stopA1(); stopA2(); stopB();
  });

  it("tears the channel down only when the last stream of that tenant leaves", () => {
    const stop1 = subscribeToTenantChanges("tenant-c", vi.fn());
    const stop2 = subscribeToTenantChanges("tenant-c", vi.fn());
    stop1();
    expect(mocks.removeChannel).not.toHaveBeenCalled();
    stop2();
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
    // A new stream after teardown gets a fresh channel.
    const stop3 = subscribeToTenantChanges("tenant-c", vi.fn());
    expect(mocks.channel).toHaveBeenCalledTimes(2);
    stop3();
  });

  it("does not call a transient join error 'degraded', but does after sustained failure", () => {
    const listener = vi.fn();
    const stop = subscribeToTenantChanges("tenant-d", listener);
    const { status } = mocks.channels[0];
    status("CHANNEL_ERROR"); // e.g. MissingPartition on the very first join
    vi.advanceTimersByTime(3_000);
    status("SUBSCRIBED");
    vi.advanceTimersByTime(20_000);
    expect(listener).not.toHaveBeenCalledWith("degraded");
    expect(listener).toHaveBeenCalledWith("live");

    listener.mockClear();
    status("CHANNEL_ERROR");
    vi.advanceTimersByTime(10_001);
    expect(listener).toHaveBeenCalledWith("degraded");
    stop();
  });

  it("tells streams to refetch after a gap, because leads may have arrived while it was down", () => {
    const listener = vi.fn();
    const stop = subscribeToTenantChanges("tenant-e", listener);
    const { status } = mocks.channels[0];
    status("SUBSCRIBED");
    listener.mockClear();
    status("CHANNEL_ERROR");
    vi.advanceTimersByTime(10_001);
    status("SUBSCRIBED");
    expect(listener.mock.calls.map(([event]) => event)).toEqual(["degraded", "live", "change"]);
    stop();
  });

  it("relays a task reminder only with well-formed ids", () => {
    const a = vi.fn();
    const stop = subscribeToTenantChanges("tenant-r", a);
    const reminder = mocks.channels[mocks.channels.length - 1].handlers.task_reminder;
    const ids = { notification_id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222" };
    reminder({ payload: ids });
    expect(a).toHaveBeenCalledWith("reminder", { notificationId: ids.notification_id, userId: ids.user_id });
    a.mockClear();
    reminder({ payload: { ...ids, user_id: "nope" } });
    reminder({ payload: { notification_id: 7 } });
    reminder(undefined);
    expect(a).not.toHaveBeenCalled();
    stop();
  });

  it("relays a timeline activity with only a well-formed lead id, to that tenant only", () => {
    const a = vi.fn(); const b = vi.fn();
    const stopA = subscribeToTenantChanges("tenant-g", a);
    const stopB = subscribeToTenantChanges("tenant-h", b);
    const activity = mocks.channels[0].handlers.lead_activity;
    activity({ payload: { lead_id: "11111111-1111-4111-8111-111111111111" } });
    expect(a).toHaveBeenCalledWith("activity", { leadId: "11111111-1111-4111-8111-111111111111" });
    expect(b).not.toHaveBeenCalled();
    a.mockClear();
    activity({ payload: { lead_id: "not-a-uuid" } });
    activity({ payload: { lead_id: 42 } });
    activity(undefined);
    expect(a).not.toHaveBeenCalled();
    stopA(); stopB();
  });

  it("gives a late joiner the current state and survives a throwing listener", () => {
    const first = vi.fn(() => { throw new Error("boom"); });
    const stopFirst = subscribeToTenantChanges("tenant-f", first);
    mocks.channels[0].status("SUBSCRIBED");
    const late = vi.fn();
    const stopLate = subscribeToTenantChanges("tenant-f", late);
    expect(late).toHaveBeenCalledWith("live");
    mocks.channels[0].onBroadcast();
    expect(late).toHaveBeenCalledWith("change");
    stopFirst(); stopLate();
  });
});
