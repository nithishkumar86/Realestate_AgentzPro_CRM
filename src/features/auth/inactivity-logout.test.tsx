import React, { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InactivityLogout, SignedInInactivityLogout } from "./inactivity-logout";
import { ACTIVITY_HEARTBEAT_MS, INACTIVITY_TIMEOUT_MS } from "./inactivity";

const calls = (url: string) => vi.mocked(fetch).mock.calls.filter(([called]) => called === url);

const navigation = vi.hoisted(() => ({ pathname: "/leads", router: { replace: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router, usePathname: () => navigation.pathname }));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  navigation.pathname = "/leads";
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ signedOut: true }) }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps one tracker through Strict Mode and route navigation, then redirects to the existing login", async () => {
  const view = render(<StrictMode><InactivityLogout /></StrictMode>);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(vi.getTimerCount()).toBe(1);
  // One idle deadline, plus one trailing heartbeat once navigation happens inside a heartbeat interval.
  for (const [pathname, timers, heartbeats] of [["/dashboard", 1, 1], ["/connection", 2, 1], ["/leads", 2, 1]] as const) {
    await act(() => vi.advanceTimersByTimeAsync(2000));
    navigation.pathname = pathname;
    view.rerender(<StrictMode><InactivityLogout /></StrictMode>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(vi.getTimerCount()).toBe(timers);
    expect(calls("/api/auth/activity")).toHaveLength(heartbeats);
  }
  await act(() => vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_MS));
  expect(calls("/api/auth/activity")).toHaveLength(2);
  await act(() => vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - ACTIVITY_HEARTBEAT_MS - 1));
  expect(calls("/api/auth/logout")).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(calls("/api/auth/logout")).toHaveLength(1);
  expect(navigation.router.replace).toHaveBeenCalledWith("/login");
  expect(navigation.router.refresh).toHaveBeenCalledOnce();
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["/billing", "/onboarding"])("runs the idle logout on the signed-in page %s", async (pathname) => {
  navigation.pathname = pathname;
  render(<SignedInInactivityLogout />);
  await act(() => vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS));
  expect(calls("/api/auth/logout")).toHaveLength(1);
  expect(navigation.router.replace).toHaveBeenCalledWith("/login");
});

it.each(["/login", "/auth/confirm"])("does not track the signed-out page %s", async (pathname) => {
  navigation.pathname = pathname;
  render(<SignedInInactivityLogout />);
  await act(() => vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS));
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
