// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn(), from: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => { mocks.from(table); return { select: () => ({ eq: (...args: unknown[]) => { mocks.eq(...args); return { maybeSingle: mocks.maybeSingle }; } }) }; },
  }),
}));
vi.mock("@/lib/server/custom-webhook/webhook-rate-limit", () => ({ checkCustomWebhookRate: mocks.rate }));

import { CustomLeadWebhookService, hashCustomWebhookToken } from "@/lib/server/custom-webhook/custom-lead-webhook-service";

const TOKEN = "A".repeat(43);
const WEBHOOK = { id: "webhook-1", tenant_id: "tenant-a", is_active: true };
const JSON_TYPE = "application/json";
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "Ravi", phone: "9876543210", source: "Landing Page", lead_id: "lp-1", ...extra });
const ingest = (raw = body(), type: string | null = JSON_TYPE, token = TOKEN) => new CustomLeadWebhookService().ingest(token, type, raw);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.maybeSingle.mockResolvedValue({ data: WEBHOOK, error: null });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.rpc.mockResolvedValue({ data: { outcome: "stored", lead_id: "lead-1" }, error: null });
});

describe("CustomLeadWebhookService.ingest", () => {
  it("finds the company by the SHA-256 of the URL token and saves the lead for it", async () => {
    await expect(ingest()).resolves.toEqual({ status: 200, duplicate: false });
    expect(mocks.from).toHaveBeenCalledWith("custom_lead_webhooks");
    expect(mocks.eq).toHaveBeenCalledWith("url_token_hash", createHash("sha256").update(TOKEN).digest("hex"));
    expect(mocks.eq).not.toHaveBeenCalledWith(expect.anything(), TOKEN);
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_custom_webhook_lead", {
      p_tenant_id: "tenant-a", p_webhook_id: "webhook-1", p_lead_ref: "lp-1", p_source_name: "Landing Page",
      p_field_data: [{ name: "full_name", values: ["Ravi"] }, { name: "phone_number", values: ["9876543210"] }],
      p_raw_payload: { name: "Ravi", phone: "9876543210", source: "Landing Page", lead_id: "lp-1" },
    });
  });

  it("never lets the body pick the company", async () => {
    await ingest(body({ tenant_id: "tenant-b", p_tenant_id: "tenant-b" }));
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_tenant_id: "tenant-a" });
  });

  it("answers 200 with duplicate for a lead_id already saved", async () => {
    mocks.rpc.mockResolvedValue({ data: { outcome: "duplicate", lead_id: "lead-1" }, error: null });
    await expect(ingest()).resolves.toEqual({ status: 200, duplicate: true });
  });

  it("answers 404 for a malformed, unknown or stopped webhook, before reading the body", async () => {
    await expect(ingest(body(), JSON_TYPE, "short")).resolves.toMatchObject({ status: 404 });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 404, message: "Unknown webhook." });
    mocks.maybeSingle.mockResolvedValueOnce({ data: { ...WEBHOOK, is_active: false }, error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 404 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversized body without a database lookup", async () => {
    await expect(ingest(body({ pad: "x".repeat(70_000) }))).resolves.toMatchObject({ status: 413 });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("answers 429 with the wait time when the company is over its per-minute limit, and saves nothing", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    await expect(ingest()).resolves.toEqual({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 17 });
    expect(mocks.rate).toHaveBeenCalledWith("webhook-1");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 400 or 415 with the reason for a body that can never be a lead", async () => {
    await expect(ingest(JSON.stringify({ name: "No Contact" }))).resolves.toEqual({ status: 400, message: "Send phone or email." });
    await expect(ingest("<lead/>", "application/xml")).resolves.toEqual({ status: 415, message: "Send JSON or form data." });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps the database's own refusals: stopped meanwhile → 404, unusable lead → 400", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "gone" } });
    await expect(ingest()).resolves.toMatchObject({ status: 404 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Send phone or email" } });
    await expect(ingest()).resolves.toMatchObject({ status: 400 });
  });

  it("answers 500 (safe to retry) when the database fails, at lookup or at insert", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toMatchObject({ status: 500 });
  });

  it("never logs the token, a phone number, an email or a name", async () => {
    await ingest(body({ email: "ravi@example.com" }));
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await ingest(body({ email: "ravi@example.com" }));
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join(" ");
    expect(logged).toContain("LEAD_STORED");
    for (const secret of [TOKEN, "9876543210", "ravi@example.com", "Ravi"]) expect(logged).not.toContain(secret);
  });

  it("hashes the token as lowercase hex SHA-256, the stored format", () => {
    expect(hashCustomWebhookToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});
