import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserWorkspaces } from "@/lib/server/workspace-service";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

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
    expect(screen.getByRole("button", { name: /Agency A/ })).toHaveAttribute("aria-current", "true");
  });

  it("opens a company through the server, which verifies the membership", async () => {
    const fetchMock = stubFetch(200, { tenantId: TENANT_A, redirectTo: "/" });
    render(<WorkspacePickerClient workspaces={EMPLOYEE_ONLY} activeTenantId={null} />);

    fireEvent.click(screen.getByRole("button", { name: /Agency A/ }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
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

  it("hides Create new company from someone who already owns one", () => {
    render(<WorkspacePickerClient workspaces={{ ...EMPLOYEE_ONLY, ownsCompany: true }} activeTenantId={null} />);
    expect(screen.queryByRole("button", { name: "+ Create new company" })).not.toBeInTheDocument();
  });
});
