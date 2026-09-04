import { describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({ rpc: rpcMock }),
}));

const { completeOwnerOnboarding } = await import("@/lib/server/auth/onboarding-service");

const VALID_INPUT = {
  fullName: "Ravi Kumar",
  phoneNumber: "9876543210",
  companyName: "BRIQ Aastha",
  professionalRole: "Real Estate Agent",
};

describe("completeOwnerOnboarding", () => {
  it("rejects an empty full name", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, fullName: "" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a full name that is only whitespace", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, fullName: "   " })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a full name over 200 characters", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, fullName: "a".repeat(201) })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a company name over 200 characters", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, companyName: "a".repeat(201) })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a professional role over 120 characters", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, professionalRole: "a".repeat(121) })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ONBOARDING_INPUT",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a phone number with no extractable digits", async () => {
    rpcMock.mockClear();
    await expect(completeOwnerOnboarding({ ...VALID_INPUT, phoneNumber: "not-a-phone" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PHONE_NUMBER",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("normalizes the phone number to E.164-style digits before calling the RPC", async () => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: [{ tenant_id: "tenant-1", subscription_status: "trialing" }], error: null });

    await completeOwnerOnboarding({ ...VALID_INPUT, phoneNumber: "09876543210" });

    expect(rpcMock).toHaveBeenCalledWith("complete_owner_onboarding", {
      p_full_name: "Ravi Kumar",
      p_phone_number: "919876543210",
      p_tenant_name: "BRIQ Aastha",
      p_professional_role: "Real Estate Agent",
    });
  });

  it("ignores a browser-supplied user_id, tenant_id, or membership_role in the input", async () => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: [{ tenant_id: "server-generated-tenant", subscription_status: "trialing" }], error: null });

    await completeOwnerOnboarding({
      ...VALID_INPUT,
      user_id: "attacker-supplied-uuid",
      tenant_id: "attacker-supplied-tenant",
      membership_role: "admin",
    });

    const [, rpcParams] = rpcMock.mock.calls[0];
    expect(Object.keys(rpcParams).sort()).toEqual(["p_full_name", "p_phone_number", "p_professional_role", "p_tenant_name"]);
    expect(rpcParams).not.toHaveProperty("user_id");
    expect(rpcParams).not.toHaveProperty("tenant_id");
    expect(rpcParams).not.toHaveProperty("membership_role");
  });

  it("returns the server-generated tenantId and subscriptionStatus on success", async () => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: [{ tenant_id: "tenant-42", subscription_status: "trialing" }], error: null });

    await expect(completeOwnerOnboarding(VALID_INPUT)).resolves.toEqual({
      tenantId: "tenant-42",
      subscriptionStatus: "trialing",
    });
  });

  it("throws ONBOARDING_FAILED when the RPC returns an error", async () => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: null, error: { message: "unique_violation" } });

    await expect(completeOwnerOnboarding(VALID_INPUT)).rejects.toMatchObject({
      status: 500,
      code: "ONBOARDING_FAILED",
    });
  });
});
