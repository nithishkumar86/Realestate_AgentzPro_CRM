import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

const { InviteConfirmClient } = await import("@/features/auth/invite-confirm-client");

const INVITATION_ID = "a8195490-82e4-455e-8e78-8e7606616e26";

function openLink(url: string) {
  window.history.replaceState(null, "", url);
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("InviteConfirmClient", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("shows only the withdrawn message — no sign-in button — for a withdrawn invitation", async () => {
    const fetchMock = respond(410, {
      error: { code: "INVITATION_WITHDRAWN", message: "withdrawn", details: { tenantName: "QA Test Co" } },
    });
    openLink(`/auth/confirm?invitation=${INVITATION_ID}#error=access_denied&error_code=otp_expired`);

    render(<InviteConfirmClient />);

    expect(await screen.findByRole("heading", { name: "Invitation withdrawn" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The invitation to join QA Test Co was withdrawn by the organization owner");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ invitationId: INVITATION_ID });
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends the id with the fragment tokens and continues to onboarding for a pending invitation", async () => {
    const fetchMock = respond(200, { redirectTo: "/onboarding" });
    openLink(`/auth/confirm?invitation=${INVITATION_ID}#access_token=a&refresh_token=r&type=invite`);

    render(<InviteConfirmClient />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      invitationId: INVITATION_ID,
      accessToken: "a",
      refreshToken: "r",
    });
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  it("offers sign-in when the link is invalid and the invitation was not withdrawn", async () => {
    respond(401, { error: { code: "INVITE_LINK_INVALID", message: "This invitation link is invalid or has expired. Sign in with your email to continue." } });
    openLink(`/auth/confirm?invitation=${INVITATION_ID}`);

    render(<InviteConfirmClient />);

    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it("does not call the server for a link that carries nothing", async () => {
    const fetchMock = respond(200, {});
    openLink("/auth/confirm");

    render(<InviteConfirmClient />);

    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
