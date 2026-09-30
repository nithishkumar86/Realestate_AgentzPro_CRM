import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserWorkspaces } from "@/lib/server/workspace-service";

const replace = vi.fn();
const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh, push }) }));

const { WorkspacePickerClient } = await import("@/features/workspaces/workspace-picker-client");

const TENANT_A = "10000000-0000-4000-8000-00000000000a";
const TENANT_B = "10000000-0000-4000-8000-00000000000b";
const INVITATION_ID = "20000000-0000-4000-8000-000000000001";

const EMPLOYEE_ONLY: UserWorkspaces = {
  companies: [
    { tenantId: TENANT_A, tenantName: "Agency A", role: "employee", membershipStatus: "active" },
  ],
  invitations: [{ invitationId: INVITATION_ID, tenantId: TENANT_B, tenantName: "Agency B", role: "employee" }],
  ownsCompany: false,
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WorkspacePickerClient", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("lists companies and invitations with the company name taken from the server", () => {
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={TENANT_A} />);

    expect(screen.getByText("Agency B")).toBeInTheDocument();
    expect(screen.getByText("Invited you as Employee")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Agency A/ })).toBeChecked();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("opens a company through the server, which verifies the membership", async () => {
    const fetchMock = stubFetch(200, { tenantId: TENANT_A, redirectTo: "/" });
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);

    fireEvent.click(screen.getByRole("radio", { name: /Agency A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/active", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ tenantId: TENANT_A });
  });

  it("accepts an invitation with one click and no form", async () => {
    const fetchMock = stubFetch(201, { tenantId: TENANT_B, redirectTo: "/" });
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/workspaces/invitations/${INVITATION_ID}/accept`);
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("shows the server's message when an action fails", async () => {
    stubFetch(404, { error: { message: "This invitation is no longer valid." } });
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation is no longer valid.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks only for the company name when creating a company", async () => {
    const fetchMock = stubFetch(201, { tenantId: TENANT_B, redirectTo: "/" });
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "+ Create new company" }));
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Ravi Realty" } });
    fireEvent.click(screen.getByRole("button", { name: "Create company" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body).sort()).toEqual(["companyName", "timezone"]);
    expect(body.companyName).toBe("Ravi Realty");
  });

  it("shows whose saved details the new company will use, and nothing when they are unknown", () => {
    const { unmount } = render(
      <WorkspacePickerClient
        workspaces={EMPLOYEE_ONLY}
        activeTenantId={null}
        creator={{ fullName: "Ravi", phoneNumber: "919876543210", professionalRole: "Telecaller" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Create new company" }));
    expect(screen.getByText(/Creating as/)).toHaveTextContent("Creating as Ravi · +91 9876543210 · Telecaller");
    expect(screen.getByText(/of this new company/)).toHaveTextContent(
      "You will be the Owner of this new company. To change your name, phone or professional role, go to Settings → Profile.",
    );
    unmount();

    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Create new company" }));
    expect(screen.queryByText(/Creating as/)).not.toBeInTheDocument();
  });

  it("hides Create new company from someone who already owns one", () => {
    render(<WorkspacePickerClient workspaces={{ ...EMPLOYEE_ONLY, ownsCompany: true }} activeTenantId={null} />);
    expect(screen.queryByRole("button", { name: "+ Create new company" })).not.toBeInTheDocument();
  });

  describe("company radio group", () => {
    const MANY: UserWorkspaces = {
      companies: [
        { tenantId: TENANT_A, tenantName: "Agency A", role: "employee", membershipStatus: "active" },
        { tenantId: TENANT_B, tenantName: "Agency B", role: "owner", membershipStatus: "active" },
        { tenantId: "10000000-0000-4000-8000-00000000000c", tenantName: "Agency C", role: "employee", membershipStatus: "paused" },
      ],
      invitations: [],
      ownsCompany: true,
    };

    it("lets only one company be selected at a time", () => {
      render(<WorkspacePickerClient workspaces={MANY} activeTenantId={null} />);

      fireEvent.click(screen.getByRole("radio", { name: /Agency A/ }));
      fireEvent.click(screen.getByRole("radio", { name: /Agency B/ }));

      expect(screen.getByRole("radio", { name: /Agency A/ })).not.toBeChecked();
      expect(screen.getByRole("radio", { name: /Agency B/ })).toBeChecked();
      expect(screen.getAllByRole("radio").filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
    });

    it("keeps Apply disabled until a company is chosen, then opens only that one", async () => {
      const fetchMock = stubFetch(200, { tenantId: TENANT_B, redirectTo: "/" });
      render(<WorkspacePickerClient workspaces={MANY} activeTenantId={null} />);
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

      fireEvent.click(screen.getByRole("radio", { name: /Agency B/ }));
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
      // The button must not flash back to "Apply" while the next page loads.
      expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ tenantId: TENANT_B });
    });

    it("cannot select a company whose access is paused", () => {
      render(<WorkspacePickerClient workspaces={MANY} activeTenantId={null} />);
      expect(screen.getByRole("radio", { name: /Agency C/ })).toBeDisabled();
      expect(screen.getByText("Access paused")).toBeInTheDocument();
    });

    it("goes back to the dashboard from Cancel or X without changing company", () => {
      const fetchMock = stubFetch(200, {});
      render(<WorkspacePickerClient workspaces={MANY} activeTenantId={TENANT_A} canDismiss />);

      fireEvent.click(screen.getByRole("radio", { name: /Agency B/ }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(push).toHaveBeenCalledTimes(2);
      expect(push).toHaveBeenCalledWith("/dashboard");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("hides Cancel and X when no company is open yet, so they cannot loop back here", () => {
      render(<WorkspacePickerClient workspaces={MANY} activeTenantId={null} />);
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    });
  });
});
