import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProfileDetails = vi.fn();
const updateProfileDetails = vi.fn();
const getTenantMembers = vi.fn();
const sendInvitations = vi.fn();
const cancelInvitation = vi.fn();
const setMemberAccess = vi.fn();
const getBillingOverview = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const push = vi.fn();

vi.mock("@/services/profile-api-client", () => ({ getProfileDetails, updateProfileDetails }));
vi.mock("@/services/members-api-client", () => ({
  getTenantMembers,
  sendInvitations,
  cancelInvitation,
  setMemberAccess,
}));
// Keeps BillingOwnerOnlyError, getInvoices etc. real; only getBillingOverview is stubbed so
// BillingSection can be driven without hitting the network.
vi.mock("@/services/billing-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing-api-client")>()),
  getBillingOverview,
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

// Profile is reached only through Settings › Your account › Profile.
function openProfile() {
  const trigger = renderMenu();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const sidebar = within(dialog).getByRole("navigation", { name: "Settings sections" });
  fireEvent.click(within(sidebar).getByRole("button", { name: "Profile" }));
  return { trigger, dialog, sidebar };
}

describe("UserMenu profile dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProfileDetails.mockResolvedValue(PROFILE);
    getTenantMembers.mockResolvedValue(OVERVIEW);
  });

  it("keeps the menu order without a separate Profile item (Profile lives in Settings)", () => {
    renderMenu();
    const menu = screen.getByLabelText("Account menu");

    expect(menu).toHaveTextContent("SettingsDarkUpgrade planLogout");
    expect(within(menu).getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeEnabled();
    expect(within(menu).queryByRole("button", { name: "Profile" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Settings" })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Upgrade plan" })).toBeEnabled();
  });

  it("no longer lists Switch company (it lives at the top of the sidebar)", () => {
    renderMenu();
    expect(screen.queryByRole("button", { name: "Switch company" })).not.toBeInTheDocument();
  });

  it("shows Profile under Your account, grouped apart from the company sections", () => {
    const { dialog, sidebar } = openProfile();

    expect(sidebar).toHaveTextContent("Your accountProfileCompanyMembersLead assignmentBillingInvoices");
    expect(within(sidebar).getByRole("button", { name: "Profile" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Profile details" })).not.toBeInTheDocument();
  });

  it("offers edit only for name, phone and professional role, never company or email", async () => {
    const { dialog } = openProfile();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    expect(within(dialog).getByRole("button", { name: "Edit name" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Edit phone" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Edit professional role" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: /^Edit / })).toHaveLength(3);
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("saves an edited professional role inline", async () => {
    updateProfileDetails.mockResolvedValue({ ...PROFILE, professionalRole: "Sales Manager" });
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit professional role" }));

    const input = within(dialog).getByRole("textbox", { name: "Professional Role" });
    expect(input).toHaveValue(PROFILE.professionalRole);
    fireEvent.change(input, { target: { value: "Sales Manager" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save professional role" }));

    await waitFor(() => expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument());
    expect(updateProfileDetails).toHaveBeenCalledWith({ professionalRole: "Sales Manager" });
    expect(within(dialog).getAllByText("Sales Manager").length).toBeGreaterThan(0);
  });

  it("saves an edited name inline and refreshes the shell so the sidebar name updates", async () => {
    updateProfileDetails.mockResolvedValue({ ...PROFILE, fullName: "Nithish Kumar M" });
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit name" }));

    const input = within(dialog).getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("Nithish Kumar");
    fireEvent.change(input, { target: { value: "Nithish Kumar M" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument());
    expect(updateProfileDetails).toHaveBeenCalledWith({ fullName: "Nithish Kumar M" });
    expect(within(dialog).getAllByText("Nithish Kumar M").length).toBeGreaterThan(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("edits the phone as the 10-digit mobile number beside a fixed +91", async () => {
    updateProfileDetails.mockResolvedValue({ ...PROFILE, phoneNumber: "919123456780" });
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit phone" }));

    const input = within(dialog).getByRole("textbox", { name: "Phone" });
    expect(input).toHaveValue("9876543210");
    fireEvent.change(input, { target: { value: "+91 91234 56780" } });
    expect(input).toHaveValue("9123456780");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(within(dialog).getByText("919123456780")).toBeInTheDocument());
    expect(updateProfileDetails).toHaveBeenCalledWith({ phoneNumber: "9123456780" });
  });

  it("shows the validation message and does not save an invalid phone", async () => {
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit phone" }));

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Phone" }), { target: { value: "12345" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save phone" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Mobile number must be exactly 10 digits.");
    expect(updateProfileDetails).not.toHaveBeenCalled();
  });

  it("keeps the edit open with the server message when saving fails", async () => {
    updateProfileDetails.mockRejectedValue(new Error("Your profile could not be saved."));
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit name" }));

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Ravi Kumar" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Your profile could not be saved."));
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Ravi Kumar");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cancels an edit with Escape without closing Settings", async () => {
    const { dialog } = openProfile();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit name" }));

    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Name" }), { key: "Escape" });

    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(updateProfileDetails).not.toHaveBeenCalled();
  });

  it("loads and displays exactly the five approved profile fields", async () => {
    const { dialog } = openProfile();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading your profile");

    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());
    // Scope to the field list: "Company" is also a Settings sidebar group label.
    const fields = dialog.querySelector("dl.mvp-profile-fields") as HTMLElement;
    expect(within(fields).getAllByRole("term").map((term) => term.textContent)).toEqual(
      ["Name", "Phone", "Email", "Company", "Professional Role"],
    );
    expect(within(dialog).getByText("919876543210")).toBeInTheDocument();
    expect(within(dialog).getAllByText("AgentzPro Realty")).toHaveLength(1);
    expect(getProfileDetails).toHaveBeenCalledTimes(1);
  });

  it("shows a retry action after a load failure", async () => {
    getProfileDetails.mockRejectedValueOnce(new Error("Profile temporarily unavailable."));
    openProfile();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Profile temporarily unavailable."));
    getProfileDetails.mockResolvedValueOnce(PROFILE);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("nithish@example.com")).toBeInTheDocument());
    expect(getProfileDetails).toHaveBeenCalledTimes(2);
  });

  it("closes with Escape and restores focus to the existing menu trigger", async () => {
    const { trigger } = openProfile();
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

  // Settings opens on Profile, so Members tests switch to the Members section first.
  function openSettings() {
    const trigger = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const sidebar = within(dialog).getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Members" }));
    return { trigger, dialog };
  }

  it("opens on the Profile section by default", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    const sidebar = within(dialog).getByRole("navigation", { name: "Settings sections" });
    expect(within(sidebar).getByRole("button", { name: "Profile" })).toHaveAttribute("aria-current", "page");
    expect((await within(dialog).findAllByText("Real Estate Agent")).length).toBeGreaterThan(0);
  });

  it("opens Settings on the Billing section when Upgrade plan is clicked", () => {
    getBillingOverview.mockReturnValue(new Promise(() => {})); // stays loading; no overview fixture needed
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    const sidebar = within(dialog).getByRole("navigation", { name: "Settings sections" });
    expect(within(sidebar).getByRole("button", { name: "Billing" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("heading", { name: "Billing" })).toBeInTheDocument();
  });

  it("shows the Members section when selected in the sidebar", async () => {
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

    // Employee is the only invitable role, so it is fixed text, not a dropdown.
    expect(within(dialog).getByRole("note", { name: "Role" })).toHaveTextContent("Employee");
    expect(within(dialog).queryByRole("combobox", { name: "Role" })).not.toBeInTheDocument();

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
      "Access",
    ]);
    expect(within(dialog).getByText("Owner", { selector: ".mvp-members__role" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^(Block|Enable) / })).not.toBeInTheDocument();

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

  it("offers only Owner and Employee in the Members role filter (no Admin)", async () => {
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    const filter = within(dialog).getByRole("combobox", { name: "Filter by role" });
    expect(within(filter).getAllByRole("option").map((option) => option.textContent)).toEqual(
      ["All roles", "Owner", "Employee"],
    );
    // There is no 2FA feature, so there is no 2FA filter either.
    expect(within(dialog).queryByRole("combobox", { name: /2FA/ })).not.toBeInTheDocument();
  });

  it("lists pending invitations with a serial number, their assigned role, and a remove action", async () => {
    getTenantMembers.mockResolvedValue({
      ...OVERVIEW,
      invitations: [
        { invitationId: "inv-1", email: "ravi@example.com", role: "employee", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
      ],
    });
    const { dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole("tab", { name: "Pending Invitations" }));
    expect(within(dialog).getByText("1", { selector: ".mvp-members__index" })).toBeInTheDocument();
    expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("Employee", { selector: ".mvp-members__role" })).toBeInTheDocument();
    expect(within(dialog).getByText("Pending")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove invitation for ravi@example.com" })).toBeInTheDocument();
  });

  it("removes a pending invitation and refreshes the list", async () => {
    getTenantMembers.mockResolvedValueOnce({
      ...OVERVIEW,
      invitations: [
        { invitationId: "inv-1", email: "ravi@example.com", role: "employee", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
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
        { invitationId: "inv-1", email: "ravi@example.com", role: "employee", invitedAt: "2026-09-22T00:00:00Z", expiresAt: "2026-09-29T00:00:00Z" },
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

  it("disables Send and hides Block/Enable for employees", async () => {
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
    expect(within(dialog).queryByRole("button", { name: /^(Block|Enable) / })).not.toBeInTheDocument();
  });

  it("shows Block for an active employee but nothing for the owner, and no Remove button", async () => {
    getTenantMembers.mockResolvedValue({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] });
    const { dialog } = openSettings();

    await waitFor(() => expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument());
    expect(within(dialog).getAllByRole("button", { name: /^(Block|Enable) / })).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Block Ravi Kumar" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Blocked")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Actions for|Bulk actions/ })).not.toBeInTheDocument();
  });

  it("does nothing when the owner cancels blocking", async () => {
    getTenantMembers.mockResolvedValue({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { dialog } = openSettings();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Block Ravi Kumar" }));

    expect(confirm).toHaveBeenCalledWith(
      "Block this member? They will lose access to the CRM until you enable them again.",
    );
    expect(setMemberAccess).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("blocks the employee after owner confirmation and shows them as Blocked with Enable", async () => {
    const blocked = { ...EMPLOYEE, status: "blocked" };
    getTenantMembers
      .mockResolvedValueOnce({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] })
      .mockResolvedValueOnce({ ...OVERVIEW, members: [...OVERVIEW.members, blocked] });
    setMemberAccess.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { dialog } = openSettings();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Block Ravi Kumar" }));

    expect(setMemberAccess).toHaveBeenCalledWith(EMPLOYEE.userId, "blocked");
    expect(await within(dialog).findByRole("button", { name: "Enable Ravi Kumar" })).toBeInTheDocument();
    expect(within(dialog).getByText("Blocked")).toBeInTheDocument();
    expect(within(dialog).getByText("ravi@example.com")).toBeInTheDocument();
    expect(getTenantMembers).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("enables a blocked employee without a confirmation prompt", async () => {
    const blocked = { ...EMPLOYEE, status: "blocked" };
    getTenantMembers
      .mockResolvedValueOnce({ ...OVERVIEW, members: [...OVERVIEW.members, blocked] })
      .mockResolvedValueOnce({ ...OVERVIEW, members: [...OVERVIEW.members, EMPLOYEE] });
    setMemberAccess.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm");
    const { dialog } = openSettings();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Enable Ravi Kumar" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(setMemberAccess).toHaveBeenCalledWith(EMPLOYEE.userId, "active");
    expect(await within(dialog).findByRole("button", { name: "Block Ravi Kumar" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Blocked")).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it("shows the server's message when enabling fails for lack of a seat", async () => {
    getTenantMembers.mockResolvedValue({ ...OVERVIEW, members: [...OVERVIEW.members, { ...EMPLOYEE, status: "blocked" }] });
    setMemberAccess.mockRejectedValue(
      new Error("All paid seats are in use. Add a seat on the Billing page before enabling this member."),
    );
    const { dialog } = openSettings();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Enable Ravi Kumar" }));

    expect(
      await within(dialog).findByText("All paid seats are in use. Add a seat on the Billing page before enabling this member."),
    ).toBeInTheDocument();
  });

  it("closes with Escape and restores focus to the menu trigger", async () => {
    const { trigger, dialog } = openSettings();
    await waitFor(() => expect(within(dialog).getByText("nithish@example.com")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
