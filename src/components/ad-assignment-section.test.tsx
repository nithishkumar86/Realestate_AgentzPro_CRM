import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdAssignmentSection } from "@/components/ad-assignment-section";
import { AdAssignmentOwnerOnlyError } from "@/services/ad-assignments-api-client";

const api = vi.hoisted(() => ({ getAdAssignments: vi.fn(), setAdAssignee: vi.fn(), applyAdAssignee: vi.fn() }));
vi.mock("@/services/ad-assignments-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ad-assignments-api-client")>()),
  getAdAssignments: api.getAdAssignments,
  setAdAssignee: api.setAdAssignee,
  applyAdAssignee: api.applyAdAssignee,
}));

const PRIYA = "55555555-5555-4555-8555-555555555555";
const RAVI = "66666666-6666-4666-8666-666666666666";

const overview = () => ({
  ads: [
    { adId: "1200000000000001", adName: "Karuvi Launch", assigneeUserId: PRIYA, totalLeads: 12, unassignedLeads: 3 },
    { adId: "1200000000000002", adName: null, assigneeUserId: null, totalLeads: 4, unassignedLeads: 4 },
    { adId: "1200000000000003", adName: "Old Campaign", assigneeUserId: RAVI, totalLeads: 9, unassignedLeads: 0 },
  ],
  members: [{ userId: PRIYA, fullName: "Priya" }, { userId: RAVI, fullName: "Ravi" }],
  isOwner: true,
});

const rowOf = (ad: string) => screen.getByTitle(ad).closest("tr")!;
const bothButton = () => within(screen.getByRole("alertdialog")).getByRole("button", { name: /OK, assign to/ });

beforeEach(() => {
  vi.resetAllMocks();
  api.getAdAssignments.mockResolvedValue(overview());
});
afterEach(() => vi.restoreAllMocks());

describe("AdAssignmentSection", () => {
  it("lists every ad with its lead count, current assignee and how many leads are still unassigned", async () => {
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    expect(screen.getByRole("heading", { name: "Lead assignment" })).toBeInTheDocument();
    const first = rowOf("Karuvi Launch");
    expect(within(first).getByText("1")).toBeInTheDocument();
    expect(within(first).getByRole("combobox", { name: "Who receives the new leads of Karuvi Launch" })).toHaveValue(PRIYA);
    expect(within(first).getByRole("combobox", { name: "Assign the already arrived leads of Karuvi Launch" })).toHaveValue("");
    const second = rowOf("Name pending");
    expect(within(second).getByLabelText(/new leads of/)).toHaveValue("");
    expect(within(second).getByText("Still 4 leads unassigned. Choose a person to assign.")).toBeInTheDocument();
    expect(within(second).queryByLabelText(/already arrived leads/)).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "S.No" })).toBeInTheDocument();
    expect(within(second).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowOf("Old Campaign")).getByText("None")).toBeInTheDocument();
    expect(screen.queryByText(/ID …/)).not.toBeInTheDocument();
  });

  it("asks which leads to hand over when the ad has unassigned leads, and saves nothing yet", async () => {
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Name pending")).getByLabelText(/new leads of/), { target: { value: RAVI } });
    const dialog = await screen.findByRole("alertdialog", { name: "Assign this ad's leads to Ravi?" });
    expect(within(dialog).getByText("4 earlier leads of Name pending are still unassigned. If you click OK, those 4 leads and every upcoming lead from this ad will be assigned to Ravi.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "OK, assign to Ravi" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Only upcoming leads/ })).toBeInTheDocument();
    expect(within(dialog).getByText("Leads that already have an assignee are not changed.")).toBeInTheDocument();
    expect(api.setAdAssignee).not.toHaveBeenCalled();
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
  });

  it("saves the rule, then assigns the unassigned leads, when the owner chooses new and unassigned", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    api.applyAdAssignee.mockResolvedValue(4);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const select = within(rowOf("Name pending")).getByLabelText(/new leads of/);
    fireEvent.change(select, { target: { value: RAVI } });
    await screen.findByRole("alertdialog");
    fireEvent.click(bothButton());
    await waitFor(() => expect(api.applyAdAssignee).toHaveBeenCalledWith("1200000000000002"));
    expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000002", RAVI);
    expect(api.setAdAssignee.mock.invocationCallOrder[0]).toBeLessThan(api.applyAdAssignee.mock.invocationCallOrder[0]);
    expect(await within(rowOf("Name pending")).findByText("Done. 4 earlier unassigned leads and all upcoming leads from this ad are now assigned to Ravi.")).toBeInTheDocument();
    expect(select).toHaveValue(RAVI);
    expect(within(rowOf("Name pending")).getByText("None")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("saves only the rule when the owner chooses only new leads", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Name pending")).getByLabelText(/new leads of/), { target: { value: RAVI } });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /Only upcoming leads/ }));
    await waitFor(() => expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000002", RAVI));
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
    expect(await within(rowOf("Name pending")).findByText("Ravi will get all upcoming leads from this ad. The 4 earlier leads stay unassigned.")).toBeInTheDocument();
    expect(within(rowOf("Name pending")).getByLabelText(/already arrived leads/)).toBeInTheDocument();
  });

  it("does nothing and keeps the old person when the owner cancels or presses Escape", async () => {
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const select = within(rowOf("Karuvi Launch")).getByLabelText(/new leads of/);
    fireEvent.change(select, { target: { value: RAVI } });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(select).toHaveValue(PRIYA);
    fireEvent.change(select, { target: { value: RAVI } });
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(select).toHaveValue(PRIYA);
    expect(api.setAdAssignee).not.toHaveBeenCalled();
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
  });

  it("does not ask when the ad has no unassigned leads, it just saves the rule", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Old Campaign")).getByLabelText(/new leads of/), { target: { value: PRIYA } });
    await waitFor(() => expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000003", PRIYA));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
    expect(await within(rowOf("Old Campaign")).findByText("Priya will get all upcoming leads from this ad.")).toBeInTheDocument();
  });

  it("clears a rule without asking and without touching any lead", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Karuvi Launch")).getByLabelText(/new leads of/), { target: { value: "" } });
    await waitFor(() => expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000001", null));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
    expect(await within(rowOf("Karuvi Launch")).findByText(/New leads from this ad are left unassigned/)).toBeInTheDocument();
  });

  it("does not assign any lead and keeps the previous assignee when saving the rule fails", async () => {
    api.setAdAssignee.mockRejectedValue(new Error("Choose an active member of this company."));
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const select = within(rowOf("Karuvi Launch")).getByLabelText(/new leads of/);
    fireEvent.change(select, { target: { value: RAVI } });
    await screen.findByRole("alertdialog");
    fireEvent.click(bothButton());
    expect(await within(rowOf("Karuvi Launch")).findByRole("alert")).toHaveTextContent("Choose an active member of this company.");
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
    expect(select).toHaveValue(PRIYA);
  });

  it("says the rule was saved but the leads were not assigned, and lets the owner retry", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    api.applyAdAssignee.mockRejectedValueOnce(new Error("The unassigned leads could not be assigned.")).mockResolvedValueOnce(4);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Name pending")).getByLabelText(/new leads of/), { target: { value: RAVI } });
    await screen.findByRole("alertdialog");
    fireEvent.click(bothButton());
    const alert = await within(rowOf("Name pending")).findByRole("alert");
    expect(alert).toHaveTextContent("Saved for new leads, but the unassigned leads were not assigned.");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.applyAdAssignee).toHaveBeenCalledTimes(2));
    expect(api.setAdAssignee).toHaveBeenCalledTimes(1);
    expect(await within(rowOf("Name pending")).findByText(/4 earlier unassigned leads and all upcoming leads from this ad are now assigned to Ravi/)).toBeInTheDocument();
  });

  it("lets the owner assign the leftover unassigned leads later without changing the rule", async () => {
    api.applyAdAssignee.mockResolvedValue(3);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Karuvi Launch")).getByLabelText(/already arrived leads/), { target: { value: PRIYA } });
    const dialog = await screen.findByRole("alertdialog", { name: "Assign the unassigned leads to Priya?" });
    expect(within(dialog).queryByRole("button", { name: /Only upcoming leads/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "OK, assign" }));
    await waitFor(() => expect(api.applyAdAssignee).toHaveBeenCalledWith("1200000000000001"));
    expect(api.setAdAssignee).not.toHaveBeenCalled();
    expect(await within(rowOf("Karuvi Launch")).findByText("Done. 3 earlier unassigned leads now assigned to Priya.")).toBeInTheDocument();
    expect(within(rowOf("Karuvi Launch")).getByText("None")).toBeInTheDocument();
  });

  it("shows an employee the assignments read-only: nothing to click, nothing can be saved", async () => {
    api.getAdAssignments.mockResolvedValue({ ...overview(), isOwner: false });
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    expect(screen.getByText("Only the company owner can change who receives each ad's leads. You can see the current assignments here.")).toBeInTheDocument();
    const karuvi = within(rowOf("Karuvi Launch")).getByLabelText(/new leads of/);
    expect(karuvi).toBeDisabled();
    expect(karuvi).toHaveValue(PRIYA);
    expect(within(rowOf("Name pending")).getByLabelText(/new leads of/)).toBeDisabled();
    expect(within(rowOf("Karuvi Launch")).queryByLabelText(/already arrived leads/)).not.toBeInTheDocument();
    expect(within(rowOf("Karuvi Launch")).getByText("3 leads unassigned")).toBeInTheDocument();
    expect(within(rowOf("Old Campaign")).getByText("None")).toBeInTheDocument();
    // Even a forced change event (devtools, a stray script) opens nothing and saves nothing.
    fireEvent.change(karuvi, { target: { value: RAVI } });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setAdAssignee).not.toHaveBeenCalled();
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
  });

  it("shows only the owner-only message to an employee, with no retry", async () => {
    api.getAdAssignments.mockRejectedValue(new AdAssignmentOwnerOnlyError("Only the company owner can manage ad assignment."));
    render(<AdAssignmentSection />);
    expect(await screen.findByText("Only the company owner can manage ad assignment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers Retry after a load failure and recovers", async () => {
    api.getAdAssignments.mockRejectedValueOnce(new Error("Ad assignments could not be loaded."));
    render(<AdAssignmentSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Ad assignments could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Karuvi Launch")).toBeInTheDocument();
  });

  it("explains that an ad appears after its first lead when there are none yet", async () => {
    api.getAdAssignments.mockResolvedValue({ ads: [], members: [], isOwner: true });
    render(<AdAssignmentSection />);
    expect(await screen.findByText("No ads yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
