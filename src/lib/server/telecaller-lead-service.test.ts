// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelecallerLead } from "@/lib/server/telecaller-lead-service";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));

const context = { tenantId: "tenant-a", userId: "user-a" };
const input = { leadName: "Ravi", phone: "98765 43210", projectName: "Karuvi" };

beforeEach(() => vi.resetAllMocks());

describe("createTelecallerLead", () => {
  it("calls the RPC with the session tenant and user, never values from the request", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    await expect(createTelecallerLead(context, { ...input, whatsapp: "9876500000" })).resolves.toEqual({ id: "lead-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("create_telecaller_lead", {
      p_tenant_id: "tenant-a", p_actor_user_id: "user-a", p_lead_name: "Ravi", p_phone: "98765 43210", p_whatsapp: "9876500000", p_project_name: "Karuvi",
    });
  });

  it("sends a null WhatsApp when none was given", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    await createTelecallerLead(context, input);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_whatsapp: null });
  });

  it.each([
    [{ code: "P0001", message: "LEAD_PHONE_EXISTS" }, 409, "LEAD_PHONE_EXISTS", "This phone number already exists as a lead."],
    [{ code: "42501", message: "Actor is not an active member of this tenant" }, 403, "LEAD_CREATE_FORBIDDEN", "You are not allowed to add leads for this company."],
    [{ code: "22023", message: "Enter a valid phone number" }, 400, "INVALID_LEAD", "Enter a valid phone number"],
    [{ code: "XX000", message: "boom" }, 500, "LEAD_CREATE_FAILED", "The lead could not be saved."],
  ])("maps database error %o to HTTP %i", async (error, status, code, message) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(createTelecallerLead(context, input)).rejects.toMatchObject({ status, code, message });
  });
});
