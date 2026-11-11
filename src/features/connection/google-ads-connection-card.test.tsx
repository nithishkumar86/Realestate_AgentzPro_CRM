import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/crm-api-client", () => ({
  getGoogleAdsOverview: vi.fn().mockResolvedValue({
    canManage: true,
    connection: null,
    needsReconnect: false,
    linkedAccounts: [],
    webhook: { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null, campaigns: null },
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
    webhook: { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null, campaigns: null },
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
    expect(screen.getByText("Lead arrival stopped")).toBeInTheDocument();
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
    expect(screen.getByText("Lead arrival stopped")).toBeInTheDocument();
    expect(screen.queryByText("Leads arriving")).not.toBeInTheDocument();
    expect(screen.queryByText(/Running more campaigns\?/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL and key" })).toBeInTheDocument();
  });
});

describe("GoogleAdsConnectionCard lead status", () => {
  const webhook = { url: "https://crm.example.com/api/webhooks/google-ads/token", key: "secret-key-123", lastLeadAt: null, lastTestAt: null, campaigns: null };
  const live = { canManage: true, connection: null, needsReconnect: false, linkedAccounts: [], webhook, hasWebhook: true, webhookStopped: false };
  const arriving = (campaigns: Array<{ id: string; name: string }> | null) => ({
    ...live, webhook: { ...webhook, lastTestAt: "2026-11-11T09:00:00.000Z", lastLeadAt: "2026-11-11T10:00:00.000Z", campaigns },
  });

  it("asks the server for the campaign ticks", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockClear();
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(live);
    render(<GoogleAdsConnectionCard />);
    await screen.findByLabelText("Key");
    expect(api.getGoogleAdsOverview).toHaveBeenCalledWith({ campaigns: true });
  });

  it("before any delivery with this key: waits for a test lead and tells the owner to reuse the same URL and key", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(live);
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText("Not received yet")).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.getByText(/Paste this same URL and key into each lead form\. No new key needed\./)).toBeInTheDocument();
    expect(screen.getByText(/Then select Send test data\./)).toBeInTheDocument();
    expect(screen.queryByText("Leads arriving")).not.toBeInTheDocument();
  });

  it("after the test lead: shows it received and still waits for a real lead", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce({ ...live, webhook: { ...webhook, lastTestAt: "2026-11-11T09:00:00.000Z" } });
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText(/^Received ✓/)).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByText("Leads arriving")).not.toBeInTheDocument();
  });

  it("after a real lead: replaces the test and last-lead lines with Leads arriving and a tick per campaign", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(arriving([{ id: "111", name: "Diwali" }, { id: "222", name: "Pongal" }]));
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText("Leads arriving")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Campaigns sending leads" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Diwali", "Pongal"]);
    expect(screen.queryByText("Test lead")).not.toBeInTheDocument();
    expect(screen.queryByText("Last lead")).not.toBeInTheDocument();
    expect(screen.getByText(/Running more campaigns\?/)).toBeInTheDocument();
  });

  it.each([[[]], [null]])("shows Leads arriving without a list when there are no campaigns to name (%j)", async (campaigns) => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(arriving(campaigns));
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText("Leads arriving")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Campaigns sending leads" })).not.toBeInTheDocument();
    expect(screen.queryByText("Test lead")).not.toBeInTheDocument();
  });

  it("starts over after Replace key: back to waiting for a test lead, ticks gone", async () => {
    vi.mocked(api.createGoogleAdsWebhook).mockClear();
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce(arriving([{ id: "111", name: "Diwali" }])).mockResolvedValueOnce(live);
    render(<GoogleAdsConnectionCard />);
    expect(await screen.findByText("Leads arriving")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(api.createGoogleAdsWebhook).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("Not received yet")).toBeInTheDocument();
    expect(screen.queryByText("Leads arriving")).not.toBeInTheDocument();
    expect(screen.queryByText("Diwali")).not.toBeInTheDocument();
  });

  it("shows no setup note before a webhook exists", async () => {
    vi.mocked(api.getGoogleAdsOverview).mockResolvedValueOnce({ ...live, webhook: null, hasWebhook: false });
    render(<GoogleAdsConnectionCard />);
    await screen.findByRole("button", { name: "Create webhook URL and key" });
    expect(screen.queryByText(/Running more campaigns\?/)).not.toBeInTheDocument();
    expect(screen.queryByText("Lead arrival stopped")).not.toBeInTheDocument();
  });
});
