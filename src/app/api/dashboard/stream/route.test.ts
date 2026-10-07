// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/dashboard-live-relay", () => ({ subscribeToTenantChanges: mocks.subscribe }));

import { GET } from "./route";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  return received;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/dashboard/stream", () => {
  it("subscribes only to the session's own tenant and announces it", async () => {
    const unsubscribe = vi.fn();
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.subscribe.mockReturnValue(unsubscribe);
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream?tenantId=tenant-b", { signal: abort.signal }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toMatch(/no-cache/);
    const reader = response.body!.getReader();
    const first = await readUntil(reader, "event: ready");
    expect(first).toContain('"tenantId":"tenant-a"');
    expect(mocks.subscribe).toHaveBeenCalledWith("tenant-a", expect.any(Function));
    expect(mocks.subscribe).not.toHaveBeenCalledWith("tenant-b", expect.anything());
    abort.abort();
    await reader.cancel().catch(() => {});
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("relays change and degraded/live status events without any lead data", async () => {
    let emit: (event: "change" | "degraded" | "live") => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("change");
    expect(await readUntil(reader, "event: change")).toContain("event: change\ndata: {}");
    emit("degraded");
    expect(await readUntil(reader, "degraded")).toContain('event: status\ndata: {"state":"degraded"}');
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("forwards a timeline activity as an activity event carrying only the lead id", async () => {
    let emit: (event: "change" | "degraded" | "live" | "activity", payload?: { leadId: string }) => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-activity" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("activity", { leadId: "11111111-1111-4111-8111-111111111111" });
    expect(await readUntil(reader, "event: activity")).toContain('event: activity\ndata: {"leadId":"11111111-1111-4111-8111-111111111111"}');
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("delivers a task reminder only to the member it is for", async () => {
    let emit: (event: "reminder", payload?: { notificationId: string; userId: string }) => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-me" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("reminder", { notificationId: "n-other", userId: "user-other" });
    emit("reminder", { notificationId: "n-mine", userId: "user-me" });
    const received = await readUntil(reader, "event: task_reminder");
    expect(received).toContain('event: task_reminder\ndata: {"notificationId":"n-mine"}');
    expect(received).not.toContain("n-other");
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("answers an unauthenticated request with 401 JSON (which makes EventSource stop) and never subscribes", async () => {
    mocks.context.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("caps concurrent streams per user and frees the slot when a stream ends", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-cap" });
    mocks.subscribe.mockReturnValue(vi.fn());
    const aborts: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
      expect(response.status).toBe(200);
      readers.push(response.body!.getReader());
    }
    const refused = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(refused.status).toBe(429);
    aborts[0].abort();
    await readers[0].cancel().catch(() => {});
    const admitted = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(admitted.status).toBe(200);
    for (const [index, reader] of readers.entries()) { aborts[index].abort(); await reader.cancel().catch(() => {}); }
    await admitted.body!.cancel().catch(() => {});
  });
});
