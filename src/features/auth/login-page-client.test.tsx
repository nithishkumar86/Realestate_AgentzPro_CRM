import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoginPageClient } from "./login-page-client";
import { INACTIVITY_STORAGE_KEY } from "./inactivity";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/auth/turnstile-widget", () => ({ TurnstileWidget: () => null }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each([true, false])("only resets inactivity when OTP verification succeeds: %s", async (verified) => {
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.setItem(INACTIVITY_STORAGE_KEY, "old inactivity metadata");
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ message: "Code sent" }) })
    .mockResolvedValueOnce({ ok: verified, json: async () => ({ verified, redirectTo: "/leads" }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<LoginPageClient turnstileSiteKey={null} />);
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "agent@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
  fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
  if (verified) {
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/leads"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(INACTIVITY_STORAGE_KEY)!).signedOut).toBe(false);
  } else {
    await screen.findByText("The code is incorrect or has expired.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(INACTIVITY_STORAGE_KEY)).toBe("old inactivity metadata");
  }
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/otp/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "agent@example.com", otp: "123456" }),
  });
});
