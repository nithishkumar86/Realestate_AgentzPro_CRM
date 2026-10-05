// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-timeline-service", () => ({ listLeadActivities: mocks.list }));

import { GET } from "./route";

const LEAD = "11111111-1111-4111-8111-111111111111";
const call = (query: string, id = LEAD) => GET(new Request(`http://localhost/api/leads/${id}/activities${query}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
});

describe("GET /api/leads/[id]/activities", () => {
  it("reads the timeline with the session's tenant, the tab and the cursor", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    const response = await call("?filter=notes&cursor=abc");
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, LEAD, { filter: "notes", cursor: "abc" });
  });

  it("defaults to the All tab", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    await call("");
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), LEAD, { filter: "all" });
  });

  it.each([["?filter=labels"], ["?tenantId=tenant-b"], ["?cursor="]])("rejects an unknown or empty query parameter %s with 400", async (query) => {
    const response = await call(query);
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects a malformed lead id before resolving anything", async () => {
    const response = await call("", "not-a-uuid");
    expect(response.status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("passes a 404 for another tenant's lead through unchanged", async () => {
    mocks.list.mockRejectedValue(new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" }));
    const response = await call("");
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("LEAD_NOT_FOUND");
  });
});
