import { beforeEach, describe, expect, it, vi } from "vitest";

const adminRpc = vi.fn();
const inviteUserByEmail = vi.fn();
const tableUpdateEq = vi.fn();
const tableDeleteEq = vi.fn();
const authRpc = vi.fn();
const getUserById = vi.fn();
// Resolves a `select(...).eq(...)...maybeSingle()` chain from the table name and its eq filters.
const tableSelect = vi.fn();

function selectChain(table: string) {
  const filters: Record<string, unknown> = {};
  const chain = {
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => tableSelect(table, filters),
  };
  return chain;
}

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: adminRpc,
    auth: { admin: { inviteUserByEmail, getUserById } },
    from: (table: string) => ({
      select: () => selectChain(table),
      update: (values: unknown) => ({ eq: (column: string, value: unknown) => tableUpdateEq(values, column, value) }),
      delete: () => ({ eq: (column: string, value: unknown) => tableDeleteEq(column, value) }),
    }),
  }),
}));

vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({ rpc: authRpc }),
}));

const {
  sendMemberInvitations,
  acceptMemberInvitation,
  findWithdrawnInvitationForUser,
  findWithdrawnInvitationById,
  removeTenantMember,
  joinInvitedWorkspace,
  declineInvitation,
} = await import("@/lib/server/member-invitation-service");

const OWNER = {
  userId: "owner-1",
  tenantId: "tenant-1",
  tenantName: "AgentzPro Realty",
  fullName: "Owner",
  membershipRole: "owner",
};
const REDIRECT = "https://crm.example.com/auth/confirm";

function created(userId: string | null = null) {
  return { data: [{ outcome: "CREATED", invitation_id: "inv-1", user_id: userId }], error: null };
}

describe("sendMemberInvitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tableUpdateEq.mockResolvedValue({ error: null });
    tableDeleteEq.mockResolvedValue({ error: null });
  });

  it("refuses anyone who is not the owner before touching the database", async () => {
    await expect(
      sendMemberInvitations({ ...OWNER, membershipRole: "employee" }, { invitations: [{ email: "a@b.co", role: "employee" }] }, REDIRECT),
    ).rejects.toMatchObject({ status: 403, code: "INVITE_NOT_ALLOWED" });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("rejects the owner role and malformed bodies", async () => {
    await expect(
      sendMemberInvitations(OWNER, { invitations: [{ email: "a@b.co", role: "owner" }] }, REDIRECT),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_INVITATION_INPUT" });
    await expect(sendMemberInvitations(OWNER, { invitations: [] }, REDIRECT)).rejects.toMatchObject({ status: 400 });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("records the invitation under the session's tenant and inviter, sends the email, and stores the new user_id", async () => {
    adminRpc.mockResolvedValue(created());
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });

    const results = await sendMemberInvitations(OWNER, { invitations: [{ email: "  Ravi@Example.com ", role: "admin" }] }, REDIRECT);

    expect(adminRpc).toHaveBeenCalledWith("create_member_invitation", {
      p_tenant_id: "tenant-1",
      p_invited_by: "owner-1",
      p_email: "ravi@example.com",
      p_membership_role: "admin",
    });
    expect(inviteUserByEmail).toHaveBeenCalledWith("ravi@example.com", { redirectTo: `${REDIRECT}?invitation=inv-1` });
    expect(tableUpdateEq).toHaveBeenCalledWith({ user_id: "new-user" }, "invitation_id", "inv-1");
    expect(results).toEqual([{ email: "ravi@example.com", status: "sent", message: "Invitation sent." }]);
  });

  it("reports existing members and duplicate invitations without sending email", async () => {
    adminRpc
      .mockResolvedValueOnce({ data: [{ outcome: "ALREADY_MEMBER", invitation_id: null, user_id: "u" }], error: null })
      .mockResolvedValueOnce({ data: [{ outcome: "ALREADY_INVITED", invitation_id: null, user_id: null }], error: null });

    const results = await sendMemberInvitations(
      OWNER,
      { invitations: [{ email: "a@b.co", role: "employee" }, { email: "c@d.co", role: "employee" }, { email: "A@b.co", role: "admin" }] },
      REDIRECT,
    );

    expect(results.map((item) => item.status)).toEqual(["already_member", "already_invited", "already_invited"]);
    expect(adminRpc).toHaveBeenCalledTimes(2);
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("removes the invitation again when the email cannot be sent", async () => {
    adminRpc.mockResolvedValue(created());
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { status: 429, code: "over_email_send_rate_limit" } });

    const results = await sendMemberInvitations(OWNER, { invitations: [{ email: "a@b.co", role: "employee" }] }, REDIRECT);

    expect(results[0].status).toBe("failed");
    expect(tableDeleteEq).toHaveBeenCalledWith("invitation_id", "inv-1");
  });

  it("keeps the invitation for a confirmed account that never finished setup", async () => {
    adminRpc.mockResolvedValue(created("existing-user"));
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { status: 422, code: "email_exists" } });

    const results = await sendMemberInvitations(OWNER, { invitations: [{ email: "a@b.co", role: "employee" }] }, REDIRECT);

    expect(results[0].status).toBe("saved_existing_account");
    expect(tableDeleteEq).not.toHaveBeenCalled();
  });

  it("marks an invalid email without calling the database", async () => {
    const results = await sendMemberInvitations(OWNER, { invitations: [{ email: "not-an-email", role: "employee" }] }, REDIRECT);
    expect(results[0].status).toBe("invalid_email");
    expect(adminRpc).not.toHaveBeenCalled();
  });
});

describe("removeTenantMember", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses non-owners before touching the database", async () => {
    await expect(removeTenantMember({ ...OWNER, membershipRole: "employee" }, "member-1")).rejects.toMatchObject({
      status: 403,
      code: "MEMBER_REMOVE_NOT_ALLOWED",
    });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("passes only session-derived tenant and owner ids with the selected member id", async () => {
    adminRpc.mockResolvedValue({ data: true, error: null });

    await expect(removeTenantMember(OWNER, "member-1")).resolves.toBeUndefined();
    expect(adminRpc).toHaveBeenCalledWith("remove_tenant_member", {
      p_tenant_id: "tenant-1",
      p_owner_user_id: "owner-1",
      p_member_user_id: "member-1",
    });
  });

  it("does not report success when no employee membership was removed", async () => {
    adminRpc.mockResolvedValue({ data: false, error: null });
    await expect(removeTenantMember(OWNER, "member-1")).rejects.toMatchObject({
      status: 404,
      code: "MEMBER_NOT_FOUND",
    });
  });

  it("maps a database authorization failure to forbidden", async () => {
    adminRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(removeTenantMember(OWNER, "member-1")).rejects.toMatchObject({
      status: 403,
      code: "MEMBER_REMOVE_NOT_ALLOWED",
    });
  });
});

describe("acceptMemberInvitation", () => {
  beforeEach(() => vi.clearAllMocks());

  const INVITATION_ID = "20000000-0000-4000-8000-000000000001";
  const VALID = { invitationId: INVITATION_ID, fullName: "Ravi", phoneNumber: "9876543210", professionalRole: "Sales" };

  it("sends the invitation id and personal details — never a tenant or role — to the accept RPC", async () => {
    authRpc.mockResolvedValue({ data: [{ tenant_id: "tenant-1", membership_role: "admin" }], error: null });

    await expect(acceptMemberInvitation({ ...VALID, tenantId: "evil", role: "owner" })).resolves.toEqual({
      tenantId: "tenant-1",
      role: "admin",
    });
    expect(authRpc).toHaveBeenCalledWith("accept_member_invitation", {
      p_invitation_id: INVITATION_ID,
      p_full_name: "Ravi",
      p_phone_number: expect.any(String),
      p_professional_role: "Sales",
    });
  });

  it("maps a missing or expired invitation to a 404", async () => {
    authRpc.mockResolvedValue({ data: null, error: { code: "P0002" } });
    await expect(acceptMemberInvitation(VALID)).rejects.toMatchObject({ status: 404, code: "INVITATION_NOT_FOUND" });
  });

  it("requires a well-formed invitation id", async () => {
    await expect(acceptMemberInvitation({ ...VALID, invitationId: "not-a-uuid" })).rejects.toMatchObject({ status: 400 });
    expect(authRpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number before calling the RPC", async () => {
    await expect(acceptMemberInvitation({ ...VALID, phoneNumber: "abc" })).rejects.toMatchObject({ code: "INVALID_PHONE_NUMBER" });
    await expect(acceptMemberInvitation({ ...VALID, phoneNumber: "987654321012345" })).rejects.toMatchObject({
      code: "INVALID_PHONE_NUMBER",
    });
    expect(authRpc).not.toHaveBeenCalled();
  });

  it("rejects a name with digits before calling the RPC", async () => {
    await expect(acceptMemberInvitation({ ...VALID, fullName: "12345" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
      details: { fieldErrors: { fullName: expect.any(String) } },
    });
    expect(authRpc).not.toHaveBeenCalled();
  });
});

describe("joinInvitedWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());
  const INVITATION_ID = "20000000-0000-4000-8000-000000000002";

  it("sends only the invitation id; the tenant and role come back from the invitation", async () => {
    authRpc.mockResolvedValue({ data: [{ tenant_id: "tenant-b", membership_role: "employee" }], error: null });

    await expect(joinInvitedWorkspace(INVITATION_ID)).resolves.toEqual({ tenantId: "tenant-b", role: "employee" });
    expect(authRpc).toHaveBeenCalledWith("join_invited_workspace", { p_invitation_id: INVITATION_ID });
  });

  it("maps a missing, expired, or someone else's invitation to a 404", async () => {
    authRpc.mockResolvedValue({ data: null, error: { code: "P0002" } });
    await expect(joinInvitedWorkspace(INVITATION_ID)).rejects.toMatchObject({ status: 404, code: "INVITATION_NOT_FOUND" });
  });

  it("sends a person without a profile back to setup", async () => {
    authRpc.mockResolvedValue({ data: null, error: { code: "P0001" } });
    await expect(joinInvitedWorkspace(INVITATION_ID)).rejects.toMatchObject({ status: 409, code: "ONBOARDING_REQUIRED" });
  });

  it("rejects a malformed id without calling the database", async () => {
    await expect(joinInvitedWorkspace("inv-1")).rejects.toMatchObject({ status: 404 });
    expect(authRpc).not.toHaveBeenCalled();
  });
});

describe("declineInvitation", () => {
  beforeEach(() => vi.clearAllMocks());
  const INVITATION_ID = "20000000-0000-4000-8000-000000000003";

  it("declines the caller's own pending invitation", async () => {
    authRpc.mockResolvedValue({ data: true, error: null });
    await expect(declineInvitation(INVITATION_ID)).resolves.toBeUndefined();
    expect(authRpc).toHaveBeenCalledWith("decline_member_invitation", { p_invitation_id: INVITATION_ID });
  });

  it("reports 404 when nothing was declined", async () => {
    authRpc.mockResolvedValue({ data: false, error: null });
    await expect(declineInvitation(INVITATION_ID)).rejects.toMatchObject({ status: 404, code: "INVITATION_NOT_FOUND" });
  });
});

describe("findWithdrawnInvitationById", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the company name only for a withdrawn invitation", async () => {
    tableSelect.mockImplementation(async (table: string) =>
      table === "tenants"
        ? { data: { tenant_name: "QA Test Co" }, error: null }
        : { data: { tenant_id: "tenant-1" }, error: null },
    );

    await expect(findWithdrawnInvitationById("inv-1")).resolves.toEqual({ tenantName: "QA Test Co" });
    expect(tableSelect).toHaveBeenCalledWith("invitation_member", { invitation_id: "inv-1", status: "revoked" });
  });

  it("returns null for any invitation that was not withdrawn", async () => {
    tableSelect.mockResolvedValue({ data: null, error: null });
    await expect(findWithdrawnInvitationById("inv-1")).resolves.toBeNull();
    expect(tableSelect).not.toHaveBeenCalledWith("tenants", expect.anything());
  });

  it("surfaces a lookup failure as a retryable 500", async () => {
    tableSelect.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(findWithdrawnInvitationById("inv-1")).rejects.toMatchObject({ status: 500, retryable: true });
  });
});

describe("findWithdrawnInvitationForUser", () => {
  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
  const PAST = new Date(Date.now() - 86_400_000).toISOString();

  function invitation(status: string, createdAt: string, expiresAt = FUTURE) {
    return { tenant_id: "tenant-1", status, expires_at: expiresAt, created_at: createdAt };
  }

  // byUser / byEmail are the latest invitation_member rows matched by user_id and by email.
  function mockRows(byUser: unknown, byEmail: unknown) {
    tableSelect.mockImplementation(async (table: string, filters: Record<string, unknown>) => {
      if (table === "tenants") {
        return { data: { tenant_name: "AgentzPro Realty" }, error: null };
      }
      return { data: "user_id" in filters ? byUser : byEmail, error: null };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getUserById.mockResolvedValue({ data: { user: { email: " Ravi@Example.com " } }, error: null });
  });

  it("returns the company name when the latest invitation was withdrawn and its link is still live", async () => {
    mockRows(invitation("revoked", "2026-09-23T06:00:00Z"), null);

    await expect(findWithdrawnInvitationForUser("user-1")).resolves.toEqual({ tenantName: "AgentzPro Realty" });
    expect(tableSelect).toHaveBeenCalledWith("invitation_member", { user_id: "user-1" });
    expect(tableSelect).toHaveBeenCalledWith("invitation_member", { email: "ravi@example.com" });
  });

  it("matches a withdrawn invitation by email when user_id was never written back", async () => {
    mockRows(null, invitation("revoked", "2026-09-23T06:00:00Z"));
    await expect(findWithdrawnInvitationForUser("user-1")).resolves.toEqual({ tenantName: "AgentzPro Realty" });
  });

  it("ignores a withdrawn invitation that a newer invitation replaced", async () => {
    mockRows(invitation("revoked", "2026-09-23T06:00:00Z"), invitation("accepted", "2026-09-23T07:00:00Z"));
    await expect(findWithdrawnInvitationForUser("user-1")).resolves.toBeNull();
  });

  it("stops blocking once the withdrawn link would have expired anyway", async () => {
    mockRows(invitation("revoked", "2026-09-16T06:00:00Z", PAST), null);
    await expect(findWithdrawnInvitationForUser("user-1")).resolves.toBeNull();
  });

  it("returns null for someone who was never invited", async () => {
    mockRows(null, null);
    await expect(findWithdrawnInvitationForUser("user-1")).resolves.toBeNull();
    expect(tableSelect).not.toHaveBeenCalledWith("tenants", expect.anything());
  });

  it("surfaces a lookup failure as a retryable 500", async () => {
    tableSelect.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(findWithdrawnInvitationForUser("user-1")).rejects.toMatchObject({ status: 500, retryable: true });
  });
});
