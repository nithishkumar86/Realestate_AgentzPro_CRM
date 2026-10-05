// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLeadNote, closeLeadTask, createLeadTask, decodeActivityCursor, encodeActivityCursor, getOpenLeadTask,
  listLeadActivities, rescheduleLeadTask,
} from "@/lib/server/lead-timeline-service";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

type Result = { data: unknown; error: unknown };

function builder(result: Result) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "or", "order", "limit", "insert"]) query[method] = vi.fn(() => query);
  query.single = vi.fn(() => Promise.resolve(result));
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)) });
}

const context = { tenantId: "tenant-a", userId: "user-a" };
const LEAD = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";

function activity(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, type: "status_change", summary: "Status: New Lead → Working", metadata: { old: "New Lead", new: "Working" }, created_by: ACTOR, created_at: createdAt, ...extra };
}

/** Wires every table to its own builder so each query can be asserted separately. */
function tables(results: Partial<Record<"lead_data" | "lead_activities" | "profiles" | "lead_notes" | "lead_tasks", Result>>) {
  const built = Object.fromEntries(Object.entries(results).map(([table, result]) => [table, builder(result)]));
  mocks.from.mockImplementation((table: string) => {
    if (!built[table]) throw new Error(`Unexpected table ${table}`);
    return built[table];
  });
  return built;
}

beforeEach(() => vi.resetAllMocks());

describe("activity cursor", () => {
  it("round-trips a microsecond timestamp byte-for-byte (never through a JS Date)", () => {
    const createdAt = "2026-10-05T09:31:12.123456+00:00";
    expect(decodeActivityCursor(encodeActivityCursor(createdAt, TASK))).toEqual({ createdAt, id: TASK });
  });

  it.each([
    ["not base64url", "abc$%"],
    ["missing separator", Buffer.from(`2026-10-05T09:31:12.123456+00:00${TASK}`).toString("base64url")],
    ["bad timestamp", Buffer.from(`2026-10-05 09:31|${TASK}`).toString("base64url")],
    ["bad uuid", Buffer.from("2026-10-05T09:31:12.123456+00:00|not-a-uuid").toString("base64url")],
    ["filter syntax smuggled in", Buffer.from(`2026-10-05T09:31:12+00:00),id.gt.(0|${TASK}`).toString("base64url")],
    ["comma in id", Buffer.from(`2026-10-05T09:31:12+00:00|${TASK},x`).toString("base64url")],
    ["extra field", Buffer.from(`2026-10-05T09:31:12+00:00|${TASK}|x`).toString("base64url")],
  ])("rejects a cursor with %s as 400 INVALID_CURSOR", (_label, cursor) => {
    expect(() => decodeActivityCursor(cursor)).toThrow(expect.objectContaining({ status: 400, code: "INVALID_CURSOR" }));
  });
});

describe("listLeadActivities", () => {
  it("is tenant- and lead-scoped, newest first, and names actors (System, member, former member)", async () => {
    const built = tables({
      lead_data: { data: { id: LEAD }, error: null },
      lead_activities: { data: [
        activity("a3", "2026-10-05T10:00:00.000003+00:00"),
        activity("a2", "2026-10-05T09:00:00+00:00", { created_by: "55555555-5555-4555-8555-555555555555" }),
        activity("a1", "2026-10-01T09:00:00+00:00", { type: "lead_created", summary: "Lead created · Status: New Lead", metadata: { status: "New Lead", backfilled: true }, created_by: null }),
      ], error: null },
      profiles: { data: [{ user_id: ACTOR, full_name: "Priya" }], error: null },
    });
    const page = await listLeadActivities(context, LEAD);
    expect(built.lead_data.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(built.lead_activities.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(built.lead_activities.eq).toHaveBeenCalledWith("lead_id", LEAD);
    expect(built.lead_activities.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(built.lead_activities.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(built.lead_activities.limit).toHaveBeenCalledWith(21);
    expect(built.lead_activities.in).not.toHaveBeenCalled();
    expect(page.items.map((item) => item.actorName)).toEqual(["Priya", "Former team member", "System"]);
    expect(page.items.map((item) => item.backfilled)).toEqual([false, false, true]);
    expect(page.nextCursor).toBeNull();
  });

  it("returns a cursor from the raw created_at of the last row when more rows exist", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => activity(`0000000${index}-0000-4000-8000-000000000000`, `2026-10-05T09:00:00.00000${index}+00:00`, { created_by: null }));
    tables({ lead_data: { data: { id: LEAD }, error: null }, lead_activities: { data: rows, error: null } });
    const page = await listLeadActivities(context, LEAD, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(decodeActivityCursor(page.nextCursor!)).toEqual({ createdAt: "2026-10-05T09:00:00.000001+00:00", id: rows[1].id });
  });

  it("applies the cursor as a quoted keyset predicate and the tab as a type filter", async () => {
    const built = tables({ lead_data: { data: { id: LEAD }, error: null }, lead_activities: { data: [], error: null } });
    const cursor = encodeActivityCursor("2026-10-05T09:31:12.123456+00:00", TASK);
    await listLeadActivities(context, LEAD, { filter: "tasks", cursor });
    expect(built.lead_activities.in).toHaveBeenCalledWith("type", ["task_created", "task_rescheduled", "task_completed", "task_cancelled"]);
    expect(built.lead_activities.or).toHaveBeenCalledWith(`created_at.lt."2026-10-05T09:31:12.123456+00:00",and(created_at.eq."2026-10-05T09:31:12.123456+00:00",id.lt.${TASK})`);
  });

  it("maps the Status tab to lead_created + status_change", async () => {
    const built = tables({ lead_data: { data: { id: LEAD }, error: null }, lead_activities: { data: [], error: null } });
    await listLeadActivities(context, LEAD, { filter: "status" });
    expect(built.lead_activities.in).toHaveBeenCalledWith("type", ["lead_created", "status_change"]);
  });

  it("attaches the full note body to note_added rows", async () => {
    const built = tables({
      lead_data: { data: { id: LEAD }, error: null },
      lead_activities: { data: [activity("n1", "2026-10-05T09:00:00+00:00", { type: "note_added", summary: "short…", metadata: { note_id: NOTE } })], error: null },
      profiles: { data: [{ user_id: ACTOR, full_name: "Priya" }], error: null },
      lead_notes: { data: [{ id: NOTE, body: "The whole note text." }], error: null },
    });
    const page = await listLeadActivities(context, LEAD);
    expect(page.items[0].noteBody).toBe("The whole note text.");
    expect(built.lead_notes.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("answers 404 for a lead of another tenant without reading its timeline", async () => {
    const built = tables({ lead_data: { data: null, error: null }, lead_activities: { data: [], error: null } });
    await expect(listLeadActivities(context, LEAD)).rejects.toMatchObject({ status: 404, code: "LEAD_NOT_FOUND" });
    expect(built.lead_activities.select).not.toHaveBeenCalled();
  });

  it("rejects an invalid cursor before any query", async () => {
    await expect(listLeadActivities(context, LEAD, { cursor: "%%%" })).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("notes", () => {
  it("writes the note for the session's tenant and user", async () => {
    const built = tables({ lead_notes: { data: { id: NOTE, created_at: "2026-10-05T09:00:00+00:00" }, error: null } });
    await addLeadNote(context, LEAD, "Called, will visit Sunday");
    expect(built.lead_notes.insert).toHaveBeenCalledWith({ tenant_id: "tenant-a", lead_id: LEAD, body: "Called, will visit Sunday", created_by: "user-a" });
  });

  it("maps a foreign-key miss (another tenant's lead) to 404", async () => {
    tables({ lead_notes: { data: null, error: { code: "23503" } } });
    await expect(addLeadNote(context, LEAD, "x")).rejects.toMatchObject({ status: 404, code: "LEAD_NOT_FOUND" });
  });
});

describe("tasks", () => {
  const taskRow = { id: TASK, title: "Call back", description: null, start_date: "2026-10-05", due_date: "2026-10-08", status: "open", closed_at: null, created_at: "2026-10-05T09:00:00+00:00" };

  it("creates the task for the session's tenant and user", async () => {
    const built = tables({ lead_tasks: { data: taskRow, error: null } });
    const task = await createLeadTask(context, LEAD, { title: "Call back", description: null, startDate: "2026-10-05", dueDate: "2026-10-08" });
    expect(built.lead_tasks.insert).toHaveBeenCalledWith({ tenant_id: "tenant-a", lead_id: LEAD, title: "Call back", description: null, start_date: "2026-10-05", due_date: "2026-10-08", created_by: "user-a" });
    expect(task).toMatchObject({ id: TASK, startDate: "2026-10-05", dueDate: "2026-10-08", status: "open" });
  });

  it.each([
    ["23505", 409, "OPEN_TASK_EXISTS"],
    ["23503", 404, "LEAD_NOT_FOUND"],
    ["23514", 400, "INVALID_TASK_DATES"],
    ["XX000", 500, "TASK_SAVE_FAILED"],
  ])("maps create error %s to %i %s", async (code, status, appCode) => {
    tables({ lead_tasks: { data: null, error: { code } } });
    await expect(createLeadTask(context, LEAD, { title: "t", description: null, startDate: "2026-10-05", dueDate: "2026-10-05" })).rejects.toMatchObject({ status, code: appCode });
  });

  it("reschedules through the RPC with the session's tenant and actor", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ...taskRow, due_date: "2026-10-10" }], error: null });
    const task = await rescheduleLeadTask(context, LEAD, TASK, "2026-10-10");
    expect(mocks.rpc).toHaveBeenCalledWith("reschedule_lead_task", { p_tenant_id: "tenant-a", p_lead_id: LEAD, p_task_id: TASK, p_due_date: "2026-10-10", p_actor_user_id: "user-a" });
    expect(task.dueDate).toBe("2026-10-10");
  });

  it("reports rescheduling a closed task as 409 TASK_ALREADY_CLOSED", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "55000" } });
    await expect(rescheduleLeadTask(context, LEAD, TASK, "2026-10-10")).rejects.toMatchObject({ status: 409, code: "TASK_ALREADY_CLOSED" });
  });

  it.each([
    ["55000", 409, "TASK_ALREADY_CLOSED"],
    ["23514", 400, "INVALID_TASK_DATES"],
    ["42501", 403, "TASK_UPDATE_FORBIDDEN"],
    ["22023", 400, "INVALID_REQUEST"],
  ])("maps close error %s to %i %s", async (code, status, appCode) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code } });
    await expect(closeLeadTask(context, LEAD, TASK, "completed")).rejects.toMatchObject({ status, code: appCode });
  });

  it("closes through the RPC and answers 404 when no task matched", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await expect(closeLeadTask(context, LEAD, TASK, "cancelled")).rejects.toMatchObject({ status: 404, code: "TASK_NOT_FOUND" });
    expect(mocks.rpc).toHaveBeenCalledWith("close_lead_task", { p_tenant_id: "tenant-a", p_lead_id: LEAD, p_task_id: TASK, p_outcome: "cancelled", p_actor_user_id: "user-a" });
  });

  it("reads only the open task of a lead in the session's tenant", async () => {
    const built = tables({ lead_data: { data: { id: LEAD }, error: null }, lead_tasks: { data: taskRow, error: null } });
    expect(await getOpenLeadTask(context, LEAD)).toMatchObject({ id: TASK });
    expect(built.lead_tasks.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(built.lead_tasks.eq).toHaveBeenCalledWith("status", "open");
  });
});
