// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@/lib/server/custom-webhook/custom-lead-webhook-service", () => ({
  CustomLeadWebhookService: class { ingest = mocks.ingest; },
}));

import { POST } from "./route";

const TOKEN = "A".repeat(43);
const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  POST(new Request(`http://localhost/api/webhooks/custom/${TOKEN}`, { method: "POST", headers, body }), { params: Promise.resolve({ token: TOKEN }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/webhooks/custom/[token]", () => {
  it("hands the token, content type and raw body to the service and answers {success:true}", async () => {
    mocks.ingest.mockResolvedValue({ status: 200, duplicate: false });
    const response = await post("{\"phone\":\"9876543210\"}");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, "application/json", "{\"phone\":\"9876543210\"}");
  });

  it("tells the sender a repeat lead_id was already saved", async () => {
    mocks.ingest.mockResolvedValue({ status: 200, duplicate: true });
    expect(await (await post("{}")).json()).toEqual({ success: true, duplicate: true });
  });

  it("answers errors as {error} with their status, and 429 with Retry-After", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 400, message: "Send phone or email." });
    const bad = await post("{}");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Send phone or email." });
    mocks.ingest.mockResolvedValueOnce({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 9 });
    const limited = await post("{}");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("9");
  });

  it("refuses a declared oversized body without reading it", async () => {
    const response = await post("{}", { "content-type": "application/json", "content-length": String(70_000) });
    expect(response.status).toBe(413);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("answers 500 (safe to retry) when the service throws, without leaking details", async () => {
    mocks.ingest.mockRejectedValue(new Error("secret detail"));
    const response = await post("{}");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});
