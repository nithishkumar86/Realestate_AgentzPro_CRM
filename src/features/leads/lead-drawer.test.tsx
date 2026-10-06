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
    if (/^\/api\/leads\/[^/]+\/notes$/.test(url)) return json({ id: "note-1", createdAt: "2026-10-05T04:00:00+00:00" }, 201);
    const assignRoute = /^\/api\/leads\/([^/]+)\/assignee$/.exec(url);
    if (assignRoute && method === "PUT") {
      if (state.failAssign) return json({ error: { code: "INVALID_ASSIGNEE", message: "Choose an active member of this company." } }, 400);
      const assignedUserId = (body?.assigneeUserId as string | null) ?? null;
      return json({ id: assignRoute[1], assignedUserId, assigneeName: state.assignees?.find((member) => member.userId === assignedUserId)?.fullName ?? null });
    }
    const patchLead = /^\/api\/leads\/([^/]+)$/.exec(url);
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
    const items = within(drawer).getAllByRole("listitem");
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
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
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
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
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
    stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, createTaskConflict: true, pages: {} });
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

describe("moving a lead to a final status with an open task", () => {
  it("from the drawer: saves the status, then offers to cancel the open task", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    await renderPage();
    const drawer = await openDrawer();
    await within(drawer).findByText("Call back");
    fireEvent.click(within(drawer).getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Sale" }));
    await waitFor(() => expect(calls.find((call) => call.url === `/api/leads/${LEAD_1}/tasks/${TASK}`)?.body).toEqual({ action: "cancel" }));
    expect(confirmSpy).toHaveBeenCalledWith('This lead is now "Sale" but still has an open task "Call back". Cancel the task now?');
    expect(calls.find((call) => call.method === "PATCH" && call.url === `/api/leads/${LEAD_1}`)?.body).toEqual({ status: "Sale" });
  });

  it("from the table: keeps the task when the telecaller declines", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar", { hasOpenTask: true })], openTask, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Closed" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(2));
    expect(confirmSpy).toHaveBeenLastCalledWith('This lead is now "Closed" but still has an open task "Call back". Cancel the task now?');
    expect(calls.some((call) => call.url.includes("/tasks/"))).toBe(false);
  });

  it("from the table: does not ask when the lead has no open task", async () => {
    const calls = stubApi({ leads: [lead(LEAD_1, "Kumar")], openTask: null, pages: {} });
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Change status for Kumar" }));
    fireEvent.click(screen.getByRole("option", { name: "Disqualified" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.url.endsWith("/tasks"))).toBe(false);
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
