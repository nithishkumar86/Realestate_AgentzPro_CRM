import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const URL_VALUE = "https://crm.example.com/api/webhooks/custom/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACTIVE = { canManage: true, hasWebhook: true, webhookStopped: false, webhook: { url: URL_VALUE, lastLeadAt: null } };

vi.mock("@/services/crm-api-client", () => ({
  getCustomWebhookOverview: vi.fn(),
  createCustomWebhook: vi.fn(),
  stopCustomWebhook: vi.fn(),
}));

const { CustomWebhookConnectionCard, SAMPLE_WEBHOOK_BODY } = await import("@/features/connection/custom-webhook-connection-card");
const api = await import("@/services/crm-api-client");

beforeEach(() => {
  vi.mocked(api.getCustomWebhookOverview).mockReset().mockResolvedValue(ACTIVE);
  vi.mocked(api.createCustomWebhook).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.stopCustomWebhook).mockReset().mockResolvedValue({ stopped: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("CustomWebhookConnectionCard", () => {
  it("asks for the URL (details) and hides it like a password until Show; Copy copies the real URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CustomWebhookConnectionCard />);
    const input = await screen.findByLabelText("Webhook URL") as HTMLInputElement;
    expect(api.getCustomWebhookOverview).toHaveBeenCalledWith({ details: true });
    expect(input.type).toBe("password");
    expect(input.value).toBe(URL_VALUE);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input.type).toBe("text");
  });

  it("shows the example body and tells the owner never to put the URL in website code", async () => {
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByLabelText("Example webhook body")).toHaveTextContent("\"lead_id\": \"optional-your-own-id\"");
    expect(SAMPLE_WEBHOOK_BODY).toContain("\"source\": \"Landing Page\"");
    expect(screen.getByText(/Never put it in your website/)).toBeInTheDocument();
    expect(screen.getByText(/Phone or email is required/)).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("shows Leads arriving once a lead came in on this URL", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue({ ...ACTIVE, webhook: { url: URL_VALUE, lastLeadAt: "2026-11-11T10:00:00Z" } });
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Leads arriving")).toBeInTheDocument();
  });

  it("replaces the URL only after the owner confirms", async () => {
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace URL" }));
    expect(api.createCustomWebhook).not.toHaveBeenCalled();
    expect(screen.getByText(/old URL stops working at once/)).toBeInTheDocument();
    const confirm = screen.getAllByRole("button", { name: "Replace URL" }).find((button) => button.className.includes("button--danger"));
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(api.createCustomWebhook).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Paste it into your tools.")).toBeInTheDocument();
  });

  it("stops leads and shows the OK pop-up", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce(ACTIVE).mockResolvedValue({ canManage: true, hasWebhook: false, webhookStopped: true, webhook: null });
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving webhook leads" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Webhook leads stopped");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Lead arrival stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new webhook URL" })).toBeInTheDocument();
  });

  it("offers Create webhook URL when none exists", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce({ canManage: true, hasWebhook: false, webhookStopped: false, webhook: null }).mockResolvedValue(ACTIVE);
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create webhook URL" }));
    await waitFor(() => expect(api.createCustomWebhook).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toBeInTheDocument();
  });

  it("shows an employee the status only, never the URL or any button", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue({ canManage: false, hasWebhook: true, webhookStopped: false, webhook: null });
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Only the company owner can set up the webhook.")).toBeInTheDocument();
    expect(screen.getByText("Receiving leads")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so when the details cannot be loaded", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockRejectedValue(new Error("Webhook details could not be loaded."));
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Webhook details could not be loaded.")).toBeInTheDocument();
  });
});
