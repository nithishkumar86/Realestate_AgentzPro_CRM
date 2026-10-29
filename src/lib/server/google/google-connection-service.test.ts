// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => value.replace(/^enc:/, "") }));
vi.mock("@/lib/server/google/google-oauth", () => ({}));
vi.mock("@/lib/server/google/google-ads-client", () => ({}));

import { GoogleConnectionService } from "@/lib/server/google/google-connection-service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue({ update: mocks.update });
  mocks.update.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockResolvedValue({ error: null });
});

describe("GoogleConnectionService.stopWebhook", () => {
  it("switches off only the owner's own company webhook, so its deliveries are refused", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    await new GoogleConnectionService().stopWebhook();
    expect(mocks.from).toHaveBeenCalledWith("google_lead_webhooks");
    expect(mocks.update).toHaveBeenCalledWith({ is_active: false });
    expect(mocks.eq).toHaveBeenCalledTimes(1);
    expect(mocks.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" });
    await expect(new GoogleConnectionService().stopWebhook()).rejects.toMatchObject({ status: 403, code: "GOOGLE_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("reports a database failure instead of claiming leads stopped", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.eq.mockResolvedValue({ error: { message: "db down" } });
    await expect(new GoogleConnectionService().stopWebhook()).rejects.toMatchObject({ status: 500, code: "GOOGLE_WEBHOOK_STOP_FAILED" });
  });
});

describe("GoogleConnectionService.getOverview", () => {
  // Every query in getOverview ends in maybeSingle() or limit(); anything else in the chain returns the chain.
  function table(result: { data: unknown; error: null }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order"]) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.limit = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  }

  it("reports a switched-off webhook as stopped and never returns its URL or old key", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.from.mockImplementation((name: string) => name === "google_lead_webhooks"
      ? table({ data: { url_token: "token", encrypted_google_key: "enc:old-key", is_active: false, last_lead_received_at: null, last_test_received_at: null }, error: null })
      : table({ data: name === "google_connections" ? null : [], error: null }));
    const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
    expect(overview).toMatchObject({ hasWebhook: false, webhookStopped: true, webhook: null });
    expect(JSON.stringify(overview)).not.toContain("old-key");
  });

  it("reports an active webhook as receiving leads", async () => {
    mocks.access.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" });
    mocks.from.mockImplementation((name: string) => name === "google_lead_webhooks"
      ? table({ data: { url_token: "token", encrypted_google_key: "enc:live-key", is_active: true, last_lead_received_at: null, last_test_received_at: null }, error: null })
      : table({ data: name === "google_connections" ? null : [], error: null }));
    const overview = await new GoogleConnectionService().getOverview("https://crm.example.com");
    expect(overview).toMatchObject({ hasWebhook: true, webhookStopped: false, webhook: { key: "live-key" } });
  });
});
