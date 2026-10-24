import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacebookReconnectBanner, needsFacebookReconnect, notifyFacebookConnectionChanged } from "@/components/facebook-reconnect-banner";
import type { ConnectionOverview } from "@/lib/types";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), pathname: "/leads" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/services/crm-api-client", () => ({ getConnectionOverview: mocks.connection }));

const page = { id: "page-row", connectionId: "connection", pageName: "BRIQ", category: null, pageIdLastFour: "9866", lastConnectedAt: "2026-10-22T04:11:00.000Z" };
const overview = (patch: Partial<ConnectionOverview> = {}): ConnectionOverview => ({
  connectionStatus: "active",
  pages: [{ ...page, status: "active" }],
  canManage: true,
  ...patch,
});
const TITLE = "Long-lived access token expired. Lead retrieval is currently paused.";
const BODY = "Please immediately ask the owner to reconnect the Facebook Page.";

beforeEach(() => {
  mocks.pathname = "/leads";
  mocks.connection.mockResolvedValue(overview());
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("needsFacebookReconnect", () => {
  it("is true only when a Page's long-lived token failed a lead fetch", () => {
    expect(needsFacebookReconnect(overview({ pages: [{ ...page, status: "active" }, { ...page, id: "other", status: "reauthorization_required" }] }))).toBe(true);
  });

  it("is false for connection-level flags, a healthy, intentionally disconnected or never-connected account", () => {
    expect(needsFacebookReconnect(overview({ connectionStatus: "reauthorization_required" }))).toBe(false);
    expect(needsFacebookReconnect(overview())).toBe(false);
    expect(needsFacebookReconnect(overview({ connectionStatus: "disconnected", pages: [{ ...page, status: "disconnected" }] }))).toBe(false);
    expect(needsFacebookReconnect(overview({ connectionStatus: "not_connected", pages: [] }))).toBe(false);
  });
});

describe("FacebookReconnectBanner", () => {
  it.each([true, false])("shows the same message to every member (owner: %s) when a lead fetch flagged the Page", async (canManage) => {
    mocks.connection.mockResolvedValue(overview({ pages: [{ ...page, status: "reauthorization_required" }], canManage }));
    render(<FacebookReconnectBanner />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows nothing while Facebook is healthy", async () => {
    render(<FacebookReconnectBanner />);
    await waitFor(() => expect(mocks.connection).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it("shows nothing and never breaks the page when the check fails", async () => {
    mocks.connection.mockRejectedValue(new Error("network"));
    render(<FacebookReconnectBanner />);
    await waitFor(() => expect(mocks.connection).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it("shows on the Connection page too", async () => {
    mocks.pathname = "/connection";
    mocks.connection.mockResolvedValue(overview({ pages: [{ ...page, status: "reauthorization_required" }] }));
    render(<FacebookReconnectBanner />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
  });

  it("clears straight away when the owner reconnects on the Connection page", async () => {
    mocks.pathname = "/connection";
    mocks.connection.mockResolvedValue(overview({ pages: [{ ...page, status: "reauthorization_required" }] }));
    render(<FacebookReconnectBanner />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();

    mocks.connection.mockResolvedValue(overview());
    act(() => { notifyFacebookConnectionChanged(); });
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
    expect(mocks.connection).toHaveBeenCalledTimes(2);
  });

  it("re-checks on leaving the Connection page, so the warning clears right after a reconnect", async () => {
    mocks.connection.mockResolvedValue(overview({ pages: [{ ...page, status: "reauthorization_required" }] }));
    const { rerender } = render(<FacebookReconnectBanner />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();

    mocks.pathname = "/connection";
    rerender(<FacebookReconnectBanner />);
    mocks.connection.mockResolvedValue(overview());
    mocks.pathname = "/leads";
    rerender(<FacebookReconnectBanner />);

    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
    expect(mocks.connection).toHaveBeenCalledTimes(2);
  });

  it("shows the warning to someone who stays on one page when Facebook fails mid-day", async () => {
    vi.useFakeTimers();
    render(<FacebookReconnectBanner />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();

    mocks.connection.mockResolvedValue(overview({ pages: [{ ...page, status: "reauthorization_required" }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(mocks.connection).toHaveBeenCalledTimes(2);
    expect(screen.getByText(TITLE)).toBeInTheDocument();
  });

  it("re-checks other page changes and tab returns at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { rerender } = render(<FacebookReconnectBanner />);
    await waitFor(() => expect(mocks.connection).toHaveBeenCalledTimes(1));

    mocks.pathname = "/tasks";
    rerender(<FacebookReconnectBanner />);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.connection).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 60_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.connection).toHaveBeenCalledTimes(2);
  });
});
