import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/crm-api-client", () => ({
  getGoogleAdsOverview: vi.fn().mockResolvedValue({
    canManage: true,
    connection: null,
    needsReconnect: false,
    linkedAccounts: [],
    webhook: { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null },
    hasWebhook: true,
    webhookStopped: false,
  }),
  createGoogleAdsWebhook: vi.fn(),
  disconnectGoogleAds: vi.fn(),
  getGoogleAdsAccountOptions: vi.fn(),
  saveGoogleAdsAccounts: vi.fn(),
  stopGoogleAdsWebhook: vi.fn().mockResolvedValue({ stopped: true }),
}));

const { GoogleAdsConnectionCard } = await import("@/features/connection/google-ads-connection-card");
const api = await import("@/services/crm-api-client");

afterEach(() => vi.unstubAllGlobals());

describe("GoogleAdsConnectionCard webhook key", () => {
  it("hides the key like a password until Show is clicked, and Copy copies the real key either way", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<GoogleAdsConnectionCard />);

    const key = await screen.findByLabelText("Key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("secret-key-123");

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("secret-key-123"));

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(key.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(key.type).toBe("password");
  });

  it("keeps the webhook URL visible", async () => {
    render(<GoogleAdsConnectionCard />);
    const url = await screen.findByLabelText("Webhook URL") as HTMLInputElement;
    expect(url.type).toBe("text");
  });
});

describe("GoogleAdsConnectionCard step order", () => {
  const notSetUp = { canManage: true, connection: null, needsReconnect: false, linkedAccounts: [], webhook: null, hasWebhook: false, webhookStopped: false };
  const signedIn = {
    canManage: true,
    connection: { email: "owner@example.com", connectedAt: "2026-11-05T07:00:00.000Z" },
    needsReconnect: false,
    linkedAccounts: [],
    webhook: { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null },
    hasWebhook: true,
    webhookStopped: false,
  };

  function stepHeadings(): string[] {
    return screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent ?? "");
  }

  it("tells the owner to complete both steps, then shows Google sign-in as step 1 above the webhook as step 2", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(notSetUp);
    render(<GoogleAdsConnectionCard />);
    await screen.findByRole("button", { name: "Create webhook URL and key" });

    const instruction = screen.getByText("Complete steps 1 and 2 to start receiving leads to your account.");
    const [stepOne] = screen.getAllByRole("heading", { level: 3 });
    expect(instruction.compareDocumentPosition(stepOne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stepHeadings()).toEqual(["1Campaign names", "2Lead form webhook"]);
    expect(screen.queryByText("Optional")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
  });

  it("does not show the setup line to someone who cannot set up Google Ads", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce({ ...notSetUp, canManage: false });
    render(<GoogleAdsConnectionCard />);

    expect(await screen.findByText("Only the company owner can set up Google Ads.")).toBeInTheDocument();
    expect(screen.queryByText("Complete steps 1 and 2 to start receiving leads to your account.")).not.toBeInTheDocument();
  });

  it("never locks the webhook behind sign-in: with nothing set up, both steps can be started", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(notSetUp);
    render(<GoogleAdsConnectionCard />);

    expect(await screen.findByRole("button", { name: "Create webhook URL and key" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/integrations/google/connect");
  });

  it("points Disconnect Google at step 2 for stopping leads", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(signedIn);
    render(<GoogleAdsConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Google" }));

    expect(screen.getByText("This removes only the Google sign-in. Leads keep arriving; new leads will not get campaign names until you sign in again. To stop leads, use Stop receiving Google Ads leads in step 2.")).toBeInTheDocument();
  });
});

describe("GoogleAdsConnectionCard stop leads", () => {
  const stopped = { canManage: true, connection: null, needsReconnect: false, linkedAccounts: [], webhook: null, hasWebhook: false, webhookStopped: true };

  it("stops leads on click, then says so in a pop-up with only an OK button, and shows Disconnected", async () => {
    vi.mocked(api.stopGoogleAdsWebhook).mockClear();
    render(<GoogleAdsConnectionCard />);
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(stopped);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving Google Ads leads" }));
    await waitFor(() => expect(api.stopGoogleAdsWebhook).toHaveBeenCalledTimes(1));

    const popup = await screen.findByRole("alertdialog", { name: "Google Ads leads disconnected" });
    expect(popup).toHaveTextContent("AgentzPro will no longer accept leads from Google Ads. To stop Google from sending them, remove the webhook URL and key from your Google Ads lead forms and save.");
    expect(within(popup).getAllByRole("button").map((button) => button.textContent)).toEqual(["OK"]);
    expect(within(popup).getByRole("button", { name: "OK" })).toHaveFocus();

    fireEvent.click(within(popup).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText("To reconnect, generate a new webhook URL and key and add them to your Google Ads lead forms.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL and key" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Key")).not.toBeInTheDocument();
  });

  it("shows no pop-up when stopping fails, only the error", async () => {
    vi.mocked(api.stopGoogleAdsWebhook).mockRejectedValueOnce(new Error("Google Ads leads could not be stopped. Try again."));
    render(<GoogleAdsConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving Google Ads leads" }));
    expect(await screen.findByText("Google Ads leads could not be stopped. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Receiving leads")).toBeInTheDocument();
  });

  it("opens straight on Disconnected after a reload", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(stopped);
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL and key" })).toBeInTheDocument();
  });
});
