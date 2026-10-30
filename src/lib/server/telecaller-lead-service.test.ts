// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelecallerLead, listCallInOrigins } from "@/lib/server/telecaller-lead-service";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));

const context = { tenantId: "tenant-a", userId: "user-a" };
const input = { leadName: "Ravi", phone: "98765 43210", projectName: "Karuvi" };

beforeEach(() => vi.resetAllMocks());

describe("createTelecallerLead", () => {
  it("calls the RPC with the session tenant and user, never values from the request", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    await expect(createTelecallerLead(context, { ...input, whatsapp: "9876500000", cameFromPlatform: "facebook", cameFromRefId: "120200", callDate: "2026-10-01" })).resolves.toEqual({ id: "lead-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("create_call_in_lead", {
      p_tenant_id: "tenant-a", p_actor_user_id: "user-a", p_lead_name: "Ravi", p_phone: "98765 43210", p_whatsapp: "9876500000", p_project_name: "Karuvi",
      p_came_from_platform: "facebook", p_came_from_ref_id: "120200", p_call_date: "2026-10-01",
    });
  });

  it("sends a null WhatsApp when none was given", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    await createTelecallerLead(context, input);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_whatsapp: null, p_came_from_platform: null, p_came_from_ref_id: null, p_call_date: null });
  });

  it.each([
    [{ code: "P0001", message: "LEAD_PHONE_EXISTS" }, 409, "LEAD_PHONE_EXISTS", "This phone number already exists as a lead."],
    [{ code: "P0001", message: "CALL_IN_ORIGIN_CHANGED" }, 409, "CALL_IN_ORIGIN_CHANGED", "The connected lead platforms or ads changed. Check \"Came from\" and save again."],
    [{ code: "42501", message: "Actor is not an active member of this tenant" }, 403, "LEAD_CREATE_FORBIDDEN", "You are not allowed to add leads for this company."],
    [{ code: "22023", message: "Enter a valid phone number" }, 400, "INVALID_LEAD", "Enter a valid phone number"],
    [{ code: "XX000", message: "boom" }, 500, "LEAD_CREATE_FAILED", "The lead could not be saved."],
  ])("maps database error %o to HTTP %i", async (error, status, code, message) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(createTelecallerLead(context, input)).rejects.toMatchObject({ status, code, message });
  });
});

describe("listCallInOrigins", () => {
  it("asks the database for the session tenant's connected platforms and labels them", async () => {
    mocks.rpc.mockResolvedValue({ data: { today: "2026-10-30", minDate: "2025-10-30", platforms: [
      { id: "facebook", refs: [{ id: "120200", name: "Villa Ad" }] },
      { id: "google_ads", refs: [] },
    ] }, error: null });
    await expect(listCallInOrigins(context)).resolves.toEqual({ today: "2026-10-30", minDate: "2025-10-30", platforms: [
      { id: "facebook", label: "Facebook", refs: [{ id: "120200", name: "Villa Ad" }] },
      { id: "google_ads", label: "Google Ads", refs: [] },
    ] });
    expect(mocks.rpc).toHaveBeenCalledWith("list_call_in_origins", { p_tenant_id: "tenant-a" });
  });

  it("drops a platform the app does not know and malformed refs", async () => {
    mocks.rpc.mockResolvedValue({ data: { today: "2026-10-30", minDate: "2025-10-30", platforms: [
      { id: "telecaller", refs: [] }, { id: "facebook", refs: [{ id: 1, name: "bad" }, { id: "7", name: "Good" }] },
    ] }, error: null });
    const result = await listCallInOrigins(context);
    expect(result.platforms).toEqual([{ id: "facebook", label: "Facebook", refs: [{ id: "7", name: "Good" }] }]);
  });

  it("fails cleanly when the database errors or answers something unexpected", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(listCallInOrigins(context)).rejects.toMatchObject({ status: 500, code: "CALL_IN_ORIGINS_FAILED" });
    mocks.rpc.mockResolvedValue({ data: { today: "2026-10-30" }, error: null });
    await expect(listCallInOrigins(context)).rejects.toMatchObject({ status: 500, code: "CALL_IN_ORIGINS_FAILED" });
  });
});
