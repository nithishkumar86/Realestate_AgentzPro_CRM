// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), reschedule: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-timeline-service", () => ({ rescheduleLeadTask: mocks.reschedule, closeLeadTask: mocks.close }));

import { PATCH } from "./route";

const LEAD = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const patch = (body: unknown, taskId = TASK) => PATCH(
  new Request(`http://localhost/api/leads/${LEAD}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  { params: Promise.resolve({ id: LEAD, taskId }) },
);
const ctx = { tenantId: "tenant-a", userId: "user-a" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockResolvedValue(ctx);
});

describe("PATCH /api/leads/[id]/tasks/[taskId]", () => {
  it("reschedules with a new due date", async () => {
    mocks.reschedule.mockResolvedValue({ id: TASK });
    expect((await patch({ dueDate: "2026-10-10" })).status).toBe(200);
    expect(mocks.reschedule).toHaveBeenCalledWith(ctx, LEAD, TASK, "2026-10-10");
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it.each([["complete", "completed"], ["cancel", "cancelled"]])("maps action %s to outcome %s", async (action, outcome) => {
    mocks.close.mockResolvedValue({ id: TASK });
    expect((await patch({ action })).status).toBe(200);
    expect(mocks.close).toHaveBeenCalledWith(ctx, LEAD, TASK, outcome);
  });

  it.each([
    ["both changes at once", { dueDate: "2026-10-10", action: "complete" }],
    ["neither change", {}],
    ["an editable title", { title: "Renamed" }],
    ["a reopen", { action: "reopen" }],
    ["an invalid date", { dueDate: "10/10/2026" }],
  ])("rejects %s with 400", async (_label, body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mocks.reschedule).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("rejects a malformed task id", async () => {
    expect((await patch({ action: "complete" }, "task-1")).status).toBe(400);
  });

  it("passes rescheduling a closed task through as 409 TASK_ALREADY_CLOSED", async () => {
    mocks.reschedule.mockRejectedValue(new AppError("This task is already closed and can no longer be changed.", { status: 409, code: "TASK_ALREADY_CLOSED" }));
    const response = await patch({ dueDate: "2026-10-10" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "TASK_ALREADY_CLOSED" } });
  });
});
