import { beforeEach, describe, expect, it, vi } from "vitest";

const requireCrmAccess = vi.fn();
const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess }));
vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({
    auth: { getUser },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
  }),
}));

const { getCurrentProfileDetails } = await import("@/lib/server/profile-query-service");

describe("getCurrentProfileDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCrmAccess.mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-1",
      tenantName: "AgentzPro Realty",
      fullName: "Nithish Kumar",
    });
    getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "nithish@example.com" } },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: {
        user_id: "user-1",
        full_name: "Nithish Kumar",
        phone_number: "919876543210",
        professional_role: "Real Estate Agent",
      },
      error: null,
    });
  });

  it("returns only the five approved profile fields", async () => {
    await expect(getCurrentProfileDetails()).resolves.toEqual({
      fullName: "Nithish Kumar",
      phoneNumber: "919876543210",
      emailAddress: "nithish@example.com",
      companyName: "AgentzPro Realty",
      professionalRole: "Real Estate Agent",
    });
  });

  it("rejects an authenticated user mismatch", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-2", email: "other@example.com" } }, error: null });

    await expect(getCurrentProfileDetails()).rejects.toMatchObject({
      status: 401,
      code: "PROFILE_AUTHENTICATION_FAILED",
    });
  });

  it("returns a retryable error when the profile query fails", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "database unavailable" } });

    await expect(getCurrentProfileDetails()).rejects.toMatchObject({
      status: 500,
      code: "PROFILE_LOAD_FAILED",
      retryable: true,
    });
  });
});
