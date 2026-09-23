import { beforeEach, describe, expect, it, vi } from "vitest";

const findWithdrawnInvitationById = vi.fn();
const verifyOtp = vi.fn();
const setSession = vi.fn();

vi.mock("@/lib/server/member-invitation-service", () => ({ findWithdrawnInvitationById }));
vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({ auth: { verifyOtp, setSession } }),
}));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: () => undefined }));

const { POST } = await import("@/app/api/auth/invite/confirm/route");

const INVITATION_ID = "a8195490-82e4-455e-8e78-8e7606616e26";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/auth/invite/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/auth/invite/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findWithdrawnInvitationById.mockResolvedValue(null);
    verifyOtp.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    setSession.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  });

  it("reports a withdrawn invitation and never creates a session, even with a valid token", async () => {
    findWithdrawnInvitationById.mockResolvedValue({ tenantName: "QA Test Co" });

    const response = await post({ invitationId: INVITATION_ID, accessToken: "access", refreshToken: "refresh" });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVITATION_WITHDRAWN", details: { tenantName: "QA Test Co" } },
    });
    expect(setSession).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("reports a withdrawn invitation when Supabase already used up the token and only the id arrives", async () => {
    findWithdrawnInvitationById.mockResolvedValue({ tenantName: "QA Test Co" });

    const response = await post({ invitationId: INVITATION_ID });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVITATION_WITHDRAWN" } });
  });

  it("signs in a pending invitation with the fragment tokens", async () => {
    const response = await post({ invitationId: INVITATION_ID, accessToken: "access", refreshToken: "refresh" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ redirectTo: "/onboarding" });
    expect(setSession).toHaveBeenCalledWith({ access_token: "access", refresh_token: "refresh" });
  });

  it("signs in with a token_hash link", async () => {
    const response = await post({ invitationId: INVITATION_ID, tokenHash: "hash" });

    expect(response.status).toBe(200);
    expect(verifyOtp).toHaveBeenCalledWith({ type: "invite", token_hash: "hash" });
  });

  it("returns the invalid-link error for a used token on an invitation that was not withdrawn", async () => {
    const response = await post({ invitationId: INVITATION_ID });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVITE_LINK_INVALID" } });
  });

  it("rejects a malformed invitation id without looking it up", async () => {
    const response = await post({ invitationId: "not-a-uuid", tokenHash: "hash" });

    expect(response.status).toBe(400);
    expect(findWithdrawnInvitationById).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("marks every response as uncacheable", async () => {
    const response = await post({ invitationId: INVITATION_ID });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
