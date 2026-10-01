import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  setTenantMemberAccess: vi.fn(),
  requireCrmAccess: vi.fn(),
}));

vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.requireCrmAccess }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/member-invitation-service", () => ({ setTenantMemberAccess: mocks.setTenantMemberAccess }));

const { PATCH } = await import("./route");

const OWNER = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantName: "AgentzPro Realty",
  fullName: "Owner",
  membershipRole: "owner",
};
const MEMBER_USER_ID = "22222222-2222-4222-8222-222222222222";

function patchRequest(memberUserId: string, body: unknown): Request {
  return new Request(`https://crm.example.com/api/settings/members/${memberUserId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/settings/members/[memberUserId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCrmAccess.mockResolvedValue(OWNER);
    mocks.setTenantMemberAccess.mockResolvedValue(undefined);
  });

  it.each(["blocked", "active"] as const)("checks the origin and sets access to %s using verified access", async (memberAccess) => {
    const request = patchRequest(MEMBER_USER_ID, { access: memberAccess });
    const response = await PATCH(request, { params: Promise.resolve({ memberUserId: MEMBER_USER_ID }) });

    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.setTenantMemberAccess).toHaveBeenCalledWith(OWNER, MEMBER_USER_ID, memberAccess);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ memberUserId: MEMBER_USER_ID, access: memberAccess });
  });

  it("rejects an invalid member id before resolving CRM access", async () => {
    const response = await PATCH(patchRequest("not-a-uuid", { access: "blocked" }), {
      params: Promise.resolve({ memberUserId: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.requireCrmAccess).not.toHaveBeenCalled();
    expect(mocks.setTenantMemberAccess).not.toHaveBeenCalled();
  });

  it.each([{ access: "removed" }, { access: "owner" }, {}, null])("rejects access value %j", async (body) => {
    const response = await PATCH(patchRequest(MEMBER_USER_ID, body), {
      params: Promise.resolve({ memberUserId: MEMBER_USER_ID }),
    });

    expect(response.status).toBe(400);
    expect(mocks.setTenantMemberAccess).not.toHaveBeenCalled();
  });
});
