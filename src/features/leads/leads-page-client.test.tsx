import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toReadableLabel } from "@/lib/date-utils";
import { displayValue } from "@/components/ui";
import { LeadsPageClient } from "@/features/leads/leads-page-client";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("lead display helpers", () => {
  it("shows missing values as an em dash", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue("")).toBe("—");
    expect(displayValue("Kumar")).toBe("Kumar");
  });

  it("renders readable dynamic lead fields without raw JSON", () => {
    render(
      <dl>
        <dt>{toReadableLabel("preferred_location")}</dt>
        <dd>Anna Nagar</dd>
      </dl>,
    );

    expect(screen.getByText("Preferred Location")).toBeInTheDocument();
    expect(screen.queryByText(/{"preferred_location"/)).not.toBeInTheDocument();
  });
});

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const FILTER_OPTIONS = {
  pages: [{ id: PAGE_ID, name: "Chennai Homes" }],
  // Two ads on the same Page, the case the Ad filter exists for.
  ads: [{ id: "6301-karuvi", name: "karuvi" }, { id: "6302-aruvi", name: "aruvi" }],
  defaultAdId: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Stands in for the three lead endpoints and records the body of every request, so a test can
 * assert exactly which filters the Download button sent.
 *
 * The export stub rejects a body carrying `page`/`pageSize` the way the real route does — its
 * schema is strict and holds no pagination fields, because an export returns every matching row.
 * Sending one there is what used to 400 every download, so the stub reproduces that contract
 * rather than accepting anything: put a pagination field back and these tests fail.
 */
function stubLeadApi() {
  const sent = { query: [] as Array<Record<string, unknown>>, export: [] as Array<Record<string, unknown>> };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/leads/filters")) return jsonResponse(FILTER_OPTIONS);
    if (url === "/api/leads/query") {
      sent.query.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ items: [], total: 0, timezone: "Asia/Kolkata" });
    }
    if (url === "/api/leads/export") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ("pageSize" in body || "page" in body) return jsonResponse({ error: { message: "Request data is invalid." } }, 400);
      sent.export.push(body);
      return new Response("Lead Name,Email,Phone\r\nKumar,kumar@example.com,9999999999", { status: 200, headers: { "content-type": "text/csv" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return sent;
}

const downloadedFiles: string[] = [];

async function chooseFilter(field: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: field }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

function clickDownload() {
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
}

/** Renders the page and waits for its first lead load, so later assertions read settled state. */
async function renderLeadsPage(sent: ReturnType<typeof stubLeadApi>) {
  render(<LeadsPageClient />);
  await waitFor(() => expect(sent.query).toHaveLength(1));
  await screen.findByRole("button", { name: "Ad" });
}

describe("downloading leads as CSV", () => {
  beforeEach(() => {
    downloadedFiles.length = 0;
    URL.createObjectURL = vi.fn(() => "blob:leads");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mockClick(this: HTMLAnchorElement) {
      downloadedFiles.push(this.download);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads every lead when no filter is applied", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    // Filters only: no pagination field, and nothing that would narrow the export.
    expect(sent.export[0]).toEqual({ quickFilter: "all" });
    expect(downloadedFiles).toEqual(["agentzpro-leads.csv"]);
    expect(screen.queryByText("Leads could not be exported.")).not.toBeInTheDocument();
  });

  it("downloads only the selected ad's leads when one ad is filtered", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Ad", /karuvi/);
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ adId: "6301-karuvi" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "all", adId: "6301-karuvi" });
    expect(sent.export[0]).not.toHaveProperty("adId", "6302-aruvi");
    expect(downloadedFiles).toEqual(["agentzpro-leads.csv"]);
  });

  it("downloads today's leads only while the quick range is on", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    fireEvent.click(screen.getByRole("button", { name: "Today's Leads" }));
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ quickFilter: "today" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "today" });
  });

  it("downloads the exact intersection when Page, Ad, Status and a date range are combined", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Page", "Chennai Homes");
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ pageRecordId: PAGE_ID }));
    await chooseFilter("Ad", /karuvi/);
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ adId: "6301-karuvi" }));
    await chooseFilter("Status", "New Lead");

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-10" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({
      quickFilter: "all",
      status: "New Lead",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-10",
      pageRecordId: PAGE_ID,
      adId: "6301-karuvi",
    });
    expect(downloadedFiles).toEqual(["agentzpro-leads.csv"]);
    expect(screen.queryByText("Leads could not be exported.")).not.toBeInTheDocument();
  });

  it("carries a Label and a search term into the export as well", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Label", "Hot");
    fireEvent.change(screen.getByPlaceholderText(/Search leads/), { target: { value: " Kumar " } });
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ label: "Hot", search: "Kumar" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "all", label: "Hot", search: "Kumar" });
  });

  it("exports exactly the filters behind the rows on screen", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Ad", /^aruvi/);
    await chooseFilter("Status", "Working");
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ adId: "6302-aruvi", status: "Working" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    // The table request is the same filters plus its page size; the CSV must never diverge from it.
    const { pageSize, ...tableFilters } = sent.query.at(-1) as Record<string, unknown>;
    expect(pageSize).toBe(100);
    expect(sent.export[0]).toEqual(tableFilters);
  });

  it("downloads with every filter applied at once: search, Page, Ad, Status, Label and a date range", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    fireEvent.change(screen.getByPlaceholderText(/Search leads/), { target: { value: "Kumar" } });
    await chooseFilter("Page", "Chennai Homes");
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ pageRecordId: PAGE_ID }));
    await chooseFilter("Ad", /karuvi/);
    await chooseFilter("Status", "New Lead");
    await chooseFilter("Label", "Hot");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const everyFilter = {
      quickFilter: "all",
      search: "Kumar",
      pageRecordId: PAGE_ID,
      adId: "6301-karuvi",
      status: "New Lead",
      label: "Hot",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-10",
    };
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject(everyFilter));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual(everyFilter);
    expect(downloadedFiles).toEqual(["agentzpro-leads.csv"]);
    expect(screen.queryByText("Leads could not be exported.")).not.toBeInTheDocument();
  });

  /**
   * The quick range wins over From/To inside the query service, so the UI must never leave both on:
   * a date chip that filters nothing would misdescribe both the table and the downloaded CSV.
   */
  it("drops a From/To range when Today's Leads is switched on, and exports only today", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-10" }));

    fireEvent.click(screen.getByRole("button", { name: "Today's Leads" }));
    await waitFor(() => expect(sent.query.at(-1)).toEqual({ quickFilter: "today", pageSize: 100 }));
    expect(screen.queryByLabelText(/Remove From filter/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove To filter/)).not.toBeInTheDocument();

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "today" });
  });

  it("switches Today's Leads off when a From/To range is applied, and exports that range", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    fireEvent.click(screen.getByRole("button", { name: "Today's Leads" }));
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ quickFilter: "today" }));

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sent.query.at(-1)).toEqual({ quickFilter: "all", dateFrom: "2026-09-01", dateTo: "2026-09-10", pageSize: 100 }));
    expect(screen.queryByLabelText(/Remove Range filter/)).not.toBeInTheDocument();

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    // The range the user asked for survives, instead of being silently replaced by today.
    expect(sent.export[0]).toEqual({ quickFilter: "all", dateFrom: "2026-09-01", dateTo: "2026-09-10" });
  });

  it("keeps every other filter intact when the date filters swap", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Ad", /karuvi/);
    await chooseFilter("Status", "New Lead");
    fireEvent.click(screen.getByRole("button", { name: "Today's Leads" }));
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ quickFilter: "today", adId: "6301-karuvi", status: "New Lead" }));

    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "all", adId: "6301-karuvi", status: "New Lead", dateFrom: "2026-09-01", dateTo: "2026-09-10" });
  });

  it("keeps the export unfiltered again after Clear all", async () => {
    const sent = stubLeadApi();
    await renderLeadsPage(sent);

    await chooseFilter("Ad", /karuvi/);
    await waitFor(() => expect(sent.query.at(-1)).toMatchObject({ adId: "6301-karuvi" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(sent.query.at(-1)).toEqual({ quickFilter: "all", pageSize: 100 }));

    clickDownload();

    await waitFor(() => expect(sent.export).toHaveLength(1));
    expect(sent.export[0]).toEqual({ quickFilter: "all" });
  });
});
