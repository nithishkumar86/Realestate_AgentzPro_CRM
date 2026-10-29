import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/crm-api-client", () => ({
  getGoogleAdsOverview: vi.fn().mockResolvedValue({
    canManage: true,
    connection: null,
    needsReconnect: false,
    linkedAccounts: [],
    webhook: { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null },
    hasWebhook: true,
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
  it("stops Google Ads leads only after a confirm, then shows the webhook as not set up", async () => {
    render(<GoogleAdsConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving Google Ads leads" }));
    expect(api.stopGoogleAdsWebhook).not.toHaveBeenCalled();
    expect(screen.getByText(/refuses every Google Ads lead from now on/)).toBeInTheDocument();

    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce({ canManage: true, connection: null, needsReconnect: false, linkedAccounts: [], webhook: null, hasWebhook: false });
    fireEvent.click(screen.getByRole("button", { name: "Stop receiving Google Ads leads" }));
    await waitFor(() => expect(api.stopGoogleAdsWebhook).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Google Ads leads stopped. No new Google Ads leads will be saved.")).toBeInTheDocument();
    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create webhook URL and key" })).toBeInTheDocument();
  });

  it("can be cancelled without stopping anything", async () => {
    vi.mocked(api.stopGoogleAdsWebhook).mockClear();
    render(<GoogleAdsConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving Google Ads leads" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    expect(api.stopGoogleAdsWebhook).not.toHaveBeenCalled();
    expect(screen.queryByText(/refuses every Google Ads lead from now on/)).not.toBeInTheDocument();
  });
});
