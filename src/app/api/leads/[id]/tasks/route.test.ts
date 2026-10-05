// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), create: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-timeline-service", () => ({ createLeadTask: mocks.create, getOpenLeadTask: mocks.open }));

import { GET, POST } from "./route";

const LEAD = "11111111-1111-4111-8111-111111111111";
const params = () => ({ params: Promise.resolve({ id: LEAD }) });
const post = (body: unknown) => POST(new Request(`http://localhost/api/leads/${LEAD}/tasks`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), params());
const valid = { title: " Call back ", description: "  ", startDate: "2026-10-05", dueDate: "2026-10-08" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
});

describe("/api/leads/[id]/tasks", () => {
  it("returns the open task (or null) for the session's tenant", async () => {
    mocks.open.mockResolvedValue(null);
    const response = await GET(new Request(`http://localhost/api/leads/${LEAD}/tasks`), params());
    expect(await response.json()).toEqual({ openTask: null });
    expect(mocks.open).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, LEAD);
  });

  it("creates a task with trimmed text and a blank description stored as null", async () => {
    mocks.create.mockResolvedValue({ id: "task-1" });
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, LEAD, { title: "Call back", description: null, startDate: "2026-10-05", dueDate: "2026-10-08" });
  });

  it.each([
    ["no title", { ...valid, title: "  " }],
    ["due before start", { ...valid, dueDate: "2026-10-01" }],
    ["impossible date", { ...valid, startDate: "2026-02-30" }],
    ["missing due date", { title: "x", startDate: "2026-10-05" }],
    ["description too long", { ...valid, description: "x".repeat(2001) }],
    ["unknown field", { ...valid, status: "completed" }],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes the one-open-task conflict through as 409 with its message", async () => {
    mocks.create.mockRejectedValue(new AppError("This lead already has an open task. Complete or cancel it before adding a new one.", { status: 409, code: "OPEN_TASK_EXISTS" }));
    const response = await post(valid);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "OPEN_TASK_EXISTS", message: "This lead already has an open task. Complete or cancel it before adding a new one." } });
  });
});
