import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  removeTenantMember: vi.fn(),
  requireCrmAccess: vi.fn(),
}));

vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.requireCrmAccess }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/member-invitation-service", () => ({ removeTenantMember: mocks.removeTenantMember }));

const { DELETE } = await import("./route");

const OWNER = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantName: "AgentzPro Realty",
  fullName: "Owner",
  membershipRole: "owner",
};
const MEMBER_USER_ID = "22222222-2222-4222-8222-222222222222";

describe("DELETE /api/settings/members/[memberUserId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCrmAccess.mockResolvedValue(OWNER);
    mocks.removeTenantMember.mockResolvedValue(undefined);
  });

  it("checks the origin and removes the requested member using verified access", async () => {
    const request = new Request(`https://crm.example.com/api/settings/members/${MEMBER_USER_ID}`, { method: "DELETE" });
    const response = await DELETE(request, { params: Promise.resolve({ memberUserId: MEMBER_USER_ID }) });

    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.removeTenantMember).toHaveBeenCalledWith(OWNER, MEMBER_USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ memberUserId: MEMBER_USER_ID });
  });

  it("rejects an invalid member id before resolving CRM access", async () => {
    const request = new Request("https://crm.example.com/api/settings/members/not-a-uuid", { method: "DELETE" });
    const response = await DELETE(request, { params: Promise.resolve({ memberUserId: "not-a-uuid" }) });

    expect(response.status).toBe(400);
    expect(mocks.requireCrmAccess).not.toHaveBeenCalled();
    expect(mocks.removeTenantMember).not.toHaveBeenCalled();
  });
});
