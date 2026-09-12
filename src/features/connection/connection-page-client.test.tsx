import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadFacebookSdk = vi.fn();

vi.mock("@/features/connection/facebook-sdk", () => ({ loadFacebookSdk }));
vi.mock("@/services/crm-api-client", async (importOriginal) => ({
  // ApiError is a real class the component branches on with instanceof, so it must come from the
  // actual module rather than be stubbed away.
  ApiError: (await importOriginal<typeof import("@/services/crm-api-client")>()).ApiError,
  getConnectionOverview: vi.fn().mockResolvedValue({ connectionStatus: "not_connected", pages: [] }),
  connectSelectedPages: vi.fn(),
  disconnectFacebookPage: vi.fn(),
  disconnectMetaConnection: vi.fn(),
  startMetaConnection: vi.fn(),
}));

vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "app-1");
vi.stubEnv("NEXT_PUBLIC_META_LOGIN_CONFIG_ID", "config-1");
vi.stubEnv("NEXT_PUBLIC_META_GRAPH_API_VERSION", "v25.0");

const { ConnectionPageClient } = await import("@/features/connection/connection-page-client");
const { getConnectionOverview, startMetaConnection } = await import("@/services/crm-api-client");

type FacebookLoginResponse = Parameters<Parameters<NonNullable<Window["FB"]>["login"]>[0]>[0];

function connectButtons(): HTMLButtonElement[] {
  return screen.getAllByRole("button", { name: /Connect Facebook/i }) as HTMLButtonElement[];
}

describe("ConnectionPageClient Facebook SDK readiness", () => {
  beforeEach(() => {
    loadFacebookSdk.mockReset();
  });

  it("keeps Connect Facebook disabled until the SDK is initialized", async () => {
    let finishInitialization: () => void = () => {};
    loadFacebookSdk.mockReturnValue(new Promise<void>((resolve) => { finishInitialization = resolve; }));
    render(<ConnectionPageClient />);

    await waitFor(() => expect(connectButtons().length).toBeGreaterThan(0));
    expect(connectButtons().every((button) => button.disabled)).toBe(true);
    expect(loadFacebookSdk).toHaveBeenCalledWith("app-1", "v25.0");

    await act(async () => { finishInitialization(); });
    await waitFor(() => expect(connectButtons().every((button) => !button.disabled)).toBe(true));
  });

  it("enables Connect Facebook again when the page remounts after client-side navigation", async () => {
    loadFacebookSdk.mockResolvedValue(undefined);
    const firstVisit = render(<ConnectionPageClient />);
    await waitFor(() => expect(connectButtons().every((button) => !button.disabled)).toBe(true));

    firstVisit.unmount();
    render(<ConnectionPageClient />);

    await waitFor(() => expect(connectButtons().every((button) => !button.disabled)).toBe(true));
  });

  it("shows the loading failure and keeps the button disabled when the SDK cannot load", async () => {
    loadFacebookSdk.mockRejectedValue(new Error("Facebook authorization could not be loaded."));
    render(<ConnectionPageClient />);

    expect(await screen.findByText("Facebook authorization could not be loaded.")).toBeInTheDocument();
    expect(connectButtons().every((button) => button.disabled)).toBe(true);
  });

  it.each([
    ["reauthorization_required", true],
    ["active", false],
  ] as const)("shows the reconnect prompt only when the connection status is %s", async (connectionStatus, shown) => {
    loadFacebookSdk.mockResolvedValue(undefined);
    vi.mocked(getConnectionOverview).mockResolvedValueOnce({ connectionStatus, pages: [] });
    render(<ConnectionPageClient />);
    await screen.findByText("Connection summary");
    expect(screen.queryByText("Facebook authorization needs to be renewed.") !== null).toBe(shown);
  });

  describe("Facebook login response", () => {
    function stubLogin(response: FacebookLoginResponse): void {
      window.FB = { init: vi.fn(), login: vi.fn((callback: (value: FacebookLoginResponse) => void) => callback(response)) };
    }

    async function clickConnect(): Promise<void> {
      loadFacebookSdk.mockResolvedValue(undefined);
      render(<ConnectionPageClient />);
      await waitFor(() => expect(connectButtons().every((button) => !button.disabled)).toBe(true));
      await act(async () => { fireEvent.click(connectButtons()[0]); });
    }

    beforeEach(() => { vi.mocked(startMetaConnection).mockClear(); });
    afterEach(() => { delete window.FB; });

    it.each([
      [{ status: "not_authorized", authResponse: null } as const, "Facebook access was not approved. Approve the requested permissions to connect your Pages."],
      [{ status: "unknown", authResponse: null } as const, "Facebook login was cancelled. Log in to Facebook to connect your Pages."],
    ])("explains %j without contacting the server", async (response, message) => {
      stubLogin(response);
      await clickConnect();
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(startMetaConnection).not.toHaveBeenCalled();
      expect(connectButtons().every((button) => !button.disabled)).toBe(true);
    });

    it("sends the token from a connected response to the server", async () => {
      vi.mocked(startMetaConnection).mockResolvedValue({ connectionId: "connection-1", pages: [] });
      stubLogin({ status: "connected", authResponse: { accessToken: "short-lived-token", expiresIn: 3600, userID: "user-1", signedRequest: "signed" } });
      await clickConnect();
      await waitFor(() => expect(startMetaConnection).toHaveBeenCalledWith("short-lived-token"));
    });
  });

  it("explains the missing public Meta configuration instead of loading the SDK", async () => {
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "");
    vi.resetModules();
    const { ConnectionPageClient: UnconfiguredConnectionPageClient } = await import("@/features/connection/connection-page-client");
    render(<UnconfiguredConnectionPageClient />);

    expect(await screen.findByText("Facebook authorization is not available. Verify the public Meta configuration.")).toBeInTheDocument();
    await waitFor(() => expect(connectButtons().length).toBeGreaterThan(0));
    expect(connectButtons().every((button) => button.disabled)).toBe(true);
    expect(loadFacebookSdk).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "app-1");
  });
});
