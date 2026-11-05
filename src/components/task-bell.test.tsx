import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEADS_CHANGED_EVENT, TASKS_CHANGED_EVENT, TaskAlertsProvider, TaskBell } from "@/components/task-bell";
import type { TaskNotification } from "@/lib/server/task-notification-service";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Array<() => void>>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  emit(type: string) { for (const callback of this.listeners.get(type) ?? []) callback(); }
  close() {}
}

function alert(id: string, overrides: Partial<TaskNotification> = {}): TaskNotification {
  return { id, kind: "due_soon", dueAt: "2026-10-21T10:00:00.000Z", createdAt: "2026-10-21T09:45:00.000Z", read: false, leadId: `lead-${id}`, taskTitle: `Task ${id}`, leadName: "Ravi", ...overrides };
}

let items: TaskNotification[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url === "/api/notifications/clear") items = [];
  if (url === "/api/notifications") return new Response(JSON.stringify({ items, unread: items.filter((item) => !item.read).length }), { status: 200 });
  return new Response("{}", { status: 200 });
});
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const stream = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];
async function remind(next: TaskNotification[]) {
  items = next;
  act(() => stream().emit("task_reminder"));
  await settle();
}
const cards = () => screen.queryAllByRole("group", { name: "Task reminder" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FakeEventSource.instances = [];
  items = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("task reminder cards", () => {
  it("does not pop up alerts that were already there when the page loaded", async () => {
    items = [alert("old")];
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    expect(cards()).toHaveLength(0);
  });

  it("shows a branded card for a new reminder and keeps it until OK", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    await remind([alert("a", { kind: "due_now", taskTitle: "Send WhatsApp" })]);

    const [card] = cards();
    expect(card).toHaveTextContent("AgentzPro");
    expect(card).toHaveTextContent("Follow up with Ravi now");
    expect(card).toHaveTextContent("Send WhatsApp");
    expect(card).toHaveTextContent("Due");
    expect(card).toHaveClass("mvp-reminder--now");
    expect(screen.getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads?lead=lead-a");

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(cards()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(cards()).toHaveLength(0);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications/read", expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["a"] }) }));
  });

  it("stacks several reminders, newest on top, three at most", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    await remind([alert("1")]);
    await remind([alert("2"), alert("1")]);
    await remind([alert("4"), alert("3"), alert("2"), alert("1")]);

    expect(cards().map((card) => card.querySelector(".mvp-reminder__task")?.textContent)).toEqual(["Task 4", "Task 3", "Task 2"]);
  });

  it("removes a card once its alert is read somewhere else", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    await remind([alert("a"), alert("b")]);
    expect(cards()).toHaveLength(2);

    await remind([alert("a", { read: true }), alert("b")]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toHaveTextContent("Task b");
  });

  it("Clear all empties the bell list and posts to the clear endpoint", async () => {
    items = [alert("a"), alert("b", { read: true })];
    render(<TaskAlertsProvider><TaskBell /></TaskAlertsProvider>);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Task alerts/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    let finishClear = () => {};
    fetchMock.mockImplementationOnce((url: string) => {
      expect(url).toBe("/api/notifications/clear");
      return new Promise<Response>((resolve) => { finishClear = () => { items = []; resolve(new Response("{}", { status: 200 })); }; });
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    // While the request runs the button says so and cannot be pressed again.
    const busy = screen.getByRole("button", { name: "Clearing…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    finishClear();
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications/clear", expect.objectContaining({ method: "POST", body: JSON.stringify({ all: true }) }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });
});

describe("Turn on notifications line beside the bell", () => {
  const LINE = "Turn on notifications to get task reminders";
  // The VAPID key is read when the module loads, so each test imports a fresh copy with the key set.
  async function renderBell(permission: NotificationPermission, subscribed = false) {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "dGVzdC1rZXk");
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission });
    const registration = { pushManager: { getSubscription: async () => (subscribed ? { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/x", keys: {} }) } : null) } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => registration, ready: Promise.resolve(registration) } });
    vi.resetModules();
    const bell = await import("@/components/task-bell");
    render(<bell.TaskAlertsProvider><bell.TaskBell /></bell.TaskAlertsProvider>);
    await settle();
  }
  afterEach(() => { vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, "serviceWorker"); });

  it("shows the line while notifications are off, and clicking it opens the bell panel with the switch", async () => {
    await renderBell("default");
    expect(screen.queryByRole("dialog", { name: "Task alerts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: LINE }));
    expect(screen.getByRole("dialog", { name: "Task alerts" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Browser notifications" })).toHaveAttribute("aria-checked", "false");
  });

  it("shows the line when the browser has blocked notifications", async () => {
    await renderBell("denied");
    expect(screen.getByRole("button", { name: LINE })).toBeInTheDocument();
  });

  it("hides the line once notifications are on", async () => {
    await renderBell("granted", true);
    expect(screen.queryByRole("button", { name: LINE })).not.toBeInTheDocument();
  });

  it("hides the line where this browser cannot get notifications at all", async () => {
    render(<TaskAlertsProvider><TaskBell /></TaskAlertsProvider>);
    await settle();
    expect(screen.queryByRole("button", { name: LINE })).not.toBeInTheDocument();
  });
});

describe("window events for the Tasks and Leads pages", () => {
  function listen() {
    const fired = { tasks: 0, leads: 0 };
    const onTasks = () => { fired.tasks += 1; };
    const onLeads = () => { fired.leads += 1; };
    window.addEventListener(TASKS_CHANGED_EVENT, onTasks);
    window.addEventListener(LEADS_CHANGED_EVENT, onLeads);
    return { fired, stop: () => { window.removeEventListener(TASKS_CHANGED_EVENT, onTasks); window.removeEventListener(LEADS_CHANGED_EVENT, onLeads); } };
  }

  it("tells both pages when the stream says a lead changed", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    const { fired, stop } = listen();
    act(() => stream().emit("change"));
    expect(fired).toEqual({ tasks: 1, leads: 1 });
    stop();
  });

  it("tells only the Tasks page about a task reminder", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    const { fired, stop } = listen();
    await remind([alert("a")]);
    expect(fired).toEqual({ tasks: 1, leads: 0 });
    stop();
  });

  it("tells both pages when the tab comes back into view, and nothing while it is hidden", async () => {
    render(<TaskAlertsProvider><main /></TaskAlertsProvider>);
    await settle();
    const { fired, stop } = listen();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fired).toEqual({ tasks: 0, leads: 0 });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fired).toEqual({ tasks: 1, leads: 1 });
    stop();
    await settle();
  });
});
