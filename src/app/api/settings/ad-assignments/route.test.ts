import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  requireCrmAccess: vi.fn(),
  listAdAssignments: vi.fn(),
  setAdAssignmentRule: vi.fn(),
  applyAdAssignmentRule: vi.fn(),
}));

vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.requireCrmAccess }));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/lead-assignment-service", () => ({
  listAdAssignments: mocks.listAdAssignments,
  setAdAssignmentRule: mocks.setAdAssignmentRule,
  applyAdAssignmentRule: mocks.applyAdAssignmentRule,
}));

const { GET } = await import("./route");
const { PUT } = await import("./rule/route");
const { POST } = await import("./apply/route");

const OWNER = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "tenant-a", tenantName: "A", fullName: "Owner", membershipRole: "owner" };
const PRIYA = "33333333-3333-4333-8333-333333333333";

const json = (url: string, method: string, body: unknown) =>
  new Request(`https://crm.example.com${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCrmAccess.mockResolvedValue(OWNER);
});

describe("GET /api/settings/ad-assignments", () => {
  it("returns the overview for the verified access, never cached", async () => {
    mocks.listAdAssignments.mockResolvedValue({ ads: [], members: [] });
    const response = await GET(new Request("https://crm.example.com/api/settings/ad-assignments"));
    expect(mocks.listAdAssignments).toHaveBeenCalledWith(OWNER);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ ads: [], members: [] });
  });
});

describe("PUT /api/settings/ad-assignments/rule", () => {
  it("checks the origin and sets the rule using verified access", async () => {
    mocks.setAdAssignmentRule.mockResolvedValue(undefined);
    const request = json("/api/settings/ad-assignments/rule", "PUT", { adId: " ad-1 ", assigneeUserId: PRIYA });
    const response = await PUT(request);
    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.setAdAssignmentRule).toHaveBeenCalledWith(OWNER, "ad-1", PRIYA);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ adId: "ad-1", assigneeUserId: PRIYA });
  });

  it("clears the rule with a null assignee", async () => {
    mocks.setAdAssignmentRule.mockResolvedValue(undefined);
    await PUT(json("/api/settings/ad-assignments/rule", "PUT", { adId: "ad-1", assigneeUserId: null }));
    expect(mocks.setAdAssignmentRule).toHaveBeenCalledWith(OWNER, "ad-1", null);
  });

  it.each([{}, { adId: "", assigneeUserId: null }, { adId: "ad-1" }, { adId: "ad-1", assigneeUserId: "x" }, { adId: "ad-1", assigneeUserId: null, tenantId: "tenant-b" }])("rejects the body %j", async (body) => {
    const response = await PUT(json("/api/settings/ad-assignments/rule", "PUT", body));
    expect(response.status).toBe(400);
    expect(mocks.setAdAssignmentRule).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/ad-assignments/apply", () => {
  it("checks the origin and returns how many leads were assigned", async () => {
    mocks.applyAdAssignmentRule.mockResolvedValue({ assigned: 5 });
    const request = json("/api/settings/ad-assignments/apply", "POST", { adId: "ad-1" });
    const response = await POST(request);
    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.applyAdAssignmentRule).toHaveBeenCalledWith(OWNER, "ad-1");
    expect(await response.json()).toEqual({ assigned: 5 });
  });

  it.each([{}, { adId: "" }, { adId: "ad-1", extra: true }])("rejects the body %j", async (body) => {
    const response = await POST(json("/api/settings/ad-assignments/apply", "POST", body));
    expect(response.status).toBe(400);
    expect(mocks.applyAdAssignmentRule).not.toHaveBeenCalled();
  });
});
