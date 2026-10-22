import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({
  getLeadFormAnswers: vi.fn(),
  resolveTenantRequestContext: vi.fn(),
}));

vi.mock("@/lib/server/lead-query-service", () => ({ getLeadFormAnswers: mocks.getLeadFormAnswers, deleteLead: vi.fn(), updateLeadTriage: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.resolveTenantRequestContext }));

const { GET } = await import("./route");

const CONTEXT = { tenantId: "tenant-a", userId: "11111111-1111-4111-8111-111111111111" };
const LEAD = "22222222-2222-4222-8222-222222222222";

function get(id: string) {
  const request = new Request(`https://crm.example.com/api/leads/${id}`);
  return GET(request, { params: Promise.resolve({ id }) });
}

describe("GET /api/leads/[id] (form answers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantRequestContext.mockResolvedValue(CONTEXT);
  });

  it("returns the lead's form answers for the session's tenant", async () => {
    mocks.getLeadFormAnswers.mockResolvedValue({ answers: [{ name: "budget_range", values: ["70_lakhs"] }] });
    const response = await get(LEAD);
    expect(mocks.getLeadFormAnswers).toHaveBeenCalledWith(CONTEXT, LEAD);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answers: [{ name: "budget_range", values: ["70_lakhs"] }] });
  });

  it("rejects a malformed lead id before resolving the session", async () => {
    const response = await get("not-a-uuid");
    expect(response.status).toBe(400);
    expect(mocks.resolveTenantRequestContext).not.toHaveBeenCalled();
    expect(mocks.getLeadFormAnswers).not.toHaveBeenCalled();
  });

  it("passes on 404 when the lead is not in this tenant", async () => {
    mocks.getLeadFormAnswers.mockRejectedValue(new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" }));
    const response = await get(LEAD);
    expect(response.status).toBe(404);
  });

  it("passes on 401 when there is no signed-in member", async () => {
    mocks.resolveTenantRequestContext.mockRejectedValue(new AppError("Sign in to continue.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await get(LEAD);
    expect(response.status).toBe(401);
    expect(mocks.getLeadFormAnswers).not.toHaveBeenCalled();
  });
});
