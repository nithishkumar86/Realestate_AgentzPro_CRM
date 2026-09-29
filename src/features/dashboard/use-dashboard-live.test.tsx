import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msUntilNextMidnight, useDashboardStats } from "@/features/dashboard/use-dashboard-live";

const nav = vi.hoisted(() => ({ reloadPage: vi.fn(), goToLogin: vi.fn() }));
vi.mock("@/features/dashboard/navigation", () => nav);

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, callback: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  emit(type: string, data: unknown = {}) { for (const callback of this.listeners.get(type) ?? []) callback({ data: JSON.stringify(data) }); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const fetchMock = vi.fn();

function stats(overrides: Record<string, unknown> = {}) {
  return { tenantId: "tenant-a", timezone: "Asia/Kolkata", granularity: "month", total: 5, monthToDate: 3, previousMonthSamePeriod: 1, byPage: [], byLabel: [], byStatus: [], topAds: [], timeline: [], timelineTruncated: false, generatedAt: "2026-09-29T06:00:00Z", ...overrides };
}
function ok(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const latestStream = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  FakeEventSource.instances = [];
  fetchMock.mockReset();
  nav.reloadPage.mockReset();
  nav.goToLogin.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useDashboardStats", () => {
  it("loads immediately, opens the stream, and goes live once the server says ready", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { result } = renderHook(() => useDashboardStats({ quickFilter: "all" }));
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/stats", expect.objectContaining({ method: "POST", body: JSON.stringify({ quickFilter: "all" }) }));
    expect(result.current.stats?.monthToDate).toBe(3);
    expect(result.current.liveState).toBe("connecting");
    act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
    expect(result.current.liveState).toBe("live");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/dashboard/stream");
  });

  it("refetches once, after a short debounce, when the server reports a change", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(ok(stats({ monthToDate: 4, total: 6 })));
    act(() => { latestStream().emit("change"); latestStream().emit("change"); latestStream().emit("change"); });
    await advance(700);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.stats?.monthToDate).toBe(4);
  });

  it("refetches after a filter change and never lets a slower, older response overwrite the newer one", async () => {
    let resolveSlow: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok(stats({ total: 1 }))));
    const { result, rerender } = renderHook(({ body }) => useDashboardStats(body), { initialProps: { body: {} as Record<string, unknown> } });
    await settle();
    expect(result.current.stats?.total).toBe(1);

    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSlow = resolve; })); // status=Sale (slow)
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok(stats({ total: 22 })))); // status=Closed (fast)
    rerender({ body: { status: "Sale" } });
    await advance(250);
    rerender({ body: { status: "Closed" } });
    await advance(250);
    expect(result.current.stats?.total).toBe(22);
    await act(async () => { resolveSlow(ok(stats({ total: 999 }))); await Promise.resolve(); });
    expect(result.current.stats?.total).toBe(22);
  });

  it("debounces typing so one burst of filter changes sends one request", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { rerender } = renderHook(({ body }) => useDashboardStats(body), { initialProps: { body: {} as Record<string, unknown> } });
    await settle();
    fetchMock.mockClear();
    for (const search of ["r", "ra", "rav", "ravi"]) { rerender({ body: { search } }); await advance(50); }
    await advance(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ search: "ravi" }));
  });

  it("reloads instead of rendering another company's numbers when the tenant changes", async () => {
    fetchMock.mockResolvedValueOnce(ok(stats({ tenantId: "tenant-a", monthToDate: 3 })));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    fetchMock.mockResolvedValueOnce(ok(stats({ tenantId: "tenant-b", monthToDate: 777 })));
    await act(async () => { await result.current.refresh(); });
    expect(nav.reloadPage).toHaveBeenCalledTimes(1);
    expect(result.current.stats?.monthToDate).toBe(3);
  });

  it("reloads when the stream announces a different tenant than the page loaded", async () => {
    fetchMock.mockResolvedValue(ok(stats({ tenantId: "tenant-a" })));
    renderHook(() => useDashboardStats({}));
    await settle();
    act(() => latestStream().emit("ready", { tenantId: "tenant-b" }));
    expect(nav.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-out or idle-expired session to /login instead of showing an error or polling", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 }));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    expect(nav.goToLogin).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a server error with a readable message", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "The dashboard could not be loaded." } }), { status: 500 }));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    expect(result.current.error).toBe("The dashboard could not be loaded.");
    expect(result.current.stats).toBeNull();
  });

  it("falls back to polling every 15s when the stream is degraded, and stops once it recovers", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
    fetchMock.mockClear();
    act(() => latestStream().emit("status", { state: "degraded" }));
    expect(result.current.liveState).toBe("polling");
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    act(() => latestStream().emit("status", { state: "live" }));
    expect(result.current.liveState).toBe("live");
    await advance(45_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls, probes the session, and retries the stream when the browser gives up on it", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    const first = latestStream();
    fetchMock.mockClear();
    first.readyState = FakeEventSource.CLOSED;
    act(() => first.onerror?.());
    await settle();
    expect(result.current.liveState).toBe("polling");
    expect(fetchMock).toHaveBeenCalledTimes(1); // the session probe
    await advance(30_000);
    expect(FakeEventSource.instances).toHaveLength(2); // stream retried
  });

  it("shows 'reconnecting' while the browser retries a dropped stream on its own", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { result } = renderHook(() => useDashboardStats({}));
    await settle();
    act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
    act(() => latestStream().onerror?.()); // readyState stays CONNECTING (1 in the fake)
    expect(result.current.liveState).toBe("reconnecting");
  });

  describe("when the connection drops and the browser keeps retrying the stream", () => {
    async function goLive() {
      fetchMock.mockResolvedValue(ok(stats()));
      const hook = renderHook(() => useDashboardStats({}));
      await settle();
      act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
      fetchMock.mockClear();
      return hook;
    }
    const retryError = () => act(() => latestStream().onerror?.()); // readyState stays CONNECTING in the fake

    it("polls after 10s of failed retries (the timer is not re-armed by each retry), then every 15s", async () => {
      const { result } = await goLive();
      for (let attempt = 0; attempt < 4; attempt += 1) { // failures at 0s, 3s, 6s, 9s
        if (attempt > 0) await advance(3_000);
        retryError();
        expect(result.current.liveState).toBe("reconnecting");
        expect(fetchMock).not.toHaveBeenCalled();
      }
      await advance(1_000); // 10s since the first failure
      expect(result.current.liveState).toBe("polling");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      retryError(); // later retry errors must not restart anything, nor flip the pill back
      expect(result.current.liveState).toBe("polling");
      await advance(15_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(15_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("goes live again on the same stream, catches up once, and stops polling", async () => {
      const { result } = await goLive();
      retryError();
      await advance(10_000);
      expect(result.current.liveState).toBe("polling");
      fetchMock.mockClear();
      act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
      expect(result.current.liveState).toBe("live");
      await advance(750);
      expect(fetchMock).toHaveBeenCalledTimes(1); // catch-up
      await advance(45_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no more polls
    });

    it("never polls for a short blip, but still catches up once when the stream returns", async () => {
      const { result } = await goLive();
      retryError();
      await advance(4_000);
      act(() => latestStream().emit("ready", { tenantId: "tenant-a" }));
      expect(result.current.liveState).toBe("live");
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not refetch on the first connect", async () => {
      await goLive();
      await advance(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still reloads instead of catching up when the reconnected stream belongs to another company", async () => {
      await goLive();
      retryError();
      act(() => latestStream().emit("ready", { tenantId: "tenant-b" }));
      await advance(2_000);
      expect(nav.reloadPage).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["unmount", "hide"])("does not start polling after the %s happened inside the grace window", async (how) => {
      const { unmount } = await goLive();
      retryError();
      await advance(5_000);
      if (how === "unmount") unmount();
      else {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      }
      await advance(60_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("holds no stream while the tab is hidden and reconnects (with a refetch) when it returns", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    renderHook(() => useDashboardStats({}));
    await settle();
    const stream = latestStream();
    fetchMock.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("closes its stream and stops all timers on unmount", async () => {
    fetchMock.mockResolvedValue(ok(stats()));
    const { unmount } = renderHook(() => useDashboardStats({}));
    await settle();
    const stream = latestStream();
    unmount();
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    fetchMock.mockClear();
    await advance(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("msUntilNextMidnight", () => {
  it("counts to the next local midnight in the tenant's timezone, not the browser's", () => {
    // 2026-09-29 18:00 UTC is 23:30 IST -> 30 minutes to IST midnight (+1s guard).
    expect(msUntilNextMidnight("Asia/Kolkata", new Date("2026-09-29T18:00:00.000Z"))).toBe(30 * 60 * 1000 + 1000);
    // The same instant is 14:00 in New York -> 10 hours to midnight there.
    expect(msUntilNextMidnight("America/New_York", new Date("2026-09-29T18:00:00.000Z"))).toBe(10 * 3600 * 1000 + 1000);
  });
});
