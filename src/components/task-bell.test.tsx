import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAlertsProvider } from "@/components/task-bell";
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
});
