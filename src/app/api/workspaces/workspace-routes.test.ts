import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  assertSameOrigin: vi.fn(),
  requireActiveMembership: vi.fn(),
  createOwnedWorkspace: vi.fn(),
  joinInvitedWorkspace: vi.fn(),
  declineInvitation: vi.fn(),
}));

vi.mock("@/lib/server/auth/session", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/workspace-service", () => ({
  requireActiveMembership: mocks.requireActiveMembership,
  createOwnedWorkspace: mocks.createOwnedWorkspace,
}));
vi.mock("@/lib/server/member-invitation-service", () => ({
  joinInvitedWorkspace: mocks.joinInvitedWorkspace,
  declineInvitation: mocks.declineInvitation,
}));

const { POST: switchCompany } = await import("./active/route");
const { POST: createCompany } = await import("./route");
const { POST: acceptInvitation } = await import("./invitations/[invitationId]/accept/route");
const { POST: declineInvitation } = await import("./invitations/[invitationId]/decline/route");

const TENANT_B = "10000000-0000-4000-8000-00000000000b";
const INVITATION_ID = "20000000-0000-4000-8000-000000000001";

function post(path: string, body?: unknown): Request {
  return new Request(`https://crm.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ invitationId: INVITATION_ID }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifySession.mockResolvedValue({ userId: "user-1" });
});

describe("POST /api/workspaces/active", () => {
  it("checks the session user's own membership before writing the active-company cookie", async () => {
    mocks.requireActiveMembership.mockResolvedValue(undefined);

    const response = await switchCompany(post("/api/workspaces/active", { tenantId: TENANT_B.toUpperCase() }));

    expect(mocks.requireActiveMembership).toHaveBeenCalledWith("user-1", TENANT_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: TENANT_B, redirectTo: "/" });
    expect(response.headers.get("set-cookie")).toContain(`agentz_active_tenant=${TENANT_B}`);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("never sets the cookie for a company the user does not belong to", async () => {
    mocks.requireActiveMembership.mockRejectedValue(
      new AppError("You are not a member of this company.", { status: 404, code: "WORKSPACE_NOT_FOUND" }),
    );

    const response = await switchCompany(post("/api/workspaces/active", { tenantId: TENANT_B }));

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an unauthenticated caller and a malformed tenant id", async () => {
    mocks.verifySession.mockResolvedValueOnce(null);
    expect((await switchCompany(post("/api/workspaces/active", { tenantId: TENANT_B }))).status).toBe(401);

    expect((await switchCompany(post("/api/workspaces/active", { tenantId: "not-a-uuid" }))).status).toBe(400);
    expect(mocks.requireActiveMembership).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces", () => {
  it("creates the owned company and opens it", async () => {
    mocks.createOwnedWorkspace.mockResolvedValue({ tenantId: TENANT_B });

    const response = await createCompany(post("/api/workspaces", { companyName: "Ravi Realty", timezone: "Asia/Kolkata" }));

    expect(mocks.createOwnedWorkspace).toHaveBeenCalledWith({ companyName: "Ravi Realty", timezone: "Asia/Kolkata" });
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(`agentz_active_tenant=${TENANT_B}`);
  });
});

describe("invitation accept / decline", () => {
  it("accepts with one click and opens the joined company", async () => {
    mocks.joinInvitedWorkspace.mockResolvedValue({ tenantId: TENANT_B, role: "employee" });

    const response = await acceptInvitation(post(`/api/workspaces/invitations/${INVITATION_ID}/accept`), params);

    expect(mocks.joinInvitedWorkspace).toHaveBeenCalledWith(INVITATION_ID);
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(`agentz_active_tenant=${TENANT_B}`);
  });

  it("declines without touching the active company", async () => {
    mocks.declineInvitation.mockResolvedValue(undefined);

    const response = await declineInvitation(post(`/api/workspaces/invitations/${INVITATION_ID}/decline`), params);

    expect(mocks.declineInvitation).toHaveBeenCalledWith(INVITATION_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("requires a session", async () => {
    mocks.verifySession.mockResolvedValue(null);
    const response = await acceptInvitation(post(`/api/workspaces/invitations/${INVITATION_ID}/accept`), params);
    expect(response.status).toBe(401);
    expect(mocks.joinInvitedWorkspace).not.toHaveBeenCalled();
  });
});
