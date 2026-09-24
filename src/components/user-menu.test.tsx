import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProfileDetails = vi.fn();
const getTenantMembers = vi.fn();
const sendInvitations = vi.fn();
const cancelInvitation = vi.fn();
const removeTenantMember = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const push = vi.fn();

vi.mock("@/services/profile-api-client", () => ({ getProfileDetails }));
vi.mock("@/services/members-api-client", () => ({
  getTenantMembers,
  sendInvitations,
  cancelInvitation,
  removeTenantMember,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push }),
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

  it("keeps the existing menu order and makes Settings and Profile interactive", () => {
    renderMenu();
    const menu = screen.getByLabelText("Account menu");

    expect(menu).toHaveTextContent("SettingsProfileSwitch companyDarkUpgrade planLogout");
    expect(within(menu).getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Profile" })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Settings" })).toBeEnabled();
    expect(within(menu).queryByRole("button", { name: "Upgrade plan" })).not.toBeInTheDocument();
  });

  it("opens the company switcher from Switch company", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Switch company" }));
    expect(push).toHaveBeenCalledWith("/workspaces");
    expect(screen.queryByLabelText("Account menu")).not.toBeInTheDocument();
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

const OVERVIEW = {
  currentUserId: "user-owner",
  canInvite: true,
  members: [
    { userId: "user-owner", fullName: "Nithish Kumar", email: "nithish@example.com", role: "owner", status: "active", joinedAt: "2026-09-01T00:00:00Z" },
  ],
  invitations: [] as unknown[],
};

const EMPLOYEE = {
  userId: "22222222-2222-4222-8222-222222222222",
  fullName: "Ravi Kumar",
  email: "ravi@example.com",
  role: "employee",
  status: "active",
  joinedAt: "2026-09-02T00:00:00Z",
};

describe("UserMenu settings dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProfileDetails.mockResolvedValue(PROFILE);
    getTenantMembers.mockResolvedValue(OVERVIEW);
  });

  function openSettings() {
    const trigger = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    return { trigger, dialog: screen.getByRole("dialog", { name: "Settings" }) };
  }

  it("opens with the Members section selected in the sidebar", async () => {
    const { dialog } = openSettings();

    const sidebar = within(dialog).getByRole("navigation", { name: "Settings sections" });
    expect(within(sidebar).getByRole("button", { name: "Members" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(within(dialog).getByText("Manage team members and invitations")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Invite Members" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Pro plan/)).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());
  });

  it("offers only the invitable tenant membership roles and only one invite row", () => {
    const { dialog } = openSettings();

    const role = within(dialog).getByRole("combobox", { name: "Role" });
    expect(role).toHaveValue("employee");
    expect(within(role).getAllByRole("option").map((option) => option.textContent)).toEqual(["Employee"]);

    expect(within(dialog).getAllByPlaceholderText("jane@example.com")).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: "Add more" })).not.toBeInTheDocument();
  });

  it("shows the requested member columns in order and filters by text", async () => {
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    expect(within(dialog).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "S.No",
      "Name",
      "Email",
      "Role",
      "Remove",
    ]);
    expect(within(dialog).getByText("Owner", { selector: ".mvp-members__role" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Filter members" }), { target: { value: "nobody" } });
    expect(within(dialog).queryByText("nithish@example.com")).not.toBeInTheDocument();
    expect(within(dialog).getByText("No members match these filters.")).toBeInTheDocument();
  });

  it("switches to the Pending Invitations tab", () => {
    const { dialog } = openSettings();

    fireEvent.click(within(dialog).getByRole("tab", { name: "Pending Invitations" }));
    expect(within(dialog).getByRole("tab", { name: "Pending Invitations" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByText("No pending invitations")).toBeInTheDocument();
  });

  it("lists pending invitations with a serial number, their assigned role, and a remove action", async () => {
    getTenantMembers.mockResolvedValue({
      ...OVERVIEW,
      invitations: [
        { invitationId: "inv-1", email: "ravi@example.com", role: "admin", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
      ],
    });
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole("tab", { name: "Pending Invitations" }));
    expect(within(dialog).getByText("1", { selector: ".mvp-members__index" })).toBeInTheDocument();
    expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("Admin", { selector: ".mvp-members__role" })).toBeInTheDocument();
    expect(within(dialog).getByText("Pending")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove invitation for ravi@example.com" })).toBeInTheDocument();
  });

  it("removes a pending invitation and refreshes the list", async () => {
    getTenantMembers.mockResolvedValueOnce({
      ...OVERVIEW,
      invitations: [
        { invitationId: "inv-1", email: "ravi@example.com", role: "admin", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
      ],
    });
    getTenantMembers.mockResolvedValueOnce({ ...OVERVIEW, invitations: [] });
    cancelInvitation.mockResolvedValue(undefined);

    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("tab", { name: "Pending Invitations" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove invitation for ravi@example.com" }));

    expect(cancelInvitation).toHaveBeenCalledWith("inv-1");
    await waitFor(() => expect(within(dialog).getByText("No pending invitations")).toBeInTheDocument());
    expect(getTenantMembers).toHaveBeenCalledTimes(2);
  });

  it("only owners see the remove action on pending invitations", async () => {
    getTenantMembers.mockResolvedValue({
      ...OVERVIEW,
      canInvite: false,
      currentUserId: "user-employee",
      members: [
        {
          userId: "user-employee",
          fullName: "Nithish Kumar",
          email: "nithish@example.com",
          role: "employee",
          status: "active",
          joinedAt: "2026-09-01T00:00:00Z",
        },
      ],
      invitations: [
        { invitationId: "inv-1", email: "ravi@example.com", role: "admin", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
      ],
    });
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("Only the Owner can invite members")).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("tab", { name: "Pending Invitations" }));

    expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove invitation/ })).not.toBeInTheDocument();
  });

  it("sends the typed email with the chosen role and confirms it in a popup", async () => {
    sendInvitations.mockResolvedValue([{ email: "ravi@example.com", status: "sent", message: "Invitation sent." }]);
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send" })).toBeEnabled());

    fireEvent.change(within(dialog).getByPlaceholderText("jane@example.com"), { target: { value: "ravi@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    const popup = await within(dialog).findByRole("alertdialog", { name: "Invitation sent successfully" });
    expect(within(popup).getByText("ravi@example.com")).toBeInTheDocument();
    expect(within(popup).getByRole("button", { name: "OK" })).toHaveFocus();
    expect(sendInvitations).toHaveBeenCalledWith([{ email: "ravi@example.com", role: "employee" }]);
    expect(within(dialog).getByPlaceholderText("jane@example.com")).toHaveValue("");
    expect(getTenantMembers).toHaveBeenCalledTimes(2);

    fireEvent.click(within(popup).getByRole("button", { name: "OK" }));
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("never claims an email was sent for an existing account", async () => {
    sendInvitations.mockResolvedValue([
      { email: "ravi@example.com", status: "saved_existing_account", message: "This person already has an account." },
    ]);
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send" })).toBeEnabled());

    fireEvent.change(within(dialog).getByPlaceholderText("jane@example.com"), { target: { value: "ravi@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    const popup = await within(dialog).findByRole("alertdialog", { name: "Invitation saved" });
    expect(popup).toHaveTextContent("already has an account, so no email was sent");
    expect(within(dialog).queryByText("Invitation sent successfully")).not.toBeInTheDocument();
  });

  it("shows non-sent outcomes inline instead of the success popup", async () => {
    sendInvitations.mockResolvedValue([{ email: "ravi@example.com", status: "already_member", message: "Already a member." }]);
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send" })).toBeEnabled());

    fireEvent.change(within(dialog).getByPlaceholderText("jane@example.com"), { target: { value: "ravi@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(within(dialog).getByText("Already a member.")).toBeInTheDocument());
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("disables Send and hides member removal for employees", async () => {
    getTenantMembers.mockResolvedValue({
      ...OVERVIEW,
      canInvite: false,
      currentUserId: "user-employee",
      members: [
        {
          userId: "user-employee",
          fullName: "Nithish Kumar",
          email: "nithish@example.com",
          role: "employee",
          status: "active",
          joinedAt: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const { dialog } = openSettings();

    await waitFor(() => expect(within(dialog).getByText("Only the Owner can invite members")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("shows Remove for an employee but not for the owner, with no three-dots actions", async () => {
    getTenantMembers.mockResolvedValue({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] });
    const { dialog } = openSettings();

    await waitFor(() => expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument());
    expect(within(dialog).getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /Actions for|Bulk actions/ })).not.toBeInTheDocument();
  });

  it("does nothing when the owner cancels member removal", async () => {
    getTenantMembers.mockResolvedValue({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { dialog } = openSettings();

    const removeButton = await within(dialog).findByRole("button", { name: "Remove" });
    fireEvent.click(removeButton);

    expect(confirm).toHaveBeenCalledWith(
      "Are you sure you want to remove this member? They will need to be invited again to rejoin.",
    );
    expect(removeTenantMember).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("removes the employee after owner confirmation and refreshes the list", async () => {
    getTenantMembers
      .mockResolvedValueOnce({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] })
      .mockResolvedValueOnce(OVERVIEW);
    removeTenantMember.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { dialog } = openSettings();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove" }));

    expect(removeTenantMember).toHaveBeenCalledWith(EMPLOYEE.userId);
    await waitFor(() => expect(within(dialog).queryByText("ravi@example.com")).not.toBeInTheDocument());
    expect(getTenantMembers).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("closes with Escape and restores focus to the menu trigger", async () => {
    const { trigger, dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
