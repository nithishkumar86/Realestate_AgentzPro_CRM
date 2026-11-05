import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEADS_CHANGED_EVENT } from "@/components/task-bell";
import { NEW_LEADS_POLL_MS, useNewLeadsCount, type NewLeadsSnapshot } from "@/features/leads/use-new-leads-count";

const CURSOR = "2026-11-05T09:30:12.123456+00:00";
const snapshot = (body: Record<string, unknown> = { quickFilter: "all", pageSize: 100 }, cursor: string | null = CURSOR): NewLeadsSnapshot => ({ body, cursor });

/** A reply the test releases by hand, to hold a check "in flight". */
function deferred() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
const reply = (count: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { count } : { error: { message: "x" } }), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
const leadWritten = () => act(() => { window.dispatchEvent(new Event(LEADS_CHANGED_EVENT)); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setHidden = (hidden: boolean) => Object.defineProperty(document, "hidden", { configurable: true, value: hidden });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  setHidden(false);
  fetchMock = vi.fn(async () => reply(1));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setHidden(false); });

describe("useNewLeadsCount", () => {
  it("checks once, 750 ms after a burst of lead writes, with the saved request and its cursor", async () => {
    const saved = snapshot({ quickFilter: "today", status: "New Lead", pageSize: 100 });
    const { result } = renderHook(() => useNewLeadsCount(saved));
    leadWritten(); leadWritten(); leadWritten();
    await wait(700);
    expect(fetchMock).not.toHaveBeenCalled();
    await wait(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/leads/new-count");
    expect(bodies()[0]).toEqual({ quickFilter: "today", status: "New Lead", pageSize: 100, since: CURSOR });
    expect(result.current).toBe(1);
  });

  it("sends a null cursor as null", async () => {
    const saved = snapshot(undefined, null);
    renderHook(() => useNewLeadsCount(saved));
    leadWritten();
    await wait(750);
    expect(bodies()[0]).toMatchObject({ since: null });
  });

  it("runs one request at a time and exactly one more for writes during it", async () => {
    const first = deferred();
    fetchMock.mockImplementationOnce(() => first.promise);
    const saved = snapshot();
    const { result } = renderHook(() => useNewLeadsCount(saved));
    leadWritten();
    await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    leadWritten(); await wait(750);
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => reply(4));
    first.resolve(reply(2));
    await wait(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(4);
  });

  it("checks every 60 s while the tab is visible, and never while it is hidden", async () => {
    const saved = snapshot();
    renderHook(() => useNewLeadsCount(saved));
    await wait(NEW_LEADS_POLL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await wait(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setHidden(true);
    await wait(NEW_LEADS_POLL_MS * 3);
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setHidden(false);
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows 0 while a load runs, and checks the new load as soon as it lands when a lead was written meanwhile", async () => {
    const { result, rerender } = renderHook(({ current }) => useNewLeadsCount(current), { initialProps: { current: snapshot() as NewLeadsSnapshot | undefined } });
    leadWritten(); await wait(750);
    expect(result.current).toBe(1);

    rerender({ current: undefined });
    expect(result.current).toBe(0);
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const next = snapshot({ quickFilter: "all", status: "Working", pageSize: 100 });
    rerender({ current: next });
    await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ status: "Working" });
  });

  it("never shows a reply that belongs to an older load", async () => {
    const slow = deferred();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const { result, rerender } = renderHook(({ current }) => useNewLeadsCount(current), { initialProps: { current: snapshot() } });
    leadWritten(); await wait(750);
    const aborted = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    rerender({ current: snapshot({ quickFilter: "all", status: "Working", pageSize: 100 }) });
    expect(aborted.aborted).toBe(true);
    slow.resolve(reply(9));
    await wait(0);
    expect(result.current).toBe(0);
  });

  it("ignores failed checks and malformed counts, keeping no bar", async () => {
    const saved = snapshot();
    const { result } = renderHook(() => useNewLeadsCount(saved));
    for (const response of [reply(0, 500), reply("3"), reply(-1), reply(1.5), new Response("not json", { status: 200 })]) {
      fetchMock.mockImplementationOnce(async () => response);
      leadWritten(); await wait(750);
      expect(result.current).toBe(0);
    }
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("network down"); });
    leadWritten(); await wait(750);
    expect(result.current).toBe(0);
  });

  it("stops checking once the session is signed out (401)", async () => {
    fetchMock.mockImplementation(async () => reply(0, 401));
    const saved = snapshot();
    renderHook(() => useNewLeadsCount(saved));
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    leadWritten(); await wait(750);
    await wait(NEW_LEADS_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up on unmount: no timer, listener or request is left behind", async () => {
    const slow = deferred();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const saved = snapshot();
    const { unmount } = renderHook(() => useNewLeadsCount(saved));
    leadWritten(); await wait(750);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    leadWritten();
    unmount();
    expect(signal.aborted).toBe(true);
    slow.resolve(reply(5));
    await wait(NEW_LEADS_POLL_MS * 2);
    leadWritten(); await wait(750);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
