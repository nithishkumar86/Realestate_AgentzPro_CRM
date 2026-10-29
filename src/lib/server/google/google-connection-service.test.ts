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
