import { beforeEach, describe, expect, it, vi } from "vitest";

const requireCrmAccess = vi.fn();
const getCurrentProfileDetails = vi.fn();
const update = vi.fn();
const eq = vi.fn();
const maybeSingle = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess }));
vi.mock("@/lib/server/profile-query-service", () => ({ getCurrentProfileDetails }));
vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({
    from: vi.fn(() => ({ update })),
  }),
}));

const { updateCurrentProfile } = await import("@/lib/server/profile-update-service");

const PROFILE = {
  fullName: "Ravi Kumar",
  phoneNumber: "919123456780",
  emailAddress: "ravi@example.com",
  companyName: "AgentzPro Realty",
  professionalRole: "Sales Executive",
};

describe("updateCurrentProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCrmAccess.mockResolvedValue({ userId: "user-1", tenantId: "tenant-1", tenantName: "AgentzPro Realty" });
    update.mockReturnValue({ eq });
    eq.mockReturnValue({ select: vi.fn(() => ({ maybeSingle })) });
    maybeSingle.mockResolvedValue({ data: { user_id: "user-1" }, error: null });
    getCurrentProfileDetails.mockResolvedValue(PROFILE);
  });

  it("updates only the signed-in person's name, tidied, and returns the refreshed profile", async () => {
    await expect(updateCurrentProfile({ fullName: "  Ravi   Kumar " })).resolves.toEqual(PROFILE);

    expect(update).toHaveBeenCalledWith({ full_name: "Ravi Kumar" });
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("stores the phone in the same 91-prefixed form as sign-up", async () => {
    await updateCurrentProfile({ phoneNumber: "9123456780" });

    expect(update).toHaveBeenCalledWith({ phone_number: "919123456780" });
  });

  it.each([
    { companyName: "Other Co" },
    { professionalRole: "Owner" },
    { fullName: "Ravi Kumar", professionalRole: "Owner" },
    { emailAddress: "x@example.com" },
  ])("refuses to change anything but name and phone: %o", async (input) => {
    await expect(updateCurrentProfile(input)).rejects.toMatchObject({ status: 400, code: "INVALID_PROFILE_UPDATE" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an empty or missing body", async () => {
    await expect(updateCurrentProfile({})).rejects.toMatchObject({ status: 400 });
    await expect(updateCurrentProfile(null)).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("applies the sign-up validation rules with field errors", async () => {
    await expect(updateCurrentProfile({ phoneNumber: "5123456780" })).rejects.toMatchObject({
      status: 400,
      details: { fieldErrors: { phoneNumber: "Enter a valid Indian mobile number starting with 6, 7, 8 or 9." } },
    });
    await expect(updateCurrentProfile({ fullName: "R2D2" })).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a retryable failure when the row was not updated", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(updateCurrentProfile({ fullName: "Ravi Kumar" })).rejects.toMatchObject({
      status: 500,
      code: "PROFILE_UPDATE_FAILED",
      retryable: true,
    });
    expect(getCurrentProfileDetails).not.toHaveBeenCalled();
  });
});
