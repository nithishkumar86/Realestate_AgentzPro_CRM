import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPageClient } from "@/features/dashboard/dashboard-page-client";

const mocks = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/services/crm-api-client", () => ({ getConnectionOverview: mocks.connection }));
vi.mock("@/features/dashboard/navigation", () => ({ reloadPage: vi.fn(), goToLogin: vi.fn() }));
// recharts needs real layout; the charts' own maths is covered by dashboard-format tests and the browser run.
vi.mock("@/features/dashboard/dashboard-charts", () => ({
  TimelineChart: ({ data }: { data: unknown[] }) => <div data-testid="timeline">{data.length} buckets</div>,
  DonutChart: ({ ariaLabel, data }: { ariaLabel: string; data: Array<{ name: string; count: number }> }) => <div data-testid={ariaLabel}>{data.map((d) => `${d.name}:${d.count}`).join("|")}</div>,
  StatusRankChart: ({ ariaLabel, data }: { ariaLabel: string; data: Array<{ status: string; count: number }> }) => <div data-testid={ariaLabel}>{data.map((d) => `${d.status}:${d.count}`).join("|")}</div>,
  HorizontalBarChart: ({ ariaLabel, data }: { ariaLabel: string; data: Array<{ name: string; count: number }> }) => <div data-testid={ariaLabel}>{data.map((d) => `${d.name}:${d.count}`).join("|")}</div>,
  pageDonutData: (rows: Array<{ pageName: string; count: number }>) => rows.map((r) => ({ name: r.pageName, count: r.count })),
  labelDonutData: (rows: Array<{ label: string; count: number }>) => rows.map((r) => ({ name: r.label, count: r.count })),
}));

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, callback: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  emit(type: string, data: unknown = {}) { for (const callback of this.listeners.get(type) ?? []) callback({ data: JSON.stringify(data) }); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const OPTIONS = { pages: [{ id: PAGE_ID, name: "Chennai Homes" }], ads: [{ id: "6301-karuvi", name: "karuvi" }], defaultAdId: "6301-karuvi" };
const LABELS = ["Hot", "Warm", "Cold", "Not Interested"].map((label, index) => ({ label, count: [2, 1, 1, 1][index] }));
function stats(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a", timezone: "Asia/Kolkata", granularity: "month", total: 5, monthToDate: 3, previousMonthSamePeriod: 1,
    byPage: [{ pageRecordId: PAGE_ID, pageName: "Chennai Homes", count: 5 }], byLabel: LABELS,
    byStatus: [{ status: "New Lead", count: 5 }], topAds: [{ adId: "6301-karuvi", name: "karuvi", count: 5 }],
    timeline: [{ bucket: "2026-08-01T00:00:00", count: 2 }, { bucket: "2026-09-01T00:00:00", count: 3 }], timelineTruncated: false, generatedAt: "2026-09-29T06:00:00Z",
    ...overrides,
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const statBodies: Array<Record<string, unknown>> = [];
let nextStats: () => Response;

beforeEach(() => {
  statBodies.length = 0;
  FakeEventSource.instances = [];
  nextStats = () => json(stats());
  mocks.connection.mockResolvedValue({ connectionStatus: "connected" });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/leads/filters")) return json(OPTIONS);
    if (url === "/api/dashboard/stats") { statBodies.push(JSON.parse(String(init?.body))); return nextStats(); }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("dashboard page", () => {
  it("shows this month's leads and every chart for the current filters, opening on ALL ads", async () => {
    render(<DashboardPageClient />);
    expect(await screen.findByTestId("month-leads")).toHaveTextContent("3");
    expect(screen.getByText("This Month Leads")).toBeInTheDocument();
    expect(screen.getByText(/200% more than the same period last month/)).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveTextContent("2 buckets");
    expect(screen.getByTestId("Leads by Facebook Page")).toHaveTextContent("Chennai Homes:5");
    expect(screen.getByTestId("Leads by label")).toHaveTextContent("Hot:2|Warm:1|Cold:1|Not Interested:1");
    expect(screen.getByTestId("Leads by status")).toHaveTextContent("New Lead:5");
    expect(screen.getByTestId("Leads by ad")).toHaveTextContent("karuvi (ruvi):5");
    // Unlike /leads, the dashboard must not pre-select the newest ad, or every total would be narrowed to it.
    expect(statBodies[0]).not.toHaveProperty("adId");
    expect(screen.queryByText(/Ad: karuvi/)).not.toBeInTheDocument();
  });

  it("has the /leads filters but no Delete or Download, and none of the old cards", async () => {
    render(<DashboardPageClient />);
    await screen.findByTestId("month-leads");
    for (const name of ["Page", "Ad", "Status", "Label"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Today's Leads/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Leads Today")).not.toBeInTheDocument();
    expect(screen.queryByText("All Leads", { selector: "span" })).not.toBeInTheDocument();
  });

  it("recomputes for a Page filter and shows a removable chip", async () => {
    render(<DashboardPageClient />);
    await screen.findByTestId("month-leads");
    fireEvent.click(screen.getByRole("button", { name: "Page" }));
    fireEvent.click(await screen.findByRole("option", { name: "Chennai Homes" }));
    await waitFor(() => expect(statBodies.at(-1)).toMatchObject({ pageRecordId: PAGE_ID }));
    fireEvent.click(await screen.findByRole("button", { name: /Remove Page filter: Chennai Homes/ }));
    await waitFor(() => expect(statBodies.at(-1)).not.toHaveProperty("pageRecordId"));
  });

  it("applies a date range and Today's Leads, which are mutually exclusive", async () => {
    render(<DashboardPageClient />);
    await screen.findByTestId("month-leads");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    const dialog = await screen.findByRole("dialog", { name: "Date range filter" });
    const [from, to] = Array.from(dialog.querySelectorAll("input[type=date]")) as HTMLInputElement[];
    fireEvent.change(from, { target: { value: "2026-09-01" } });
    fireEvent.change(to, { target: { value: "2026-09-10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(statBodies.at(-1)).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-10", quickFilter: "all" }));
    fireEvent.click(screen.getByRole("button", { name: /Today's Leads/ }));
    await waitFor(() => expect(statBodies.at(-1)).toMatchObject({ quickFilter: "today" }));
    expect(statBodies.at(-1)).not.toHaveProperty("dateFrom");
  });

  it("updates in place when the server reports a new lead, without a reload", async () => {
    render(<DashboardPageClient />);
    expect(await screen.findByTestId("month-leads")).toHaveTextContent("3");
    act(() => FakeEventSource.instances[0].emit("ready", { tenantId: "tenant-a" }));
    expect(screen.getByText("Live")).toBeInTheDocument();
    nextStats = () => json(stats({ monthToDate: 4, total: 6 }));
    act(() => FakeEventSource.instances[0].emit("change"));
    await waitFor(() => expect(screen.getByTestId("month-leads")).toHaveTextContent("4"), { timeout: 3000 });
  });

  it("shows an empty state instead of blank charts when nothing matches, but keeps the month card", async () => {
    nextStats = () => json(stats({ total: 0, monthToDate: 0, previousMonthSamePeriod: 0 }));
    render(<DashboardPageClient />);
    expect(await screen.findByText("No leads match these filters")).toBeInTheDocument();
    expect(screen.getByTestId("month-leads")).toHaveTextContent("0");
    expect(screen.queryByTestId("timeline")).not.toBeInTheDocument();
  });

  it("offers Retry when the aggregate cannot be loaded", async () => {
    nextStats = () => json({ error: { message: "The dashboard could not be loaded." } }, 500);
    render(<DashboardPageClient />);
    expect(await screen.findByText("The dashboard could not be loaded.")).toBeInTheDocument();
    nextStats = () => json(stats());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("month-leads")).toHaveTextContent("3");
  });

  it("keeps the Facebook reconnect warning that the old dashboard had", async () => {
    mocks.connection.mockResolvedValue({ connectionStatus: "reauthorization_required" });
    render(<DashboardPageClient />);
    expect(await screen.findByText(/Facebook connection requires attention/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect Facebook" })).toHaveAttribute("href", "/connection");
  });
});
