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

describe("GoogleAdsConnectionCard stop leads", () => {
  const stopped = { canManage: true, connection: null, needsReconnect: false, linkedAccounts: [], webhook: null, hasWebhook: false, webhookStopped: true };

  it("stops leads on click, then says so in a pop-up with only an OK button, and shows Disconnected", async () => {
    vi.mocked(api.stopGoogleAdsWebhook).mockClear();
    render(<GoogleAdsConnectionCard />);
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(stopped);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving Google Ads leads" }));
    await waitFor(() => expect(api.stopGoogleAdsWebhook).toHaveBeenCalledTimes(1));

    const popup = await screen.findByRole("alertdialog", { name: "Receiving leads from our side is stopped" });
    expect(popup).toHaveTextContent("From your side, remove the webhook URL and key from your Google Ads account lead forms and save, to fully stop lead sending.");
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
