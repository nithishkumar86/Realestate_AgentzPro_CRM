import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProfileDetails = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/services/profile-api-client", () => ({ getProfileDetails }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const { UserMenu } = await import("@/components/user-menu");

const PROFILE = {
  fullName: "Nithish Kumar",
  phoneNumber: "919876543210",
  emailAddress: "nithish@example.com",
  companyName: "AgentzPro Realty",
  professionalRole: "Real Estate Agent",
};

function renderMenu() {
  render(<UserMenu fullName="Nithish Kumar" tenantName="AgentzPro Realty" />);
  const trigger = screen.getByRole("button", { name: /Nithish Kumar/i });
  fireEvent.click(trigger);
  return trigger;
}

describe("UserMenu profile dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProfileDetails.mockResolvedValue(PROFILE);
  });

  it("keeps the existing menu order and makes only Profile interactive", () => {
    renderMenu();
    const menu = screen.getByLabelText("Account menu");

    expect(menu).toHaveTextContent("SettingsProfileDarkUpgrade planLogout");
    expect(within(menu).getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Profile" })).toBeEnabled();
    expect(within(menu).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: "Upgrade plan" })).not.toBeInTheDocument();
  });

  it("loads and displays exactly the five approved profile fields", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    const dialog = screen.getByRole("dialog", { name: "Profile details" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading your profile");

    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());
    for (const label of ["Name", "Phone", "Email", "Company", "Professional Role"]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("919876543210")).toBeInTheDocument();
    expect(within(dialog).getAllByText("AgentzPro Realty")).toHaveLength(1);
    expect(getProfileDetails).toHaveBeenCalledTimes(1);
  });

  it("shows a retry action after a load failure", async () => {
    getProfileDetails.mockRejectedValueOnce(new Error("Profile temporarily unavailable."));
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Profile temporarily unavailable."));
    getProfileDetails.mockResolvedValueOnce(PROFILE);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("nithish@example.com")).toBeInTheDocument());
    expect(getProfileDetails).toHaveBeenCalledTimes(2);
  });

  it("closes with Escape and restores focus to the existing menu trigger", async () => {
    const trigger = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    await waitFor(() => expect(screen.getByText("nithish@example.com")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
