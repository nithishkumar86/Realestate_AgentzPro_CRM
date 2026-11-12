// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => value.replace(/^enc:/, "") }));

import { hashCustomWebhookToken } from "@/lib/server/custom-webhook/custom-lead-webhook-service";
import { CustomWebhookConnectionService } from "@/lib/server/custom-webhook/custom-webhook-connection-service";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain, maybeSingle() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "insert", "update"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

beforeEach(() => vi.resetAllMocks());

describe("CustomWebhookConnectionService.getOverview", () => {
  const row = (extra: Record<string, unknown> = {}) => ({ encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_lead_received_at: null, url_rotated_at: null, ...extra });

  it("gives the owner the URL only when the Connection card asks for it", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: row({ last_lead_received_at: "2026-11-11T10:00:00Z" }), error: null }));
    const service = new CustomWebhookConnectionService();
    await expect(service.getOverview(ORIGIN, { includeUrl: true })).resolves.toEqual({
      canManage: true, hasWebhook: true, webhookStopped: false,
      webhook: { url: `${ORIGIN}/api/webhooks/custom/${TOKEN}`, lastLeadAt: "2026-11-11T10:00:00Z" },
    });
    // The /leads and dashboard source check: on / stopped only, never the URL.
    await expect(service.getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasWebhook: true, webhookStopped: false, webhook: null });
  });

  it("never gives an employee the URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    mocks.from.mockImplementation(() => chain({ data: row(), error: null }));
    await expect(new CustomWebhookConnectionService().getOverview(ORIGIN, { includeUrl: true })).resolves.toEqual({ canManage: false, hasWebhook: true, webhookStopped: false, webhook: null });
  });

  it("reports a stopped webhook as stopped, never with its old URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: row({ is_active: false }), error: null }));
    await expect(new CustomWebhookConnectionService().getOverview(ORIGIN, { includeUrl: true })).resolves.toEqual({ canManage: true, hasWebhook: false, webhookStopped: true, webhook: null });
  });

  it("reports no webhook as neither on nor stopped", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: null, error: null }));
    await expect(new CustomWebhookConnectionService().getOverview(ORIGIN, { includeUrl: true })).resolves.toEqual({ canManage: true, hasWebhook: false, webhookStopped: false, webhook: null });
  });

  it("counts only a lead received after the URL was last replaced", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: row({ last_lead_received_at: "2026-11-11T10:00:00Z", url_rotated_at: "2026-11-11T11:00:00Z" }), error: null }));
    const overview = await new CustomWebhookConnectionService().getOverview(ORIGIN, { includeUrl: true });
    expect(overview.webhook?.lastLeadAt).toBeNull();
  });

  it("reads only the signed-in company's row", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: null, error: null });
    mocks.from.mockReturnValue(query);
    await new CustomWebhookConnectionService().getOverview(ORIGIN);
    expect(mocks.from).toHaveBeenCalledWith("custom_lead_webhooks");
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("fails loudly instead of claiming there is no webhook when the read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: null, error: { message: "down" } }));
    await expect(new CustomWebhookConnectionService().getOverview(ORIGIN)).rejects.toMatchObject({ status: 500, code: "CUSTOM_WEBHOOK_OVERVIEW_FAILED" });
  });
});

describe("CustomWebhookConnectionService.createOrReplace", () => {
  it("creates the webhook with only the token's hash and an encrypted copy, never the plain token", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: null, error: null });
    const insert = chain({ error: null });
    mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(insert);
    const { url } = await new CustomWebhookConnectionService().createOrReplace(ORIGIN);
    const token = url.split("/").pop() ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(insert.insert).toHaveBeenCalledWith({ tenant_id: "tenant-a", url_token_hash: hashCustomWebhookToken(token), encrypted_url_token: `enc:${token}`, is_active: true });
    expect(JSON.stringify(insert.insert.mock.calls[0][0]).replace(`enc:${token}`, "")).not.toContain(token);
  });

  it("replaces the URL of an existing webhook: new hash, switched on, rotation time set", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: { id: "webhook-1" }, error: null });
    const update = chain({ error: null });
    mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(update);
    const { url } = await new CustomWebhookConnectionService().createOrReplace(ORIGIN);
    const token = url.split("/").pop() ?? "";
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ url_token_hash: hashCustomWebhookToken(token), encrypted_url_token: `enc:${token}`, is_active: true, url_rotated_at: expect.any(String) }));
    expect(update.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("issues a different URL every time, so the old one stops working", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation(() => chain({ data: { id: "webhook-1" }, error: null }));
    const service = new CustomWebhookConnectionService();
    const first = await service.createOrReplace(ORIGIN);
    const second = await service.createOrReplace(ORIGIN);
    expect(first.url).not.toBe(second.url);
  });

  it("replaces instead of failing when another request created the webhook at the same moment", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: null, error: null });
    const insert = chain({ error: { code: "23505", message: "duplicate" } });
    const update = chain({ error: null });
    mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(insert).mockReturnValueOnce(update);
    await expect(new CustomWebhookConnectionService().createOrReplace(ORIGIN)).resolves.toHaveProperty("url");
    expect(update.update).toHaveBeenCalled();
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new CustomWebhookConnectionService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "CUSTOM_WEBHOOK_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValueOnce(chain({ data: null, error: null })).mockReturnValueOnce(chain({ error: { code: "XX000", message: "down" } }));
    await expect(new CustomWebhookConnectionService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "CUSTOM_WEBHOOK_SAVE_FAILED" });
  });
});

describe("CustomWebhookConnectionService.stop", () => {
  it("switches off only the owner's own company webhook", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const update = chain({ error: null });
    mocks.from.mockReturnValue(update);
    await new CustomWebhookConnectionService().stop();
    expect(mocks.from).toHaveBeenCalledWith("custom_lead_webhooks");
    expect(update.update).toHaveBeenCalledWith({ is_active: false });
    expect(update.eq).toHaveBeenCalledTimes(1);
    expect(update.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("refuses an employee, and reports a database failure instead of claiming leads stopped", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new CustomWebhookConnectionService().stop()).rejects.toMatchObject({ status: 403 });
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ error: { message: "down" } }));
    await expect(new CustomWebhookConnectionService().stop()).rejects.toMatchObject({ status: 500, code: "CUSTOM_WEBHOOK_STOP_FAILED" });
  });
});
