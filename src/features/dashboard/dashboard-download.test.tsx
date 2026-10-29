import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHART_SETTLE_MS, DashboardReportHeader, DownloadDashboardButton, dashboardPdfTitle } from "@/features/dashboard/dashboard-download";

afterEach(() => vi.unstubAllGlobals());

describe("dashboardPdfTitle", () => {
  it("names the PDF after the platform and the date in the company timezone", () => {
    // 20:00 UTC on 29 Oct is already 30 Oct in India.
    const date = new Date("2026-10-29T20:00:00Z");
    expect(dashboardPdfTitle("Google Ads", date, "Asia/Kolkata")).toBe("AgentzPro Dashboard - Google Ads - 2026-10-30");
    expect(dashboardPdfTitle("Google Ads", date, "UTC")).toBe("AgentzPro Dashboard - Google Ads - 2026-10-29");
  });

  it("still names the PDF when the timezone is not a real one", () => {
    expect(dashboardPdfTitle("Telecaller", new Date(), "Not/AZone")).toMatch(/^AgentzPro Dashboard - Telecaller - \d{4}-\d{2}-\d{2}$/);
  });
});

describe("DownloadDashboardButton", () => {
  const settled = () => new Date(Date.now() - CHART_SETTLE_MS - 1);

  it("opens the print window at once when the charts have settled, and restores the tab title even if afterprint is late or never fires", () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    document.title = "Dashboard";
    render(<DownloadDashboardButton platformLabel="Facebook" timezone="Asia/Kolkata" dataUpdatedAt={settled()} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("Dashboard");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Dashboard");
  });

  it("waits for the chart animation when the numbers changed a moment ago", () => {
    vi.useFakeTimers();
    try {
      const print = vi.fn();
      vi.stubGlobal("print", print);
      render(<DownloadDashboardButton platformLabel="Facebook" dataUpdatedAt={new Date()} disabled={false} />);
      fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
      expect(print).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled();
      act(() => vi.advanceTimersByTime(CHART_SETTLE_MS));
      expect(print).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never opens the print window after the dashboard is left while it was preparing", () => {
    vi.useFakeTimers();
    try {
      const print = vi.fn();
      vi.stubGlobal("print", print);
      const { unmount } = render(<DownloadDashboardButton platformLabel="Facebook" dataUpdatedAt={new Date()} disabled={false} />);
      fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
      unmount();
      vi.advanceTimersByTime(CHART_SETTLE_MS);
      expect(print).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while disabled", () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    render(<DownloadDashboardButton platformLabel="Facebook" dataUpdatedAt={null} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(print).not.toHaveBeenCalled();
  });
});

describe("DashboardReportHeader", () => {
  it("shows when the numbers are from, in the company timezone", () => {
    render(<DashboardReportHeader platformLabel="Facebook" lastUpdated={new Date("2026-10-29T10:00:00Z")} timezone="Asia/Kolkata" hasFilters={false} />);
    expect(screen.getByTestId("dash-report")).toHaveTextContent("Lead Dashboard · Facebook leads");
    expect(screen.getByTestId("dash-report")).toHaveTextContent(/Data as of 29 Oct 2026, 3:30\s?pm \(Asia\/Kolkata\)/i);
    expect(screen.getByTestId("dash-report")).toHaveTextContent("Filters: none (all leads, all time)");
  });

  it("leaves out the time before the first load and the 'no filters' line when filters are set", () => {
    render(<DashboardReportHeader platformLabel="Telecaller" lastUpdated={null} hasFilters />);
    expect(screen.getByTestId("dash-report")).not.toHaveTextContent("Data as of");
    expect(screen.getByTestId("dash-report")).not.toHaveTextContent("Filters: none");
  });
});
