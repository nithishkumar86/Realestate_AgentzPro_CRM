import { render, screen, within } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusRankChart, TimelineChart, timelineSummary } from "@/features/dashboard/dashboard-charts";
import { LEAD_STATUSES, STATUS_HIGHLIGHTS } from "@/features/leads/lead-options";

// jsdom has no layout, so ResponsiveContainer would measure 0x0 and draw nothing; give it a real size.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 300 }) };
});

const BY_STATUS = [
  { status: "New Lead", count: 1 }, { status: "Not reachable", count: 0 }, { status: "Working", count: 0 },
  { status: "Sale", count: 3 }, { status: "Details send via WhatsApp", count: 0 },
];

describe("StatusRankChart", () => {
  it("lists every status, biggest first, with 0-lead statuses at the bottom in their usual order", () => {
    render(<StatusRankChart data={BY_STATUS} ariaLabel="Leads by status" />);
    const list = screen.getByRole("list", { name: /Leads by status/ });
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      "Sale3 · 75%", "New Lead1 · 25%", "Not reachable0 · 0%", "Working0 · 0%", "Details send via WhatsApp0 · 0%",
    ]);
    // The accessible name carries every number, so the chart is never colour- or length-only.
    expect(list).toHaveAccessibleName(
      "Leads by status: Sale 3 (75%), New Lead 1 (25%), Not reachable 0 (0%), Working 0 (0%), Details send via WhatsApp 0 (0%).",
    );
    expect(screen.queryByText(/other status/)).not.toBeInTheDocument();
  });

  it("sizes each bar against the biggest status and keeps a status's colour whatever its rank", () => {
    const { container } = render(<StatusRankChart data={BY_STATUS} ariaLabel="Leads by status" />);
    const bars = [...container.querySelectorAll<HTMLElement>(".dash-rank__bar")];
    // 0-lead statuses get an empty track and no bar (the bar's min-width would otherwise show a stub).
    expect(bars.map((bar) => bar.style.width)).toEqual(["100%", "33.33333333333333%"]);
    expect(container.querySelectorAll(".dash-rank__track")).toHaveLength(5);
    // Each bar takes its status's /leads colour (Sale pink, New Lead maroon), whatever its rank.
    expect(bars.map((bar) => bar.getAttribute("data-tone"))).toEqual(["pink", "maroon"]);
    // No inline colour: the tone's CSS paints the bar, as on /leads.
    expect(bars.map((bar) => bar.style.background)).toEqual(["", ""]);
  });

  it("colours every status's bar with the same tone the /leads Status box uses (STATUS_HIGHLIGHTS)", () => {
    const { container } = render(<StatusRankChart data={LEAD_STATUSES.map((status) => ({ status, count: 1 }))} ariaLabel="Leads by status" />);
    const tones = [...container.querySelectorAll<HTMLElement>(".dash-rank__row")].map((row) => [
      row.querySelector(".dash-rank__name")?.textContent, row.querySelector(".dash-rank__bar")?.getAttribute("data-tone"),
    ]);
    expect(tones).toEqual(LEAD_STATUSES.map((status) => [status, STATUS_HIGHLIGHTS[status]]));
  });

  it("gives a status outside LEAD_STATUSES no tone, so its bar stays grey", () => {
    const { container } = render(<StatusRankChart data={[{ status: "Some old status", count: 2 }]} ariaLabel="Leads by status" />);
    const bar = container.querySelector<HTMLElement>(".dash-rank__bar");
    expect(bar).not.toBeNull();
    expect(bar).not.toHaveAttribute("data-tone");
  });

  it("still shows every status (all empty bars) when no leads are in view", () => {
    const { container } = render(<StatusRankChart data={[{ status: "Sale", count: 0 }, { status: "Working", count: 0 }]} ariaLabel="Leads by status" />);
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Sale0 · 0%", "Working0 · 0%"]);
    expect(container.querySelectorAll(".dash-rank__bar")).toHaveLength(0);
    expect(container.querySelectorAll(".dash-rank__track")).toHaveLength(2);
  });
});

describe("TimelineChart", () => {
  const MONTHS = [
    { bucket: "2026-06-01T00:00:00", count: 4 }, { bucket: "2026-07-01T00:00:00", count: 0 }, { bucket: "2026-08-01T00:00:00", count: 2 },
  ];

  it("draws monthly buckets as columns, one per month, with an empty month kept as a gap", () => {
    const { container } = render(<TimelineChart data={MONTHS} granularity="month" />);
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(2); // Jul (0 leads) draws no bar: a visible gap
    expect(container.querySelector(".recharts-area")).toBeNull();
    expect(screen.getByRole("img")).toHaveAccessibleName("Leads over time: 6 leads across 3 months.");
  });

  it("draws a single month as one bar, not a lone dot", () => {
    const { container } = render(<TimelineChart data={[{ bucket: "2026-09-01T00:00:00", count: 16 }]} granularity="month" />);
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(1);
    expect(screen.getByRole("img")).toHaveAccessibleName("Leads over time: 16 leads across 1 month.");
  });

  it.each(["day", "hour"] as const)("keeps the area chart for %s buckets", (granularity) => {
    const data = [{ bucket: "2026-09-28T00:00:00", count: 1 }, { bucket: "2026-09-29T00:00:00", count: 3 }];
    const { container } = render(<TimelineChart data={data} granularity={granularity} />);
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(container.querySelector(".recharts-bar-rectangle")).toBeNull();
  });

  it("words the summary in the singular when there is one lead or one bucket", () => {
    expect(timelineSummary(1, 1, "day")).toBe("Leads over time: 1 lead across 1 day.");
    expect(timelineSummary(0, 24, "hour")).toBe("Leads over time: 0 leads across 24 hours.");
  });
});
