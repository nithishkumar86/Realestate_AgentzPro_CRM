// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdNameResolutionService } from "@/lib/server/ad-name-resolution-service";
import { MetaClient } from "@/lib/server/meta-client";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => mocks }));
vi.mock("@/lib/server/token-crypto", () => ({ decryptToken: mocks.decrypt }));

const claimed = { tenant_id: "tenant", ad_id: "ad-1", source_facebook_page_record_id: "page", claim_token: "claim-1", retry_count: 1 };
const page = { tenant_id: "tenant", connection_status: "active", token_status: "active", meta_connections: { long_lived_user_access_token_encrypted: "cipher", connection_status: "active", user_token_status: "active" } };

function pageQuery() {
  const builder = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: page, error: null }) };
  builder.select.mockReturnValue(builder); builder.eq.mockReturnValue(builder); return builder;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.decrypt.mockReturnValue("user-token");
  mocks.from.mockReturnValue(pageQuery());
  mocks.rpc.mockImplementation(async (name: string) => name === "claim_due_meta_ad_name_resolution" ? { data: null, error: null } : { data: true, error: null });
});

describe("AdNameResolutionService", () => {
  it("claims one mapping, resolves the Meta name, and completes it", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "claim_due_meta_ad_name_resolution" ? { data: claimed, error: null } : { data: true, error: null });
    vi.spyOn(MetaClient.prototype, "retrieveAdName").mockResolvedValue("Campaign Alpha");
    await new AdNameResolutionService().resolveDue(1);
    expect(MetaClient.prototype.retrieveAdName).toHaveBeenCalledWith("ad-1", "user-token");
    expect(mocks.rpc).toHaveBeenCalledWith("complete_meta_ad_name_resolution", expect.objectContaining({ p_tenant_id: "tenant", p_ad_id: "ad-1", p_claim_token: "claim-1", p_ad_name: "Campaign Alpha" }));
  });

  it("records a bounded retry when Meta has a transient failure", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "claim_due_meta_ad_name_resolution" ? { data: claimed, error: null } : { data: true, error: null });
    vi.spyOn(MetaClient.prototype, "retrieveAdName").mockRejectedValue(new Error("network timeout"));
    await new AdNameResolutionService().resolveDue(1);
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_meta_ad_name_resolution_retry", expect.objectContaining({ p_status: "transient_error", p_tenant_id: "tenant", p_ad_id: "ad-1" }));
  });
});
