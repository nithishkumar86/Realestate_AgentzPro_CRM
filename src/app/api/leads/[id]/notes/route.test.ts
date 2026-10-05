// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), add: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-timeline-service", () => ({ addLeadNote: mocks.add }));

import { POST } from "./route";

const LEAD = "11111111-1111-4111-8111-111111111111";
const post = (body: unknown) => POST(new Request(`http://localhost/api/leads/${LEAD}/notes`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: LEAD }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
});

describe("POST /api/leads/[id]/notes", () => {
  it("saves the trimmed note for the session's tenant and answers 201", async () => {
    mocks.add.mockResolvedValue({ id: "note-1", createdAt: "2026-10-05T09:00:00+00:00" });
    const response = await post({ body: "  Will visit on Sunday  " });
    expect(response.status).toBe(201);
    expect(mocks.add).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, "11111111-1111-4111-8111-111111111111", "Will visit on Sunday");
  });

  it.each([[{ body: "   " }], [{ body: "x".repeat(2001) }], [{ body: "ok", createdBy: "someone-else" }], [{}]])("rejects %j with 400", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
