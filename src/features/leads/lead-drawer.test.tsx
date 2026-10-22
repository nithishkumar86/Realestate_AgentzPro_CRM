import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsPageClient } from "@/features/leads/leads-page-client";
import { zonedDateTime } from "@/features/leads/task-schedule";

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

// Due Thu 08 Oct 2026, 11:00 PM on the company clock (Asia/Kolkata).
const openTask = {
  id: TASK, title: "Call back", description: "Confirm the site visit slot", startDate: "2026-10-05", dueDate: "2026-10-08",
  startAt: "2026-10-05T04:00:00+00:00", dueAt: "2026-10-08T17:30:00+00:00", originalDueAt: "2026-10-08T17:30:00+00:00", repeatRule: "none",
  status: "open", closedAt: null, createdAt: "2026-10-05T04:00:00+00:00",
};
// The time field is two pickers (hour 00-23, minutes) inside a labelled group; these read and set it as "HH:mm".
const timeParts = (group: HTMLElement) => ({ hour: within(group).getByRole("button", { name: /^Hour/ }), minutes: within(group).getByRole("button", { name: /^Minutes/ }) });
const readTime = (group: HTMLElement) => {
  const { hour, minutes } = timeParts(group);
  return `${hour.textContent}:${minutes.textContent}`;
};
const setTime = (group: HTMLElement, time: string) => {
  const [hour, minute] = time.split(":");
  fireEvent.click(timeParts(group).hour);
  fireEvent.click(within(group).getByRole("option", { name: hour }));
  fireEvent.click(timeParts(group).minutes);
  fireEvent.click(within(group).getByRole("option", { name: minute }));
};
// The Add Task repeat rule is a picker too: a button named "Select Repeat this Task" (plus its value), then a listbox.
const repeatTrigger = (drawer: HTMLElement) => within(drawer).getByRole("button", { name: /^Select Repeat this Task/ });
// The Add Task title is a picker whose options open under the field: a button named "Title" (plus its value), then a listbox.
const titleTrigger = (drawer: HTMLElement) => within(drawer).findByRole("button", { name: /^Title/ });
const pickTitle = async (drawer: HTMLElement, option: string) => {
  fireEvent.click(await titleTrigger(drawer));
  fireEvent.click(within(drawer).getByRole("option", { name: option }));
};
// The Add Task due date is a picker too: a button named "Due Date" (plus its value), then a listbox.
const dueTrigger = (drawer: HTMLElement) => within(drawer).findByRole("button", { name: /^Due Date/ });
const pickDue = async (drawer: HTMLElement, option: string) => {
  fireEvent.click(await dueTrigger(drawer));
  fireEvent.click(within(drawer).getByRole("option", { name: option }));
};
const dueAtOf =(body: Record<string, unknown> | undefined) => zonedDateTime(String(body?.dueDate), String(body?.dueTime), "Asia/Kolkata").toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface ApiState {
  leads: Lead[];
  pages: Record<string, { items: Activity[]; nextCursor: string | null }>;
  openTask: typeof openTask | null;
  createTaskConflict?: boolean;
  assignees?: Array<{ userId: string; fullName: string }>;
  isOwner?: boolean;
  failAssign?: boolean;
  failStatus?: boolean;
  failNote?: boolean;
  /** The opened lead's Meta form answers (GET /api/leads/:id). */
  answers?: Array<{ name: string; values: string[] }>;
}

/** One router for every endpoint the leads page and the drawer call; records each request. */
function stubApi(state: ApiState) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/leads/filters")) return json({ pages: [], ads: [], defaultAdId: null, assignees: state.assignees ?? [], isOwner: state.isOwner ?? true });
    if (url === "/api/leads/query") return json({ items: state.leads, total: state.leads.length, timezone: "Asia/Kolkata" });
    const activities = /^\/api\/leads\/[^/]+\/activities\?(.*)$/.exec(url);
    if (activities) {
      const params = new URLSearchParams(activities[1]);
      return json(state.pages[`${params.get("filter")}:${params.get("cursor") ?? ""}`] ?? { items: [], nextCursor: null });
    }
    if (/^\/api\/leads\/[^/]+\/tasks$/.test(url)) {
      if (method === "GET") return json({ openTask: state.openTask });
      if (state.createTaskConflict) return json({ error: { code: "OPEN_TASK_EXISTS", message: "This lead already has an open task. Complete or cancel it before adding a new one." } }, 409);
      state.openTask = { ...openTask, title: String(body?.title), dueDate: String(body?.dueDate), dueAt: dueAtOf(body), originalDueAt: dueAtOf(body), repeatRule: String(body?.repeat) };
      return json(state.openTask, 201);
    }
    if (/^\/api\/leads\/[^/]+\/tasks\/[^/]+$/.test(url)) {
      if (body && "action" in body) { const closed = { ...openTask, status: body.action === "complete" ? "completed" : "cancelled" }; state.openTask = null; return json(closed); }
      state.openTask = { ...openTask, dueDate: String(body?.dueDate), dueAt: dueAtOf(body) };
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
    if (patchLead && method === "GET") return json({ answers: state.answers ?? [] });
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Freezes only the clock (timers stay real so the UI still settles). Default: Wed 07 Oct 2026, 11:30 AM in Asia/Kolkata. */
function freezeClock(iso = "2026-10-07T06:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

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

describe("form answers in the drawer", () => {
  it("shows the opened lead's form answers between the lead details and the 1-2-3 steps", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null, answers: [
      { name: "budget_range", values: ["70_lakhs"] },
      { name: "home_loan_needed?", values: ["no"] },
    ] });
    await renderPage();
    const drawer = await openDrawer();
    const card = within(drawer).getByRole("region", { name: "Form answers" });
    expect(await within(card).findByText("70 lakhs")).toBeInTheDocument();
    expect(within(card).getByText("Home loan needed?")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "GET" && call.url === `/api/leads/${LEAD_1}`)).toBe(true);
    const details = within(drawer).getByRole("region", { name: "Lead details" });
    const steps = within(drawer).getByRole("list", { name: "After every call" });
    expect(details.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("hides the add form while a task is open, and cancels it without a confirmation popup", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true, status: "Working" })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    expect(within(drawer).queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("Due Thu 08 Oct 2026, 11:00 PM")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel task" }));
    await within(drawer).findByText("Add next task or close the lead");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ action: "cancel" });
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeInTheDocument();
    // The table marker updates without a reload.
    const row = screen.getByRole("button", { name: "Open details for Kumar" }).closest("tr")!;
    expect(within(row).getByText("No task")).toBeInTheDocument();
  });

  it("creates a task with a Due Date preset, a Time and a repeat, and has no start date field", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Site Visit");
    expect(within(drawer).getByLabelText(/Description/)).toHaveAttribute("placeholder", "What needs to be done by the due time");
    expect(within(drawer).queryByLabelText(/Start date/i)).not.toBeInTheDocument();
    const dueDate = await dueTrigger(drawer);
    const repeat = repeatTrigger(drawer);
    fireEvent.click(repeat);
    expect(within(within(drawer).getByRole("listbox", { name: "Select Repeat this Task" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["Everyday", "Weekly", "Monthly", "Yearly", "Don't Repeat"]);
    fireEvent.keyDown(document, { key: "Escape" });
    // Defaults: today, the next full hour, no repeat.
    expect(dueDate).toHaveTextContent("Today");
    expect(readTime(within(drawer).getByRole("group", { name: "Time" }))).toBe("12:00");
    expect(repeat).toHaveTextContent("Don't Repeat");
    expect(within(drawer).getByText("Due Wed 07 Oct 2026, 12:00 PM")).toBeInTheDocument();

    fireEvent.click(dueDate);
    expect(within(within(drawer).getByRole("listbox", { name: "Due Date" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["Today", "Tomorrow", "3 Days From Now", "1 Week From Now", "1 Month From Now", "Custom"]);
    fireEvent.click(within(drawer).getByRole("option", { name: "3 Days From Now" }));
    // The field shows the label, never the stored code.
    expect(dueDate).toHaveTextContent("3 Days From Now");
    expect(dueDate).not.toHaveTextContent("3_days");
    setTime(within(drawer).getByRole("group", { name: "Time" }), "15:00");
    fireEvent.click(repeat);
    fireEvent.click(within(drawer).getByRole("option", { name: "Weekly" }));
    expect(repeat).toHaveTextContent("Weekly");
    expect(within(drawer).getByText("Due Sat 10 Oct 2026, 3:00 PM · Repeats every week")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toEqual({ title: "Site Visit", description: null, dueDate: "2026-10-10", dueTime: "15:00", repeat: "weekly" });
    expect(within(drawer).getByText("Due Sat 10 Oct 2026, 3:00 PM · Repeats every week")).toBeInTheDocument();
  });

  it("lists 24 hours and 60 minutes in scrolling lists under the Time field, one list open at a time", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const time = await within(drawer).findByRole("group", { name: "Time" });
    const { hour, minutes } = timeParts(time);
    fireEvent.click(hour);
    expect(within(within(time).getByRole("listbox", { name: "Hour" })).getAllByRole("option")).toHaveLength(24);
    expect(within(time).getByRole("listbox", { name: "Hour" })).toHaveClass("mvp-option-picker__panel--scroll");
    fireEvent.mouseDown(minutes);
    fireEvent.click(minutes);
    expect(within(time).queryByRole("listbox", { name: "Hour" })).not.toBeInTheDocument();
    expect(within(within(time).getByRole("listbox", { name: "Minutes" })).getAllByRole("option")).toHaveLength(60);
  });

  it("offers ready-made titles under the field with nothing preselected, and keeps Add task disabled until one is picked", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const trigger = await titleTrigger(drawer);
    expect(trigger).toHaveTextContent("Select a title");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(within(drawer).queryByRole("listbox")).not.toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeDisabled();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = within(drawer).getByRole("listbox", { name: "Title" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Call Back", "Send WhatsApp", "Follow Up", "Send Brochure", "Send Price List", "Site Visit", "Other (type your own)",
    ]);
    expect(within(drawer).queryByLabelText("Custom title")).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("option", { name: "Call Back" }));
    expect(within(drawer).queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent("Call Back");
    expect(trigger).toHaveFocus();
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeEnabled();
    // Reopening marks the current choice.
    fireEvent.click(trigger);
    expect(within(drawer).getByRole("option", { name: "Call Back" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows a text box for Other, keeps Add task disabled while it is empty, and sends the typed title", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Other (type your own)");
    const custom = within(drawer).getByLabelText("Custom title");
    expect(custom).toHaveFocus();
    expect(custom).toHaveAttribute("maxlength", "200");
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(custom, { target: { value: "   " } });
    expect(within(drawer).getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(custom, { target: { value: "Ask about loan eligibility" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toMatchObject({ title: "Ask about loan eligibility" });
  });

  it("hides the text box again when a ready-made title is picked after Other", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Other (type your own)");
    fireEvent.change(within(drawer).getByLabelText("Custom title"), { target: { value: "Something typed" } });
    await pickTitle(drawer, "Send Brochure");
    expect(within(drawer).queryByLabelText("Custom title")).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toMatchObject({ title: "Send Brochure" });
  });

  it("closes only the title list on the first Escape and the drawer on the second", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const trigger = await titleTrigger(drawer);
    fireEvent.click(trigger);
    expect(within(drawer).getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(within(drawer).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the title list when clicking elsewhere in the drawer, without picking anything", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const trigger = await titleTrigger(drawer);
    fireEvent.click(trigger);
    fireEvent.mouseDown(within(drawer).getByRole("heading", { name: "Follow-up task" }));
    expect(within(drawer).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Select a title");
  });

  it("moves through the title options with the arrow keys, starting on the first one", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(await titleTrigger(drawer));
    const option = (name: string) => within(drawer).getByRole("option", { name });
    expect(option("Call Back")).toHaveFocus();
    fireEvent.keyDown(option("Call Back"), { key: "ArrowDown" });
    expect(option("Send WhatsApp")).toHaveFocus();
    fireEvent.keyDown(option("Send WhatsApp"), { key: "End" });
    expect(option("Other (type your own)")).toHaveFocus();
    fireEvent.keyDown(option("Other (type your own)"), { key: "ArrowUp" });
    expect(option("Site Visit")).toHaveFocus();
    fireEvent.keyDown(option("Site Visit"), { key: "Home" });
    expect(option("Call Back")).toHaveFocus();
  });

  it("sets the Due Date options apart like the title ones: a divider before Custom, the chosen one marked, and one list open at a time", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const due = await dueTrigger(drawer);
    fireEvent.click(due);
    const list = within(drawer).getByRole("listbox", { name: "Due Date" });
    expect(within(list).getByRole("separator")).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: "Today" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: "Today" })).toHaveFocus();
    // Opening the title list closes this one.
    fireEvent.mouseDown(await titleTrigger(drawer));
    fireEvent.click(await titleTrigger(drawer));
    expect(within(drawer).queryByRole("listbox", { name: "Due Date" })).not.toBeInTheDocument();
    expect(within(drawer).getByRole("listbox", { name: "Title" })).toBeInTheDocument();
  });

  it("closes only the Due Date list on the first Escape, and choosing Custom returns focus to the field", async () => {
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    const due = await dueTrigger(drawer);
    fireEvent.click(due);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(within(drawer).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(due).toHaveFocus();
    await pickDue(drawer, "Custom");
    expect(due).toHaveTextContent("Custom");
    expect(due).toHaveFocus();
    expect(within(drawer).getByLabelText("Pick a date")).toBeInTheDocument();
  });

  it("shows a calendar for Custom, starting on the date already picked, and sends the chosen day", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Site Visit");
    expect(within(drawer).queryByLabelText("Pick a date")).not.toBeInTheDocument();
    await pickDue(drawer, "Tomorrow");
    await pickDue(drawer, "Custom");
    const calendar = within(drawer).getByLabelText("Pick a date");
    expect(calendar).toHaveValue("2026-10-08");
    expect(calendar).toHaveAttribute("min", "2026-10-07");
    fireEvent.change(calendar, { target: { value: "2026-10-20" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toMatchObject({ dueDate: "2026-10-20", dueTime: "12:00", repeat: "none" });
  });

  it("refuses a due time that has already passed today, without sending anything", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Site Visit");
    setTime(within(drawer).getByRole("group", { name: "Time" }), "09:00");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByText("Pick a due time later than now.");
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/tasks"))).toBe(false);
  });

  it("late in the evening defaults to tomorrow at midnight", async () => {
    freezeClock("2026-10-07T18:00:00Z"); // 11:30 PM in Asia/Kolkata
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    expect(await dueTrigger(drawer)).toHaveTextContent("Tomorrow");
    expect(readTime(within(drawer).getByRole("group", { name: "Time" }))).toBe("00:00");
    expect(within(drawer).getByText("Due Thu 08 Oct 2026, 12:00 AM")).toBeInTheDocument();
  });

  it("shows the server's message when another open task already exists", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, createTaskConflict: true, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await pickTitle(drawer, "Site Visit");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByText("This lead already has an open task. Complete or cancel it before adding a new one.");
  });

  it("reschedules the due date and time, starting from the current due time", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Reschedule" }));
    const preset = within(drawer).getByLabelText("New due date");
    const time = within(drawer).getByRole("group", { name: "New time" });
    expect(preset).toHaveValue("tomorrow");
    expect(readTime(time)).toBe("23:00");
    expect(within(drawer).getByRole("button", { name: "Update" })).toBeDisabled();
    fireEvent.change(preset, { target: { value: "custom" } });
    const date = within(drawer).getByLabelText("Pick a date");
    expect(date).toHaveValue("2026-10-08");
    expect(date).toHaveAttribute("min", "2026-10-07");
    fireEvent.change(date, { target: { value: "2026-10-12" } });
    setTime(time, "10:00");
    fireEvent.click(within(drawer).getByRole("button", { name: "Update" }));
    await within(drawer).findByText("Due Mon 12 Oct 2026, 10:00 AM");
    expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ dueDate: "2026-10-12", dueTime: "10:00" });
  });

  it("refuses to reschedule to a time that has already passed, without sending anything", async () => {
    freezeClock();
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole("button", { name: "Reschedule" }));
    fireEvent.change(within(drawer).getByLabelText("New due date"), { target: { value: "today" } });
    setTime(within(drawer).getByRole("group", { name: "New time" }), "09:00");
    fireEvent.click(within(drawer).getByRole("button", { name: "Update" }));
    await within(drawer).findByText("Pick a due time later than now.");
    expect(calls.some((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)).toBe(false);
  });

  it("marks the task Overdue once its due time has passed", async () => {
    freezeClock("2026-10-08T18:00:00Z");
    stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    expect(within(drawer).getByText("Overdue")).toBeInTheDocument();
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
    expect(within(drawer).queryByRole("button", { name: /^Title/ })).not.toBeInTheDocument();
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

    await pickTitle(drawer, "Site Visit");
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
    freezeClock();
    stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    expect(await within(drawer).findByRole("button", { name: "Mark complete" })).toBeEnabled();
    expect(within(drawer).getByRole("button", { name: "Reschedule" })).toBeEnabled();
    expect(within(drawer).getByRole("button", { name: "Cancel task" })).toBeEnabled();
    expect(within(drawer).queryByText(LOCK_TEXT)).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Reschedule" }));
    fireEvent.change(within(drawer).getByLabelText("New due date"), { target: { value: "custom" } });
    fireEvent.change(within(drawer).getByLabelText("Pick a date"), { target: { value: "2026-10-12" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Update" }));
    await within(drawer).findByText("Due Mon 12 Oct 2026, 11:00 PM");
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
    await pickTitle(drawer, "Site Visit");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add task" }));
    await within(drawer).findByRole("button", { name: "Mark complete" });
    expect(writesOf(calls)).toEqual(["POST /api/leads/:id/tasks"]);
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/tasks"))?.body).toMatchObject({ title: "Site Visit", status: "Working" });
    expect(patches(calls)).toEqual([]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close lead details" }));
    expect(screen.getByRole("button", { name: "Change status for Kumar" })).toHaveTextContent("Working");
  });

  it("sends no status with a task when none is pending", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { status: "Working" })], openTask: null, pages: {} });
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByRole("button", { name: "Add task" });
    await pickTitle(drawer, "Site Visit");
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

  it("an employee sees a read-only assignee chip, not the dropdown", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar", { assignedUserId: PRIYA, assigneeName: "Priya" })], pages: {}, openTask: null, assignees: members, isOwner: false });
    await renderPage();
    const drawer = await openDrawer();
    expect(within(drawer).queryByRole("combobox", { name: "Assigned to" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("Priya")).toBeInTheDocument();
    expect(within(drawer).getByText("Only your company owner can assign or reassign leads.")).toBeInTheDocument();
  });

  it("an employee sees Unassigned as a read-only chip when no one is assigned", async () => {
    stubApi({ leads: [lead(LEAD_1, "Kumar")], pages: {}, openTask: null, assignees: members, isOwner: false });
    await renderPage();
    const drawer = await openDrawer();
    expect(within(drawer).queryByRole("combobox", { name: "Assigned to" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("Unassigned")).toBeInTheDocument();
  });
});
