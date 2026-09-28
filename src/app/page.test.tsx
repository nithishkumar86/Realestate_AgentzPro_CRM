import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";
import HomePage from "./page";

const mocks = vi.hoisted(() => ({ requireCrmAccess: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.requireCrmAccess }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/brand-logo", () => ({ BrandLogo: () => <span>AgentzPro</span> }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireCrmAccess.mockResolvedValue({});
  mocks.redirect.mockImplementation((destination: string) => { throw new Error(`redirect:${destination}`); });
});
afterEach(cleanup);

it("sends signed-in users with CRM access straight to the leads page", async () => {
  await expect(HomePage()).rejects.toThrow("redirect:/leads");
  expect(mocks.requireCrmAccess).toHaveBeenCalledOnce();
});

it("shows the public landing page with a Login button to signed-out visitors", async () => {
  mocks.requireCrmAccess.mockRejectedValue(new AppError("Signed out", { status: 401, code: "UNAUTHENTICATED" }));
  render(await HomePage());
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Your next opportunity\s*starts here\./);
  expect(screen.getAllByRole("link")).toHaveLength(4);
  expect(screen.getByRole("link", { name: "Login" })).toHaveAttribute("href", "/login");
  expect(screen.getByRole("link", { name: "Enter CRM Leads" })).toHaveAttribute("href", "/leads");
  expect(screen.getByRole("link", { name: "Contact Us" })).toHaveAttribute("href", "/contact");
  expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    "/privacy-policy"
  );
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it.each([
  ["WORKSPACE_SELECTION_REQUIRED", "/workspaces"],
  ["ONBOARDING_REQUIRED", "/onboarding"],
  ["CRM_ACCESS_DENIED", "/billing"],
  ["ACCOUNT_INTEGRITY_ERROR", "/billing"],
])("preserves the %s access boundary", async (code, destination) => {
  mocks.requireCrmAccess.mockRejectedValue(new AppError("Denied", { status: 403, code }));
  await expect(HomePage()).rejects.toThrow(`redirect:${destination}`);
});

it("propagates unexpected access failures", async () => {
  const failure = new Error("Access unavailable");
  mocks.requireCrmAccess.mockRejectedValue(failure);
  await expect(HomePage()).rejects.toBe(failure);
  expect(mocks.redirect).not.toHaveBeenCalled();
});
