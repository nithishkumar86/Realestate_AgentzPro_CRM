import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_HEARTBEAT_MS, INACTIVITY_STORAGE_KEY, INACTIVITY_TIMEOUT_MS, resetInactivityAfterLogin, startInactivityTracking } from "./inactivity";

describe("inactivity policy", () => {
  const stops: (() => void)[] = [];
  const fetchMock = vi.fn();
  // Heartbeats to /api/auth/activity are asserted separately; these tests count logout requests.
  const calls = (url: string) => fetchMock.mock.calls.filter(([called]) => called === url);
  const logoutCalls = () => calls("/api/auth/logout");
  const heartbeatCalls = () => calls("/api/auth/activity");
  function start(timeoutMs = 10_000) {
    const onSignedOut = vi.fn();
    const onError = vi.fn();
    const tracker = startInactivityTracking({ timeoutMs, onSignedOut, onError });
    stops.push(tracker.stop);
    return { ...tracker, onSignedOut, onError };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    localStorage.clear();
    vi.stubGlobal("BroadcastChannel", undefined);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ signedOut: true }) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the production default at eight hours", () => {
    expect(INACTIVITY_TIMEOUT_MS).toBe(28_800_000);
  });
  it.each(["mousemove", "click", "keydown", "scroll", "touchstart", "touchmove"])("resets the deadline on %s", async (event) => {
    start();
    await vi.advanceTimersByTimeAsync(9000);
    document.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(9999);
    expect(logoutCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(logoutCalls()).toHaveLength(1);
  });
  it("logs out once through the existing endpoint and reports success", async () => {
    const tracker = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(tracker.onSignedOut).toHaveBeenCalledOnce();
    // jsdom queues the browser's storage notification after the timer callback.
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps active users authenticated across many original deadlines", async () => {
    const tracker = start();
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      tracker.activity();
    }
    expect(logoutCalls()).toHaveLength(0);
  });
  it("preserves the deadline across reopening, and checks expiry before accepting activity", async () => {
    const first = start();
    await vi.advanceTimersByTimeAsync(4000);
    first.stop();
    const second = start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(logoutCalls()).toHaveLength(0);
    second.stop();
    vi.setSystemTime(Date.now() + 2000);
    const third = start();
    third.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.onSignedOut).toHaveBeenCalledOnce();
  });
  it("checks an elapsed deadline on wake rather than resetting it", async () => {
    start();
    vi.setSystemTime(Date.now() + 11_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(logoutCalls()).toHaveLength(1);
  });
  it("uses activity from another tab before deciding to sign out", async () => {
    start();
    await vi.advanceTimersByTimeAsync(9000);
    const record = JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY)!);
    record.lastActivity = Date.now();
    localStorage.setItem(INACTIVITY_STORAGE_KEY, JSON.stringify(record));
    window.dispatchEvent(new StorageEvent("storage", { key: INACTIVITY_STORAGE_KEY, newValue: JSON.stringify(record) }));
    await vi.advanceTimersByTimeAsync(9999);
    expect(logoutCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(logoutCalls()).toHaveLength(1);
  });
  it("redirects a peer on successful logout without another request", () => {
    const tracker = start();
    const record = JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY)!);
    record.signedOut = true;
    window.dispatchEvent(new StorageEvent("storage", { key: INACTIVITY_STORAGE_KEY, newValue: JSON.stringify(record) }));
    expect(tracker.onSignedOut).toHaveBeenCalledOnce();
    expect(logoutCalls()).toHaveLength(0);
  });
  it("retries failed logout without allowing activity to renew the expired deadline", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const tracker = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracker.onError).toHaveBeenCalledWith(true);
    expect(tracker.onSignedOut).not.toHaveBeenCalled();
    tracker.activity();
    expect(logoutCalls()).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.onSignedOut).toHaveBeenCalledOnce();
  });
  it("does not treat an HTTP error as successful logout", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "failed" }) });
    const tracker = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracker.onSignedOut).not.toHaveBeenCalled();
    expect(tracker.onError).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("fresh login replaces expired metadata", async () => {
    const tracker = start();
    tracker.stop();
    vi.setSystemTime(Date.now() + 20_000);
    resetInactivityAfterLogin();
    start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(logoutCalls()).toHaveLength(0);
  });
  it("cleans listeners and pending writes, and ignores activity after stop", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const tracker = start();
    await vi.advanceTimersByTimeAsync(100);
    tracker.activity();
    tracker.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("mousemove", expect.any(Function), true);
    document.dispatchEvent(new Event("click"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logoutCalls()).toHaveLength(0);
    expect(heartbeatCalls()).toHaveLength(1);
  });
  it("works in memory when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(resetInactivityAfterLogin).not.toThrow();
    const tracker = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracker.onSignedOut).toHaveBeenCalledOnce();
  });

  it("uses the browser logout lock and rechecks shared activity after acquiring it", async () => {
    let acquire: (() => Promise<void>) | undefined;
    const request = vi.fn((_name, callback) => new Promise<void>((resolve) => {
      acquire = async () => { await callback(); resolve(); };
    }));
    vi.stubGlobal("navigator", { locks: { request } });
    start();
    await vi.advanceTimersByTimeAsync(10_000);
    const record = JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY)!);
    record.lastActivity = Date.now();
    localStorage.setItem(INACTIVITY_STORAGE_KEY, JSON.stringify(record));
    await acquire!();
    expect(request).toHaveBeenCalledOnce();
    expect(logoutCalls()).toHaveLength(0);
  });

  it("closes its broadcast channel and accepts peer activity without persistent storage", async () => {
    const channels: { onmessage: ((event: { data: unknown }) => void) | null; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("BroadcastChannel", class {
      onmessage = null;
      close = vi.fn();
      postMessage = vi.fn();
      constructor() { channels.push(this); }
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const startedAt = Date.now();
    const tracker = start();
    await vi.advanceTimersByTimeAsync(9000);
    channels[0].onmessage!({ data: { startedAt, lastActivity: Date.now(), signedOut: false } });
    await vi.advanceTimersByTimeAsync(9000);
    expect(logoutCalls()).toHaveLength(0);
    tracker.stop();
    expect(channels[0].close).toHaveBeenCalledOnce();
  });

  it("aborts a pending request and suppresses callbacks after unmount", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const tracker = start();
    await vi.advanceTimersByTimeAsync(10_000);
    tracker.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(tracker.onError).not.toHaveBeenCalled();
    expect(tracker.onSignedOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  describe("server heartbeat", () => {
    it("reports real activity at most once per interval, with a trailing report for later activity", async () => {
      const tracker = start(INACTIVITY_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_MS);
      expect(heartbeatCalls()).toHaveLength(0);
      tracker.activity();
      expect(heartbeatCalls()).toHaveLength(1);
      expect(heartbeatCalls()[0][1]).toEqual(expect.objectContaining({ method: "POST", credentials: "same-origin" }));
      await vi.advanceTimersByTimeAsync(60_000);
      tracker.activity();
      tracker.activity();
      expect(heartbeatCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_MS - 60_000 - 1);
      expect(heartbeatCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(heartbeatCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4 * ACTIVITY_HEARTBEAT_MS);
      expect(heartbeatCalls()).toHaveLength(2);
    });
    it("never reports activity for an idle page", async () => {
      start(INACTIVITY_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1);
      expect(heartbeatCalls()).toHaveLength(0);
    });
    it("does not report activity once the deadline has passed", async () => {
      const tracker = start();
      vi.setSystemTime(Date.now() + 11_000);
      tracker.activity();
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeatCalls()).toHaveLength(0);
      expect(tracker.onSignedOut).toHaveBeenCalledOnce();
    });
    it("goes to sign-in without revoking anything when the server has no session", async () => {
      fetchMock.mockImplementation(async (url: string) => url === "/api/auth/activity"
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ signedOut: true }) });
      const tracker = start(INACTIVITY_TIMEOUT_MS);
      tracker.activity();
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.onSignedOut).toHaveBeenCalledOnce();
      expect(logoutCalls()).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY)!).signedOut).toBe(false);
      expect(tracker.onError).not.toHaveBeenCalled();
    });
    it("keeps the session when a heartbeat fails for a network reason", async () => {
      fetchMock.mockRejectedValue(new Error("offline"));
      const tracker = start(INACTIVITY_TIMEOUT_MS);
      tracker.activity();
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.onSignedOut).not.toHaveBeenCalled();
      expect(logoutCalls()).toHaveLength(0);
    });
  });
});
