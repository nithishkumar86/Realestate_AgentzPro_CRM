// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCallback = (status: string) => void;

const mocks = vi.hoisted(() => {
  const channels: Array<{ topic: string; config: unknown; onBroadcast: () => void; status: (status: string) => void }> = [];
  return {
    channels,
    removeChannel: vi.fn(() => Promise.resolve("ok")),
    channel: vi.fn((topic: string, config: unknown) => {
      const record = { topic, config, onBroadcast: () => {}, status: (() => {}) as StatusCallback };
      channels.push(record);
      return {
        on: vi.fn((_type: string, _filter: unknown, callback: () => void) => { record.onBroadcast = callback; }),
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
