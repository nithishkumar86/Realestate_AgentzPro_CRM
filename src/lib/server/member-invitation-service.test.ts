import { beforeEach, describe, expect, it, vi } from "vitest";

const adminRpc = vi.fn();
const inviteUserByEmail = vi.fn();
const tableUpdateEq = vi.fn();
const tableDeleteEq = vi.fn();
const authRpc = vi.fn();

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: adminRpc,
    auth: { admin: { inviteUserByEmail } },
    from: () => ({
      update: (values: unknown) => ({ eq: (column: string, value: unknown) => tableUpdateEq(values, column, value) }),
      delete: () => ({ eq: (column: string, value: unknown) => tableDeleteEq(column, value) }),
    }),
  }),
}));

vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({ rpc: authRpc }),
}));

const { sendMemberInvitations, acceptMemberInvitation } = await import("@/lib/server/member-invitation-service");

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
    expect(inviteUserByEmail).toHaveBeenCalledWith("ravi@example.com", { redirectTo: REDIRECT });
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

describe("acceptMemberInvitation", () => {
  beforeEach(() => vi.clearAllMocks());

  const VALID = { fullName: "Ravi", phoneNumber: "9876543210", professionalRole: "Sales" };

  it("sends only personal details — never a tenant or role — to the accept RPC", async () => {
    authRpc.mockResolvedValue({ data: [{ tenant_id: "tenant-1", membership_role: "admin" }], error: null });

    await expect(acceptMemberInvitation({ ...VALID, tenantId: "evil", role: "owner" })).resolves.toEqual({
      tenantId: "tenant-1",
      role: "admin",
    });
    expect(authRpc).toHaveBeenCalledWith("accept_member_invitation", {
      p_full_name: "Ravi",
      p_phone_number: expect.any(String),
      p_professional_role: "Sales",
    });
  });

  it("maps a missing or expired invitation to a 404", async () => {
    authRpc.mockResolvedValue({ data: null, error: { code: "P0002" } });
    await expect(acceptMemberInvitation(VALID)).rejects.toMatchObject({ status: 404, code: "INVITATION_NOT_FOUND" });
  });

  it("rejects an invalid phone number before calling the RPC", async () => {
    await expect(acceptMemberInvitation({ ...VALID, phoneNumber: "abc" })).rejects.toMatchObject({ code: "INVALID_PHONE_NUMBER" });
    expect(authRpc).not.toHaveBeenCalled();
  });
});
