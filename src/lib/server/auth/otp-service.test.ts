import { describe, expect, it, vi, beforeEach } from "vitest";

const signInWithOtpMock = vi.fn();
const verifyOtpMock = vi.fn();

vi.mock("@/lib/server/auth/supabase-auth-client", () => ({
  createAuthClient: async () => ({
    auth: {
      signInWithOtp: signInWithOtpMock,
      verifyOtp: verifyOtpMock,
    },
  }),
}));

const verifyTurnstileTokenMock = vi.fn();
vi.mock("@/lib/server/auth/turnstile", () => ({
  verifyTurnstileToken: verifyTurnstileTokenMock,
}));

const checkOtpSendCooldownMock = vi.fn();
const checkOtpSendEmailWindowMock = vi.fn();
const checkOtpSendIpWindowMock = vi.fn();
const isOtpVerifyBlockedMock = vi.fn();
const recordFailedOtpVerificationMock = vi.fn();

vi.mock("@/lib/server/auth/rate-limit", () => ({
  checkOtpSendCooldown: checkOtpSendCooldownMock,
  checkOtpSendEmailWindow: checkOtpSendEmailWindowMock,
  checkOtpSendIpWindow: checkOtpSendIpWindowMock,
  isOtpVerifyBlocked: isOtpVerifyBlockedMock,
  recordFailedOtpVerification: recordFailedOtpVerificationMock,
}));

const { requestOtp, verifyOtp } = await import("@/lib/server/auth/otp-service");

const ALLOWED = { allowed: true, bypassed: false };
const DENIED = { allowed: false, bypassed: false, retryAfterSeconds: 60 };

const PARAMS = { email: "Owner@Example.com", turnstileToken: "token-123", sourceIp: "203.0.113.1" };

describe("requestOtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyTurnstileTokenMock.mockResolvedValue({ verified: true, bypassed: false });
    checkOtpSendCooldownMock.mockResolvedValue(ALLOWED);
    checkOtpSendEmailWindowMock.mockResolvedValue(ALLOWED);
    checkOtpSendIpWindowMock.mockResolvedValue(ALLOWED);
    signInWithOtpMock.mockResolvedValue({ data: {}, error: null });
  });

  it("does not call Supabase when Turnstile verification fails", async () => {
    verifyTurnstileTokenMock.mockResolvedValue({ verified: false, bypassed: false });

    await expect(requestOtp(PARAMS)).resolves.toBeUndefined();
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("does not call Supabase when Turnstile itself is unreachable", async () => {
    verifyTurnstileTokenMock.mockRejectedValue(new Error("network down"));

    await expect(requestOtp(PARAMS)).resolves.toBeUndefined();
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("does not call Supabase when the email cooldown is exceeded", async () => {
    checkOtpSendCooldownMock.mockResolvedValue(DENIED);

    await requestOtp(PARAMS);
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("does not call Supabase when the email hourly window is exceeded", async () => {
    checkOtpSendEmailWindowMock.mockResolvedValue(DENIED);

    await requestOtp(PARAMS);
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("does not call Supabase when the IP hourly window is exceeded", async () => {
    checkOtpSendIpWindowMock.mockResolvedValue(DENIED);

    await requestOtp(PARAMS);
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("calls Supabase with the normalized email once every check passes", async () => {
    await requestOtp(PARAMS);

    expect(signInWithOtpMock).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: { shouldCreateUser: true, captchaToken: "token-123" },
    });
  });

  it("does not throw when Supabase itself returns an error", async () => {
    signInWithOtpMock.mockResolvedValue({ data: {}, error: { message: "rate limited" } });

    await expect(requestOtp(PARAMS)).resolves.toBeUndefined();
  });
});

describe("verifyOtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOtpVerifyBlockedMock.mockResolvedValue(ALLOWED);
  });

  it("does not call Supabase verifyOtp when already blocked", async () => {
    isOtpVerifyBlockedMock.mockResolvedValue({ allowed: false, bypassed: false, retryAfterSeconds: 1200 });

    const result = await verifyOtp({ email: "owner@example.com", otp: "123456", sourceIp: "203.0.113.1" });

    expect(result).toEqual({ verified: false, blocked: true });
    expect(verifyOtpMock).not.toHaveBeenCalled();
  });

  it("returns verified with the userId on a successful verification", async () => {
    verifyOtpMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    const result = await verifyOtp({ email: "owner@example.com", otp: "123456", sourceIp: "203.0.113.1" });

    expect(result).toEqual({ verified: true, userId: "user-1" });
    expect(recordFailedOtpVerificationMock).not.toHaveBeenCalled();
  });

  it("records a failed attempt and returns not verified on a wrong OTP", async () => {
    verifyOtpMock.mockResolvedValue({ data: { user: null }, error: { message: "invalid otp" } });

    const result = await verifyOtp({ email: "owner@example.com", otp: "000000", sourceIp: "203.0.113.1" });

    expect(result).toEqual({ verified: false });
    expect(recordFailedOtpVerificationMock).toHaveBeenCalledWith("owner@example.com", "203.0.113.1");
  });
});
