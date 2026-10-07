import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsPageClient } from "@/features/leads/leads-page-client";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/features/dashboard/navigation", () => ({ goToLogin: vi.fn(), reloadPage: vi.fn() }));

const LEAD_1 = "11111111-1111-4111-8111-111111111111";
const LEAD_2 = "22222222-2222-4222-8222-222222222222";
const LEAD_3 = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";

type Lead = { id: string; leadName: string; phone: string; facebookPage: string; adName: string; leadDate: string; status: string; label: string; labelSource: string; hasOpenTask: boolean; assignedUserId?: string | null; assigneeName?: string | null };
const lead = (id: string, leadName: string, extra: Partial<Lead> = {}): Lead => ({ id, leadName, phone: "9999999999", facebookPage: "Chennai Homes", adName: "karuvi", leadDate: "2026-10-01T05:00:00Z", status: "New Lead", label: "Warm", labelSource: "default", hasOpenTask: false, ...extra });

type Activity = { id: string; type: string; summary: string; metadata: Record<string, unknown>; actorName: string; createdAt: string; backfilled: boolean; noteBody?: string };
const act = (id: string, type: string, summary: string, extra: Partial<Activity> = {}): Activity => ({ id, type, summary, metadata: {}, actorName: "Priya", createdAt: "2026-10-05T04:00:00.123456+00:00", backfilled: false, ...extra });

const openTask = { id: TASK, title: "Call back", description: "Confirm the site visit slot", startDate: "2026-10-05", dueDate: "2026-10-08", status: "open", closedAt: null, createdAt: "2026-10-05T04:00:00+00:00" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface ApiState {
  leads: Lead[];
  pages: Record<string, { items: Activity[]; nextCursor: string | null }>;
  openTask: typeof openTask | null;
  createTaskConflict?: boolean;
  assignees?: Array<{ userId: string; fullName: string }>;
  failAssign?: boolean;
  failStatus?: boolean;
  failNote?: boolean;
}

/** One router for every endpoint the leads page and the drawer call; records each request. */
function stubApi(state: ApiState) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/leads/filters")) return json({ pages: [], ads: [], defaultAdId: null, assignees: state.assignees ?? [] });
    if (url === "/api/leads/query") return json({ items: state.leads, total: state.leads.length, timezone: "Asia/Kolkata" });
    const activities = /^\/api\/leads\/[^/]+\/activities\?(.*)$/.exec(url);
    if (activities) {
      const params = new URLSearchParams(activities[1]);
      return json(state.pages[`${params.get("filter")}:${params.get("cursor") ?? ""}`] ?? { items: [], nextCursor: null });
    }
    if (/^\/api\/leads\/[^/]+\/tasks$/.test(url)) {
      if (method === "GET") return json({ openTask: state.openTask });
      if (state.createTaskConflict) return json({ error: { code: "OPEN_TASK_EXISTS", message: "This lead already has an open task. Complete or cancel it before adding a new one." } }, 409);
      state.openTask = { ...openTask, title: String(body?.title), startDate: String(body?.startDate), dueDate: String(body?.dueDate) };
      return json(state.openTask, 201);
    }
    if (/^\/api\/leads\/[^/]+\/tasks\/[^/]+$/.test(url)) {
      if (body && "action" in body) { const closed = { ...openTask, status: body.action === "complete" ? "completed" : "cancelled" }; state.openTask = null; return json(closed); }
      state.openTask = { ...openTask, dueDate: String(body?.dueDate) };
      return json(state.openTask);
    }
    if (/^\/api\/leads\/[^/]+\/notes$/.test(url) && state.failNote) return json({ error: { code: "NOTE_SAVE_FAILED", message: "The note could not be saved." } }, 500);
    if (/^\/api\/leads\/[^/]+\/notes$/.test(url)) return json({ id: "note-1", createdAt: "2026-10-05T04:00:00+00:00" }, 201);
    const assignRoute = /^\/api\/leads\/([^/]+)\/assignee$/.exec(url);
    if (assignRoute && method === "PUT") {
      if (state.failAssign) return json({ error: { code: "INVALID_ASSIGNEE", message: "Choose an active member of this company." } }, 400);
      const assignedUserId = (body?.assigneeUserId as string | null) ?? null;
      return json({ id: assignRoute[1], assignedUserId, assigneeName: state.assignees?.find((member) => member.userId === assignedUserId)?.fullName ?? null });
    }
    const patchLead = /^\/api\/leads\/([^/]+)$/.exec(url);
    if (patchLead && method === "PATCH" && state.failStatus) return json({ error: { code: "UPDATE_FAILED", message: "The status could not be updated." } }, 500);
    if (patchLead && method === "PATCH") return json({ id: patchLead[1], status: body?.status, label: "Warm", labelSource: "default" });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
  return calls;
}

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  emit(type: string, data: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) }); }
}

async function renderPage() {
  render(<LeadsPageClient />);
  await screen.findByRole("button", { name: "Open details for Kumar" });
}

async function openDrawer(name = "Kumar") {
  fireEvent.click(screen.getByRole("button", { name: `Open details for ${name}` }));
  return screen.findByRole("dialog", { name });
}

const patches = (calls: ReturnType<typeof stubApi>) => calls.filter((call) => call.method === "PATCH" && call.url === `/api/leads/${LEAD_1}`).map((call) => call.body);
const activityCalls = (calls: ReturnType<typeof stubApi>) => calls.filter((call) => call.url.includes("/activities"));

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("no open task marker in the leads table", () => {
  it("shows only for an active lead without a task, never for a lead with a task or in a final status", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar"), lead(LEAD_2, "Anitha", { hasOpenTask: true }), lead(LEAD_3, "Ravi", { status: "Sale" })], pages: {}, openTask: null });
    await renderPage();
    const rowOf = (name: string) => screen.getByRole("button", { name: `Open details for ${name}` }).closest("tr")!;
    expect(within(rowOf("Kumar")).getByText("No task")).toBeInTheDocument();
    expect(within(rowOf("Anitha")).queryByText("No task")).not.toBeInTheDocument();
    expect(within(rowOf("Ravi")).queryByText("No task")).not.toBeInTheDocument();
  });
});

describe("resizing the drawer", () => {
  const widthOf = (drawer: HTMLElement) => drawer.style.width;
  // jsdom has no PointerEvent, so a fired pointer event would arrive without its position and button.
  beforeEach(() => {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  });

  it("widens when the left edge is dragged left, narrows back and never goes below the default", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null });
    await renderPage();
    const drawer = await openDrawer();
    const handle = within(document.body).getByRole("separator", { name: /resize lead details/i });
    expect(widthOf(drawer)).toBe("min(520px, 100vw)");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    expect(widthOf(drawer)).toBe("min(720px, 100vw)");
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(widthOf(drawer)).toBe("min(520px, 100vw)");
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });
    expect(widthOf(drawer)).toBe("min(760px, 100vw)");
    expect(document.body.classList.contains("mvp-drawer-resizing")).toBe(false);
  });

  it("can be resized with the arrow keys and reset with a double click", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null });
    await renderPage();
    const drawer = await openDrawer();
    const handle = within(document.body).getByRole("separator", { name: /resize lead details/i });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthOf(drawer)).toBe("min(600px, 100vw)");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.doubleClick(handle);
    expect(widthOf(drawer)).toBe("min(520px, 100vw)");
  });

  it("opens at the default width every time, even after it was expanded and closed", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null });
    await renderPage();
    const drawer = await openDrawer();
    const handle = within(document.body).getByRole("separator", { name: /resize lead details/i });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });
    expect(widthOf(drawer)).toBe("min(760px, 100vw)");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(widthOf(await openDrawer())).toBe("min(520px, 100vw)");
  });
});

describe("lead drawer timeline", () => {
  it("opens from the lead name and shows entries oldest first (latest at the bottom) with actor, note text and the backfill hint", async () => {
    stubApi({
      leads: [lead(LEAD_1, "Kumar")],
      openTask: null,
      pages: { "all:": { nextCursor: null, items: [
        act("a3", "note_added", "Will visit Sunday", { noteBody: "Will visit Sunday with family" }),
        act("a2", "status_change", "Status: New Lead → Working"),
        act("a1", "lead_created", "Lead created · Status: New Lead", { actorName: "System", backfilled: true }),
      ] } },
    });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Status: New Lead → Working");
    const items = within(within(drawer).getByRole("tabpanel")).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".mvp-timeline__summary")?.textContent)).toEqual(["Lead created · Status: New Lead", "Status: New Lead → Working", "Note added"]);
    expect(within(drawer).getByText("Will visit Sunday with family")).toBeInTheDocument();
    expect(within(items[0]).getByText("System")).toBeInTheDocument();
    expect(within(drawer).getByText("Earlier history wasn't recorded.")).toBeInTheDocument();
  });

  it("filters by tab and shows an empty state for a tab with no entries", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: { "all:": { items: [act("a1", "lead_created", "Lead created · Status: New Lead")], nextCursor: null } } });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Lead created · Status: New Lead");
    fireEvent.click(within(drawer).getByRole("tab", { name: "Notes" }));
    await within(drawer).findByText("No notes yet. Add the first one above.");
    expect(activityCalls(calls).at(-1)?.url).toBe(`/api/leads/${LEAD_1}/activities?filter=notes`);
  });

  it("loads older entries with the server cursor", async () => {
    const calls = stubApi({
      leads: [lead(LEAD_1, "Kumar")],
      openTask: null,
      pages: {
        "all:": { items: [act("a2", "status_change", "Status: New Lead → Working")], nextCursor: "CURSOR1" },
        "all:CURSOR1": { items: [act("a1", "lead_created", "Lead created · Status: New Lead")], nextCursor: null },
      },
    });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Load more" }));
    await within(drawer).findByText("Lead created · Status: New Lead");
    expect(within(drawer).getByText("Status: New Lead → Working")).toBeInTheDocument();
    expect(activityCalls(calls).at(-1)?.url).toBe(`/api/leads/${LEAD_1}/activities?filter=all&cursor=CURSOR1`);
    expect(within(drawer).queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("refreshes when the live stream reports activity on this lead, and ignores other leads", async () => {
    const state: ApiState = { leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: { "all:": { items: [act("a1", "lead_created", "Lead created · Status: New Lead")], nextCursor: null } } };
    const calls = stubApi(state);
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Lead created · Status: New Lead");
    const stream = FakeEventSource.instances.at(-1)!;
    expect(stream.url).toBe("/api/dashboard/stream");
    const before = activityCalls(calls).length;

    stream.emit("activity", { leadId: LEAD_2 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(activityCalls(calls)).toHaveLength(before);

    state.pages["all:"] = { items: [act("a2", "status_change", "Status: New Lead → Working", { actorName: "Anitha" }), ...state.pages["all:"].items], nextCursor: null };
    stream.emit("activity", { leadId: LEAD_1 });
    await within(drawer).findByText("Status: New Lead → Working", {}, { timeout: 2000 });
    expect(within(drawer).getByText("Anitha")).toBeInTheDocument();
  });

  it("closes the live stream when the drawer closes", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    await openDrawer();
    const stream = FakeEventSource.instances.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: "Close lead details" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe("lead drawer notes and tasks", () => {
  it("saves a note and refreshes the timeline", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: "  Asked for brochure  " } });
    const before = activityCalls(calls).length;
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.some((call) => call.url === `/api/leads/${LEAD_1}/notes` && call.body?.body === "Asked for brochure")).toBe(true));
    await waitFor(() => expect(activityCalls(calls).length).toBeGreaterThan(before));
    expect((within(drawer).getByLabelText("Add a note") as HTMLTextAreaElement).value).toBe("");
  });

  it("hides the add form while a task is open, and asks before cancelling it", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true, status: "Working" })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    expect(within(drawer).queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("05 Oct 2026 → 08 Oct 2026")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel task" }));
    expect(confirmSpy).toHaveBeenCalledWith('Cancel "Call back"? This cannot be undone.');
    expect(calls.some((call) => call.url.includes("/tasks/"))).toBe(false);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel task" }));
    await within(drawer).findByText("Add next task or close the lead");
    expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ action: "cancel" });
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeInTheDocument();
    // The table marker updates without a reload.
    const row = screen.getByRole("button", { name: "Open details for Kumar" }).closest("tr")!;
    expect(within(row).getByText("No task")).toBeInTheDocument();
  });

  it("creates a task with the form fields and clears the next-step prompt", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    expect(within(drawer).getByLabelText(/Description/)).toHaveAttribute("placeholder", "What needs to be done between the start and due dates");
    fireEvent.change(await within(drawer).findByLabelText("Title"), { target: { value: "Site visit" } });
    fireEvent.change(within(drawer).getByLabelText("Start date"), { target: { value: "2026-10-06" } });
    fireEvent.change(within(drawer).getByLabelText("Due date"), { target: { value: "2026-10-09" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toEqual({ title: "Site visit", description: null, startDate: "2026-10-06", dueDate: "2026-10-09" });
  });

  it("shows the server's message when another open task already exists", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, createTaskConflict: true, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.change(await within(drawer).findByLabelText("Title"), { target: { value: "Site visit" } });
    fireEvent.change(within(drawer).getByLabelText("Due date"), { target: { value: "2099-01-01" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByText("This lead already has an open task. Complete or cancel it before adding a new one.");
  });

  it("reschedules only the due date", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Reschedule" }));
    const input = within(drawer).getByLabelText("New due date");
    expect(input).toHaveAttribute("min", "2026-10-05");
    fireEvent.change(input, { target: { value: "2026-10-12" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save date" }));
    await within(drawer).findByText("05 Oct 2026 → 12 Oct 2026");
    expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ dueDate: "2026-10-12" });
  });
});

const stepState = (drawer: HTMLElement) => within(within(drawer).getByRole("list", { name: "After every call" })).getAllByRole("listitem")
  .map((item) => item.hasAttribute("data-done") ? "done" : item.hasAttribute("data-current") ? "current" : "todo");

describe("lead drawer: step 1, 2, 3", () => {
  const LOCK_TEXT = "Do step 1 first: change the status above. Then you can add a task.";

  it("locks the task form while the lead is New Lead, keeps notes open, and starts with no ticks", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText(LOCK_TEXT);
    expect(within(drawer).queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(within(drawer).queryByLabelText("Title")).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText("Add a note")).toBeEnabled();
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
  });

  it("unlocks the task form and ticks step 1 once the status is saved, then ticks step 2 and step 3 as each is saved", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText(LOCK_TEXT);

    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Working" }));
    await within(drawer).findByRole("button", { name: "Add task" });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(within(drawer).queryByText(LOCK_TEXT)).not.toBeInTheDocument();
    expect(stepState(drawer)).toEqual(["done", "current", "todo"]);

    fireEvent.change(within(drawer).getByLabelText("Title"), { target: { value: "Site visit" } });
    fireEvent.change(within(drawer).getByLabelText("Due date"), { target: { value: "2099-01-01" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(stepState(drawer)).toEqual(["done", "done", "current"]);

    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: "Asked for brochure" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(stepState(drawer)).toEqual(["done", "done", "done"]));
    expect(within(drawer).getByText("Step 3 done")).toBeInTheDocument();
  });

  it("saves nothing when a status is chosen: it stays pending, with a hint, until a task or a note is saved", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Working" }));
    await within(drawer).findByRole("button", { name: "Add task" });
    expect(within(drawer).getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
    expect(within(drawer).getByText("Not saved yet. Add a task or a note to save it.")).toBeInTheDocument();
    expect(patches(calls)).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(patches(calls)).toEqual([]);
    expect(screen.getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("New Lead");
  });

  it("takes the step 1 tick back, and locks the task form again, when the lead is moved back to New Lead", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByRole("button", { name: "Add task" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Sale" }));
    await waitFor(() => expect(stepState(drawer)).toEqual(["done", "current", "todo"]));
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "New Lead" }));
    await within(drawer).findByText(LOCK_TEXT);
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
    expect(within(drawer).queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  });

  it("starts every visit with empty ticks, even for a lead already past New Lead, and leaves its task form open", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByRole("button", { name: "Add task" });
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
  });

  it("still shows Mark complete, Reschedule and Cancel for an open task on a New Lead, and a reschedule does not tick step 2", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    expect(await within(drawer).findByRole("button", { name: "Mark complete" })).toBeEnabled();
    expect(within(drawer).getByRole("button", { name: "Reschedule" })).toBeEnabled();
    expect(within(drawer).getByRole("button", { name: "Cancel task" })).toBeEnabled();
    expect(within(drawer).queryByText(LOCK_TEXT)).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Reschedule" }));
    fireEvent.change(within(drawer).getByLabelText("New due date"), { target: { value: "2026-10-12" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save date" }));
    await within(drawer).findByText("05 Oct 2026 \u2192 12 Oct 2026");
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
  });
});

describe("moving a lead to a final status with an open task", () => {
  it("from the drawer: a note saves first, then the status, then the open task is offered for cancelling", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Sale" }));
    expect(patches(calls)).toEqual([]);
    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: "Booked" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ action: "cancel" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith('This lead is now "Sale" but still has an open task "Call back". Cancel the task now?');
    const writes = calls.filter((call) => call.method !== "GET" && call.url !== "/api/leads/query").map((call) => `${call.method} ${call.url.replace(LEAD_1, ":id")}`);
    expect(writes.slice(0, 2)).toEqual(["POST /api/leads/:id/notes", "PATCH /api/leads/:id"]);
    expect(patches(calls)).toEqual([{ status: "Sale" }]);
  });

  it("from the table: keeps the task when the telecaller declines", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Closed" }));
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("Call back");
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: "Not interested" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenLastCalledWith('This lead is now "Closed" but still has an open task "Call back". Cancel the task now?');
    expect(patches(calls)).toEqual([{ status: "Closed" }]);
    expect(calls.some((call) => call.url.includes("/tasks/"))).toBe(false);
  });

  it("from the table: does not ask when the lead has no open task", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Disqualified" }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: "Wrong number" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(patches(calls)).toEqual([{ status: "Disqualified" }]));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith("/tasks") && call.method === "POST")).toBe(false);
  });
});

describe("a status is saved only together with a task or a note", () => {
  async function changeInTable(status: string) {
    fireEvent.click(screen.getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: status }));
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByRole("button", { name: "Add task" });
    return drawer;
  }
  const writesOf = (calls: ReturnType<typeof stubApi>) => calls.filter((call) => call.method !== "GET" && call.url !== "/api/leads/query").map((call) => `${call.method} ${call.url.replace(LEAD_1, ":id")}`);
  const saveNote = (drawer: HTMLElement, text = "Asked for brochure") => {
    fireEvent.change(within(drawer).getByLabelText("Add a note"), { target: { value: text } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save note" }));
  };

  it("choosing a status in the table saves nothing: the drawer opens with it pending and the row keeps the saved status", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    await renderPage();
    const drawer = await changeInTable("Working");
    expect(within(drawer).getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
    expect(within(drawer).getByText("Not saved yet. Add a task or a note to save it.")).toBeInTheDocument();
    expect(stepState(drawer)).toEqual(["done", "current", "todo"]);
    expect(writesOf(calls)).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["the X button", () => { fireEvent.click(screen.getByRole("button", { name: "Close lead details" })); }],
    ["the backdrop", () => { fireEvent.pointerDown(document.querySelector(".mvp-lead-drawer-backdrop") as Element); }],
    ["Escape", () => { fireEvent.keyDown(document, { key: "Escape" }); }],
  ])("closing with %s drops the choice and writes nothing at all", async (_name, close) => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    await changeInTable("Working");
    close();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writesOf(calls)).toEqual([]);
    expect(screen.getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("New Lead");
  });

  it("a note is saved first, then the status; the row and the hint then show it as saved", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    const drawer = await changeInTable("Working");
    saveNote(drawer);
    await waitFor(() => expect(patches(calls)).toEqual([{ status: "Working" }]));
    expect(writesOf(calls)).toEqual(["POST /api/leads/:id/notes", "PATCH /api/leads/:id"]);
    await waitFor(() => expect(within(drawer).queryByText("Not saved yet. Add a task or a note to save it.")).not.toBeInTheDocument());
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    expect(screen.getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
  });

  it("a task is created and the status saved in one request, with no separate status call", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    const drawer = await changeInTable("Working");
    fireEvent.change(within(drawer).getByLabelText("Title"), { target: { value: "Site visit" } });
    fireEvent.change(within(drawer).getByLabelText("Due date"), { target: { value: "2099-01-01" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(writesOf(calls)).toEqual(["POST /api/leads/:id/tasks"]);
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toMatchObject({ title: "Site visit", status: "Working" });
    expect(patches(calls)).toEqual([]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    expect(screen.getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
  });

  it("sends no status with a task when none is pending", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByRole("button", { name: "Add task" });
    fireEvent.change(within(drawer).getByLabelText("Title"), { target: { value: "Site visit" } });
    fireEvent.change(within(drawer).getByLabelText("Due date"), { target: { value: "2099-01-01" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).not.toHaveProperty("status");
  });

  it("completing the open task saves the pending status after it", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Working" }));
    expect(patches(calls)).toEqual([]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Mark complete" }));
    await waitFor(() => expect(patches(calls)).toEqual([{ status: "Working" }]));
    expect(writesOf(calls).slice(0, 2)).toEqual([`PATCH /api/leads/:id/tasks/${TASK}`, "PATCH /api/leads/:id"]);
  });

  it("when the note fails, no status is saved and the choice stays pending", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {}, failNote: true });
    await renderPage();
    const drawer = await changeInTable("Working");
    saveNote(drawer);
    await within(drawer).findByText("The note could not be saved.");
    expect(patches(calls)).toEqual([]);
    expect(within(drawer).getByText("Not saved yet. Add a task or a note to save it.")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
  });

  it("when the status cannot be saved after the note, says so and keeps the choice pending", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {}, failStatus: true });
    await renderPage();
    const drawer = await changeInTable("Working");
    saveNote(drawer);
    await within(drawer).findByText(/Saved, but the status was not updated\./);
    expect(patches(calls)).toEqual([{ status: "Working" }]);
    expect(within(drawer).getByText("Not saved yet. Add a task or a note to save it.")).toBeInTheDocument();
  });

  it("choosing the saved status again clears the pending choice", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Sale" }));
    expect(within(drawer).getByText("Not saved yet. Add a task or a note to save it.")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Working" }));
    expect(within(drawer).queryByText("Not saved yet. Add a task or a note to save it.")).not.toBeInTheDocument();
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
    saveNote(drawer);
    await waitFor(() => expect(stepState(drawer)[2]).toBe("done"));
    expect(patches(calls)).toEqual([]);
  });

  it("a status chosen inside the drawer and then abandoned is never written either", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Sale" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writesOf(calls)).toEqual([]);
  });

  it("opening a lead by its name starts with nothing pending", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    expect(within(drawer).queryByText("Not saved yet. Add a task or a note to save it.")).not.toBeInTheDocument();
    expect(stepState(drawer)).toEqual(["current", "todo", "todo"]);
  });
});

const PRIYA = "55555555-5555-4555-8555-555555555555";
const RAVI = "66666666-6666-4666-8666-666666666666";
const members = [{ userId: PRIYA, fullName: "Priya" }, { userId: RAVI, fullName: "Ravi" }];

describe("lead assignment", () => {
  it("shows each lead's assignee in the table, or a quiet Unassigned", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { assignedUserId: PRIYA, assigneeName: "Priya" }), lead(LEAD_2, "Anitha")], pages: {}, openTask: null, assignees: members });
    await renderPage();
    expect(screen.getByRole("columnheader", { name: "Assigned To" })).toBeInTheDocument();
    const rowOf = (name: string) => screen.getByRole("button", { name: `Open details for ${name}` }).closest("tr")!;
    expect(within(rowOf("Kumar")).getByText("Priya")).toBeInTheDocument();
    expect(within(rowOf("Anitha")).getByText("Unassigned")).toBeInTheDocument();
  });

  it("filters by assignee: My leads, Unassigned and a member are offered, and the choice reaches the query and shows as a chip", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null, assignees: members });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Assignee" }));
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["All assignees", "My leads", "Unassigned", "Priya", "Ravi"]);
    fireEvent.click(within(list).getByRole("option", { name: "My leads" }));
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/leads/query").at(-1)?.body).toMatchObject({ assignee: "me" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Assignee filter: My leads" }));
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/leads/query").at(-1)?.body).not.toHaveProperty("assignee"));
  });

  it("assigns from the drawer: sends the chosen member, updates the table row and refreshes the timeline", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null, assignees: members });
    await renderPage();
    const drawer = await openDrawer();
    const select = await within(drawer).findByRole("combobox", { name: "Assigned to" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Unassigned", "Priya", "Ravi"]);
    const before = activityCalls(calls).length;
    fireEvent.change(select, { target: { value: RAVI } });
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url === `/api/leads/${LEAD_1}/assignee` && call.body?.assigneeUserId === RAVI)).toBe(true));
    await waitFor(() => expect(select).toHaveValue(RAVI));
    expect(within(screen.getByRole("button", { name: "Open details for Kumar", hidden: true }).closest("tr")!).getByText("Ravi")).toBeInTheDocument();
    await waitFor(() => expect(activityCalls(calls).length).toBeGreaterThan(before));
  });

  it("unassigns with a null assignee", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { assignedUserId: PRIYA, assigneeName: "Priya" })], pages: {}, openTask: null, assignees: members });
    await renderPage();
    const drawer = await openDrawer();
    const select = await within(drawer).findByRole("combobox", { name: "Assigned to" });
    expect(select).toHaveValue(PRIYA);
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.body?.assigneeUserId === null)).toBe(true));
  });

  it("still shows a lead's assignee who has since been blocked, but cannot be re-picked", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { assignedUserId: "77777777-7777-4777-8777-777777777777", assigneeName: "Meena" })], pages: {}, openTask: null, assignees: members });
    await renderPage();
    const drawer = await openDrawer();
    const select = await within(drawer).findByRole("combobox", { name: "Assigned to" });
    expect(select).toHaveValue("77777777-7777-4777-8777-777777777777");
    expect(within(select).getByRole("option", { name: "Meena (no longer active)" })).toBeDisabled();
  });

  it("shows the server's message and keeps the previous assignee when the change is refused", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { assignedUserId: PRIYA, assigneeName: "Priya" })], pages: {}, openTask: null, assignees: members, failAssign: true });
    await renderPage();
    const drawer = await openDrawer();
    const select = await within(drawer).findByRole("combobox", { name: "Assigned to" });
    fireEvent.change(select, { target: { value: RAVI } });
    expect(await within(drawer).findByText("Choose an active member of this company.")).toBeInTheDocument();
    expect(select).toHaveValue(PRIYA);
  });
});
