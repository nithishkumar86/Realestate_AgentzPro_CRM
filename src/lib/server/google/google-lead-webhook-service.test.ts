// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLeadWebhookService } from "@/lib/server/google/google-lead-webhook-service";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: (...args: unknown[]) => { mocks.eq(...args); return { maybeSingle: mocks.maybeSingle }; } }) }),
  }),
}));
vi.mock("@/lib/server/token-crypto", () => ({ decryptToken: (value: string) => value.replace(/^enc:/, "") }));

const TOKEN = "a".repeat(43);
const WEBHOOK = { id: "webhook-1", tenant_id: "tenant-a", encrypted_google_key: "enc:right-key", is_active: true };
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ lead_id: "lead-1", google_key: "right-key", campaign_id: 123, user_column_data: [{ column_id: "FULL_NAME", string_value: "Ravi" }], ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.maybeSingle.mockResolvedValue({ data: WEBHOOK, error: null });
  mocks.rpc.mockResolvedValue({ data: "stored", error: null });
});

describe("GoogleLeadWebhookService.ingest", () => {
  it("stores a lead for the tenant the URL token belongs to", async () => {
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toEqual({ status: 200, outcome: "stored" });
    expect(mocks.eq).toHaveBeenCalledWith("url_token", TOKEN);
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_google_lead", expect.objectContaining({
      p_tenant_id: "tenant-a", p_webhook_id: "webhook-1", p_google_lead_id: "lead-1", p_is_test: false, p_campaign_id: "123",
      p_field_data: [{ name: "full_name", values: ["Ravi"] }],
    }));
    const payload = mocks.rpc.mock.calls[0][1].p_raw_payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("google_key");
  });

  it.each([["wrong key", body({ google_key: "wrong-key" })], ["missing key", body({ google_key: "" })]])("refuses a %s with 403 and saves nothing", async (_, raw) => {
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, raw)).resolves.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed, unknown or inactive token", async () => {
    await expect(new GoogleLeadWebhookService().ingest("short", body())).resolves.toMatchObject({ status: 404 });
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toMatchObject({ status: 404 });
    mocks.maybeSingle.mockResolvedValueOnce({ data: { ...WEBHOOK, is_active: false }, error: null });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toMatchObject({ status: 404 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 400 (never retried) for a body that can never be a lead", async () => {
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, "{oops")).resolves.toMatchObject({ status: 400 });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversized body", async () => {
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body({ pad: "x".repeat(70_000) }))).resolves.toMatchObject({ status: 413 });
  });

  it("passes is_test through, so a test lead is only logged by the database function", async () => {
    mocks.rpc.mockResolvedValue({ data: "test", error: null });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body({ is_test: true }))).resolves.toEqual({ status: 200, outcome: "test" });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_is_test: true });
  });

  it("answers 200 for a duplicate delivery", async () => {
    mocks.rpc.mockResolvedValue({ data: "duplicate", error: null });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toEqual({ status: 200, outcome: "duplicate" });
  });

  it("answers 500 (Google retries) when the database fails, at lookup or at insert", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toMatchObject({ status: 500 });
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(new GoogleLeadWebhookService().ingest(TOKEN, body())).resolves.toMatchObject({ status: 500 });
  });

  it("never logs an answer or the key", async () => {
    await new GoogleLeadWebhookService().ingest(TOKEN, body({ google_key: "wrong-key" }));
    await new GoogleLeadWebhookService().ingest(TOKEN, body());
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join(" ");
    expect(logged).not.toMatch(/Ravi|right-key|wrong-key/);
  });
});
