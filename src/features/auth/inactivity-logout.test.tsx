import React, { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InactivityLogout } from "./inactivity-logout";
import { INACTIVITY_TIMEOUT_MS } from "./inactivity";

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
  for (const pathname of ["/dashboard", "/connection", "/leads"]) {
    await act(() => vi.advanceTimersByTimeAsync(2000));
    navigation.pathname = pathname;
    view.rerender(<StrictMode><InactivityLogout /></StrictMode>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(vi.getTimerCount()).toBe(1);
  }
  await act(() => vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1));
  expect(fetch).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledOnce();
  expect(navigation.router.replace).toHaveBeenCalledWith("/login");
  expect(navigation.router.refresh).toHaveBeenCalledOnce();
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(vi.getTimerCount()).toBe(0);
});
