import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { sendExistingAccountInvitationEmail } = await import("@/lib/server/workspace-invitation-email");

const INPUT = { email: "ravi@example.com", companyName: "Ravi <Realty>", loginUrl: "https://crm.example.com/login" };

describe("sendExistingAccountInvitationEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does nothing and reports not sent when Resend is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("INVITE_EMAIL_FROM", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendExistingAccountInvitationEmail(INPUT)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the notice through Resend with the company name escaped", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("INVITE_EMAIL_FROM", "AgentzPro <invites@agentzpro.com>");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendExistingAccountInvitationEmail(INPUT)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["ravi@example.com"]);
    expect(body.subject).toBe("Ravi <Realty> invited you to join them on AgentzPro");
    expect(body.html).toContain("Ravi &lt;Realty&gt;");
    expect(body.html).toContain('href="https://crm.example.com/login"');
  });

  it("reports not sent when Resend rejects or the network fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("INVITE_EMAIL_FROM", "AgentzPro <invites@agentzpro.com>");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await sendExistingAccountInvitationEmail(INPUT)).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await sendExistingAccountInvitationEmail(INPUT)).toBe(false);
  });
});
