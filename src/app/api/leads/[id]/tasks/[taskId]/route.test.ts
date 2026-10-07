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
  it("reschedules to a new due date and time", async () => {
    mocks.reschedule.mockResolvedValue({ id: TASK });
    expect((await patch({ dueDate: "2026-10-10", dueTime: "09:30" })).status).toBe(200);
    expect(mocks.reschedule).toHaveBeenCalledWith(ctx, LEAD, TASK, { dueDate: "2026-10-10", dueTime: "09:30" });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("accepts a previous-build body (date only): due at the end of that day", async () => {
    mocks.reschedule.mockResolvedValue({ id: TASK });
    expect((await patch({ dueDate: "2026-10-10" })).status).toBe(200);
    expect(mocks.reschedule).toHaveBeenCalledWith(ctx, LEAD, TASK, { dueDate: "2026-10-10", dueTime: "23:59" });
  });

  it.each([["complete", "completed"], ["cancel", "cancelled"]])("maps action %s to outcome %s", async (action, outcome) => {
    mocks.close.mockResolvedValue({ task: { id: TASK }, nextTask: null });
    expect((await patch({ action })).status).toBe(200);
    expect(mocks.close).toHaveBeenCalledWith(ctx, LEAD, TASK, outcome);
  });

  it("returns the next occurrence of a repeating task beside the closed task", async () => {
    mocks.close.mockResolvedValue({ task: { id: TASK }, nextTask: { id: "next" } });
    const body = await (await patch({ action: "complete" })).json();
    expect(body).toMatchObject({ id: TASK, nextTask: { id: "next" } });
  });

  it.each([
    ["both changes at once", { dueDate: "2026-10-10", action: "complete" }],
    ["neither change", {}],
    ["an editable title", { title: "Renamed" }],
    ["a reopen", { action: "reopen" }],
    ["an invalid date", { dueDate: "10/10/2026" }],
    ["an invalid time", { dueDate: "2026-10-10", dueTime: "25:00" }],
    ["a time without a date", { dueTime: "09:30" }],
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

  it("passes a past due time through as 422 DUE_IN_PAST", async () => {
    mocks.reschedule.mockRejectedValue(new AppError("Pick a due time later than now.", { status: 422, code: "DUE_IN_PAST" }));
    const response = await patch({ dueDate: "2026-10-01", dueTime: "09:00" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "DUE_IN_PAST" } });
  });
});
