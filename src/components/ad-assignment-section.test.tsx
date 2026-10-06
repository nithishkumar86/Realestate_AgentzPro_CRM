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
});

const rowOf = (ad: string) => screen.getByTitle(ad).closest("tr")!;

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
    expect(within(first).getByText("12")).toBeInTheDocument();
    expect(within(first).getByRole("combobox", { name: "Who receives new leads from Karuvi Launch" })).toHaveValue(PRIYA);
    expect(within(first).getByRole("button", { name: "Assign 3 unassigned" })).toBeInTheDocument();
    const second = rowOf("Name pending");
    expect(within(second).getByRole("combobox")).toHaveValue("");
    expect(within(second).getByText("4 unassigned")).toBeInTheDocument();
    expect(within(second).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowOf("Old Campaign")).getByText("All leads assigned")).toBeInTheDocument();
  });

  it("saves the chosen member for an ad and confirms who now receives its leads", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const select = within(rowOf("Name pending")).getByRole("combobox");
    fireEvent.change(select, { target: { value: RAVI } });
    await waitFor(() => expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000002", RAVI));
    expect(await within(rowOf("Name pending")).findByText("New leads from this ad go to Ravi.")).toBeInTheDocument();
    expect(select).toHaveValue(RAVI);
    expect(within(rowOf("Name pending")).getByRole("button", { name: "Assign 4 unassigned" })).toBeInTheDocument();
  });

  it("clears a rule with null", async () => {
    api.setAdAssignee.mockResolvedValue(undefined);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    fireEvent.change(within(rowOf("Karuvi Launch")).getByRole("combobox"), { target: { value: "" } });
    await waitFor(() => expect(api.setAdAssignee).toHaveBeenCalledWith("1200000000000001", null));
    expect(await within(rowOf("Karuvi Launch")).findByText("New leads from this ad are left unassigned.")).toBeInTheDocument();
  });

  it("keeps the previous assignee and shows the message when saving fails", async () => {
    api.setAdAssignee.mockRejectedValue(new Error("Choose an active member of this company."));
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const select = within(rowOf("Karuvi Launch")).getByRole("combobox");
    fireEvent.change(select, { target: { value: RAVI } });
    expect(await within(rowOf("Karuvi Launch")).findByRole("alert")).toHaveTextContent("Choose an active member of this company.");
    expect(select).toHaveValue(PRIYA);
  });

  it("assigns the earlier unassigned leads only after the owner confirms, then shows the count", async () => {
    api.applyAdAssignee.mockResolvedValue(3);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AdAssignmentSection />);
    await screen.findByText("Karuvi Launch");
    const button = within(rowOf("Karuvi Launch")).getByRole("button", { name: "Assign 3 unassigned" });
    fireEvent.click(button);
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Assign the 3 unassigned leads of this ad to Priya?"));
    expect(api.applyAdAssignee).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(api.applyAdAssignee).toHaveBeenCalledWith("1200000000000001"));
    expect(await within(rowOf("Karuvi Launch")).findByText("3 leads assigned to Priya.")).toBeInTheDocument();
    expect(within(rowOf("Karuvi Launch")).getByText("All leads assigned")).toBeInTheDocument();
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
    api.getAdAssignments.mockResolvedValue({ ads: [], members: [] });
    render(<AdAssignmentSection />);
    expect(await screen.findByText("No ads yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
