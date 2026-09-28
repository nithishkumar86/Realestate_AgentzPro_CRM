import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PricingPage from "./page";

const mocks = vi.hoisted(() => ({ listActivePlans: vi.fn() }));
vi.mock("@/lib/server/billing-service", () => ({ listActivePlans: mocks.listActivePlans }));
vi.mock("@/components/brand-logo", () => ({ BrandLogo: () => <span>AgentzPro</span> }));

const PLANS = [
  { planCode: "pro_monthly", planName: "Pro Monthly", billingPeriod: "monthly", pricePerSeatPaise: 49_900 },
  { planCode: "pro_yearly", planName: "Pro Yearly", billingPeriod: "yearly", pricePerSeatPaise: 499_000 },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listActivePlans.mockResolvedValue(PLANS);
});
afterEach(cleanup);

it("shows the free trial and Pro plans, both starting at login", async () => {
  render(await PricingPage());
  expect(screen.getByRole("heading", { level: 2, name: "Free Trial" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "Pro" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Start 14-day free trial" })).toHaveAttribute("href", "/login");
  expect(screen.getByRole("link", { name: "Get Pro" })).toHaveAttribute("href", "/login");
  expect(screen.getByRole("link", { name: "Login" })).toHaveAttribute("href", "/login");
});

it("shows the monthly price and switches to the yearly price per month", async () => {
  render(await PricingPage());
  expect(screen.getByText("₹499")).toBeInTheDocument();
  expect(screen.getByText("Save 16%")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("radio", { name: /Yearly/ }));
  expect(screen.getByText("₹416")).toBeInTheDocument();
  expect(screen.getByText("₹4,990 per seat, billed yearly")).toBeInTheDocument();
});

it("still renders both plans when prices cannot be loaded", async () => {
  mocks.listActivePlans.mockRejectedValue(new Error("db down"));
  render(await PricingPage());
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(screen.getByText("See current prices after you log in")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Get Pro" })).toHaveAttribute("href", "/login");
});
