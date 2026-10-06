import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  assignLead: vi.fn(),
  resolveTenantRequestContext: vi.fn(),
}));

vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.assertSameOrigin }));
vi.mock("@/lib/server/lead-assignment-service", () => ({ assignLead: mocks.assignLead }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.resolveTenantRequestContext }));

const { PUT } = await import("./route");

const CONTEXT = { tenantId: "tenant-a", userId: "11111111-1111-4111-8111-111111111111" };
const LEAD = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";

function put(id: string, body: unknown) {
  const request = new Request(`https://crm.example.com/api/leads/${id}/assignee`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { request, call: () => PUT(request, { params: Promise.resolve({ id }) }) };
}

describe("PUT /api/leads/[id]/assignee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantRequestContext.mockResolvedValue(CONTEXT);
    mocks.assignLead.mockResolvedValue({ id: LEAD, assignedUserId: PRIYA, assigneeName: "Priya" });
  });

  it("checks the origin and assigns using the tenant and user from the session", async () => {
    const { request, call } = put(LEAD, { assigneeUserId: PRIYA });
    const response = await call();
    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.assignLead).toHaveBeenCalledWith(CONTEXT, LEAD, PRIYA);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: LEAD, assignedUserId: PRIYA, assigneeName: "Priya" });
  });

  it("unassigns with a null assignee", async () => {
    await put(LEAD, { assigneeUserId: null }).call();
    expect(mocks.assignLead).toHaveBeenCalledWith(CONTEXT, LEAD, null);
  });

  it("rejects a malformed lead id before resolving the session", async () => {
    const response = await put("not-a-uuid", { assigneeUserId: PRIYA }).call();
    expect(response.status).toBe(400);
    expect(mocks.resolveTenantRequestContext).not.toHaveBeenCalled();
    expect(mocks.assignLead).not.toHaveBeenCalled();
  });

  it.each([{}, { assigneeUserId: "not-a-uuid" }, { assigneeUserId: PRIYA, tenantId: "tenant-b" }, { assigneeUserId: 5 }])("rejects the body %j (the tenant is never taken from the request)", async (body) => {
    const response = await put(LEAD, body).call();
    expect(response.status).toBe(400);
    expect(mocks.assignLead).not.toHaveBeenCalled();
  });
});
