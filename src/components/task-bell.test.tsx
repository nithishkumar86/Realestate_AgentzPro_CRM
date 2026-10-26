import { act, cleanup as cleanupRender, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAlertsProvider, TaskBell } from "@/components/task-bell";
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

describe("Browser notifications switch", () => {
  const KEY = new TextEncoder().encode("test-key");
  function fakeSubscription(endpoint: string, key: Uint8Array = KEY) {
    return { endpoint, options: { applicationServerKey: key.slice().buffer }, toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
  }
  type FakeSubscription = ReturnType<typeof fakeSubscription>;
  let current: FakeSubscription | null;
  const fresh = fakeSubscription("https://fcm.googleapis.com/fresh");
  const pushManager = { getSubscription: vi.fn(async () => current), subscribe: vi.fn(async () => fresh) };
  const flush = async () => { for (let index = 0; index < 5; index += 1) await settle(); };
  // The shared fetch mock is typed with the URL only; push calls also carry the request options.
  const pushCalls = (method: string) => (fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>).filter(([url, init]) => url === "/api/push/subscribe" && init?.method === method);
  const toggle = () => screen.getByRole("switch", { name: "Browser notifications" });

  async function renderBell(subscription: FakeSubscription | null) {
    current = subscription;
    pushManager.getSubscription.mockClear();
    pushManager.subscribe.mockClear();
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "dGVzdC1rZXk");
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: async () => "granted" });
    const registration = { pushManager };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => registration, ready: Promise.resolve(registration) } });
    vi.resetModules();
    const bell = await import("@/components/task-bell");
    render(<bell.TaskAlertsProvider><bell.TaskBell /></bell.TaskAlertsProvider>);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Task alerts/ }));
  }
  const baseFetch = fetchMock.getMockImplementation()!;
  /** Answers only the save the page makes on load (the first push POST); every other request is served as usual. */
  function answerPageLoadSave(answer: () => Promise<Response>) {
    let used = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (!used && url === "/api/push/subscribe" && init?.method === "POST") { used = true; return answer(); }
      return baseFetch(url);
    });
  }
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, "serviceWorker"); localStorage.clear(); fetchMock.mockImplementation(baseFetch); });

  it("turning off moves the switch at once, removes it on the server and keeps the browser subscription", async () => {
    const kept = fakeSubscription("https://fcm.googleapis.com/kept");
    await renderBell(kept);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    let finish = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = () => resolve(new Response("{}", { status: 200 })); }));

    // A double click lands both clicks before the switch re-renders as locked; only the first may run.
    act(() => { toggle().click(); toggle().click(); });
    await settle();
    // Moved before the server answers, locked, and says what it is doing.
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle()).toBeDisabled();
    expect(screen.getByText("Turning off…")).toBeInTheDocument();

    finish();
    await flush();
    expect(pushCalls("DELETE")).toHaveLength(1);
    expect(kept.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem("agentzpro-push-off")).toBe("1");
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle()).not.toBeDisabled();
  });

  it("turning off right after the page loads waits for the page's own save before removing it", async () => {
    const kept = fakeSubscription("https://fcm.googleapis.com/kept");
    let finishSave = () => {};
    answerPageLoadSave(() => new Promise<Response>((resolve) => { finishSave = () => resolve(new Response("{}", { status: 200 })); }));
    await renderBell(kept);
    fireEvent.click(toggle());
    await flush();
    // The save from page load is still running, so the DELETE has not been sent yet.
    expect(pushCalls("DELETE")).toHaveLength(0);
    finishSave();
    await flush();
    expect(pushCalls("DELETE")).toHaveLength(1);
    expect(kept.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem("agentzpro-push-off")).toBe("1");
  });

  it("drops the browser subscription when the page's own save had failed (it may still be saved for someone else)", async () => {
    const kept = fakeSubscription("https://fcm.googleapis.com/kept");
    answerPageLoadSave(async () => new Response("{}", { status: 500 }));
    await renderBell(kept);
    fireEvent.click(toggle());
    await flush();
    expect(pushCalls("DELETE")).toHaveLength(1);
    expect(kept.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem("agentzpro-push-off")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("drops the browser subscription as before when the server could not remove it", async () => {
    const kept = fakeSubscription("https://fcm.googleapis.com/kept");
    await renderBell(kept);
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    fireEvent.click(toggle());
    await flush();
    expect(kept.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem("agentzpro-push-off")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("a page load after turning off does not save the kept subscription again", async () => {
    localStorage.setItem("agentzpro-push-off", "1");
    fetchMock.mockClear();
    await renderBell(fakeSubscription("https://fcm.googleapis.com/kept"));
    expect(pushCalls("POST")).toHaveLength(0);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Turn on notifications to get task reminders" })).toBeInTheDocument();
  });

  it("turning back on reuses the kept subscription without signing up with the push service again", async () => {
    localStorage.setItem("agentzpro-push-off", "1");
    await renderBell(fakeSubscription("https://fcm.googleapis.com/kept"));
    fetchMock.mockClear();
    let finish = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = () => resolve(new Response("{}", { status: 200 })); }));
    fireEvent.click(toggle());
    await settle();
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(toggle()).toBeDisabled();
    expect(screen.getByText("Turning on…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications to get task reminders" })).not.toBeInTheDocument();
    finish();
    await flush();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushCalls("POST")).toHaveLength(1);
    expect(JSON.parse(String(pushCalls("POST")[0][1]?.body)).endpoint).toBe("https://fcm.googleapis.com/kept");
    expect(localStorage.getItem("agentzpro-push-off")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });

  it("signs up with the push service only when the device has no subscription, or one made with another key", async () => {
    await renderBell(null);
    fireEvent.click(toggle());
    await flush();
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    cleanupRender();

    localStorage.setItem("agentzpro-push-off", "1");
    const old = fakeSubscription("https://fcm.googleapis.com/old", new TextEncoder().encode("old-key"));
    await renderBell(old);
    fireEvent.click(toggle());
    await flush();
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("flips back to off and shows the Turn on line again when turning on fails", async () => {
    localStorage.setItem("agentzpro-push-off", "1");
    await renderBell(fakeSubscription("https://fcm.googleapis.com/kept"));
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    fireEvent.click(toggle());
    await flush();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("agentzpro-push-off")).toBe("1");
    expect(screen.getByRole("button", { name: "Turn on notifications to get task reminders" })).toBeInTheDocument();
  });
});
