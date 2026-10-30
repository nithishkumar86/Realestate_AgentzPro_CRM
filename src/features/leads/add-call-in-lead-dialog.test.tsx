import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddCallInLeadDialog, resolveCameFrom, type CallInOrigins } from "@/features/leads/add-call-in-lead-dialog";

// Shapes exactly as GET /api/leads/telecaller/origins answers (listCallInOrigins over list_call_in_origins): only the
// platforms connected right now, each with its named ads (Facebook) or campaigns (Google Ads).
const FACEBOOK = { id: "facebook" as const, label: "Facebook", refs: [{ id: "120200", name: "Villa Ad" }] };
const GOOGLE = { id: "google_ads" as const, label: "Google Ads", refs: [] };
const origins = (platforms: CallInOrigins["platforms"]): CallInOrigins => ({ today: "2026-10-30", minDate: "2025-10-30", platforms });

type Sent = { posts: Array<Record<string, unknown>> };
function mockApi(originsSequence: CallInOrigins[], postResponse: () => Response = () => json({ id: "lead-1" }, 201)): Sent {
  const sent: Sent = { posts: [] };
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/leads/telecaller/origins") return json(originsSequence[Math.min(call++, originsSequence.length - 1)]);
    if (url === "/api/leads/telecaller" && init?.method === "POST") { sent.posts.push(JSON.parse(String(init.body))); return postResponse(); }
    throw new Error(`Unexpected request ${url}`);
  }));
  return sent;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Ravi" } });
  fireEvent.change(screen.getByPlaceholderText("10-digit mobile number"), { target: { value: "9876543210" } });
  fireEvent.change(screen.getByPlaceholderText("Project the lead asked about"), { target: { value: "Karuvi" } });
}
const save = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save lead" })); });

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("resolveCameFrom", () => {
  it("chooses the only platform, keeps a still-connected pick, and leaves two or more for the member", () => {
    expect(resolveCameFrom(origins([GOOGLE]), "")).toBe("google_ads");
    expect(resolveCameFrom(origins([FACEBOOK, GOOGLE]), "")).toBe("");
    expect(resolveCameFrom(origins([FACEBOOK, GOOGLE]), "google_ads")).toBe("google_ads");
    expect(resolveCameFrom(origins([FACEBOOK]), "google_ads")).toBe("facebook");
    expect(resolveCameFrom(origins([]), "facebook")).toBe("");
  });
});

describe("AddCallInLeadDialog", () => {
  it("hides \"Came from\" when nothing is connected and saves today's date", async () => {
    const sent = mockApi([origins([])]);
    const onSaved = vi.fn();
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByText("Call date");
    expect(screen.queryByText("Came from")).not.toBeInTheDocument();
    await fillRequired();
    await save();
    expect(sent.posts[0]).toEqual({ leadName: "Ravi", phone: "9876543210", whatsapp: "", projectName: "Karuvi", callDate: "2026-10-30" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("with only Google Ads connected, shows it chosen with no dropdown and sends it", async () => {
    const sent = mockApi([origins([GOOGLE])]);
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Google Ads")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Came from/ })).not.toBeInTheDocument();
    // Google Ads has no named campaigns yet, so there is no campaign picker.
    expect(screen.queryByText("Campaign")).not.toBeInTheDocument();
    await fillRequired();
    await save();
    expect(sent.posts[0]).toMatchObject({ cameFromPlatform: "google_ads" });
    expect(sent.posts[0]).not.toHaveProperty("cameFromRefId");
  });

  it("with only Facebook connected, offers its ads and sends the one picked", async () => {
    const sent = mockApi([origins([FACEBOOK])]);
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Ad/ }));
    fireEvent.click(screen.getByRole("option", { name: "Villa Ad" }));
    await fillRequired();
    await save();
    expect(sent.posts[0]).toMatchObject({ cameFromPlatform: "facebook", cameFromRefId: "120200" });
  });

  it("\"Not sure\" saves the platform with no ad", async () => {
    const sent = mockApi([origins([FACEBOOK])]);
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Ad/ }));
    fireEvent.click(screen.getByRole("option", { name: "Not sure" }));
    await fillRequired();
    await save();
    expect(sent.posts[0]).toMatchObject({ cameFromPlatform: "facebook" });
    expect(sent.posts[0]).not.toHaveProperty("cameFromRefId");
  });

  it("with two platforms, shows a dropdown the member must pick from", async () => {
    const sent = mockApi([origins([FACEBOOK, GOOGLE])]);
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    const picker = await screen.findByRole("button", { name: /Came from/ });
    await fillRequired();
    await save();
    expect(await screen.findByText("Pick where the lead came from.")).toBeInTheDocument();
    expect(sent.posts).toHaveLength(0);
    fireEvent.click(picker);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Facebook", "Google Ads"]);
    fireEvent.click(screen.getByRole("option", { name: "Google Ads" }));
    await save();
    expect(sent.posts[0]).toMatchObject({ cameFromPlatform: "google_ads" });
  });

  it("takes the call date from the calendar only: typing is blocked, the range is the last 365 days", async () => {
    mockApi([origins([])]);
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText("Call date");
    const date = document.querySelector<HTMLInputElement>("input[type=date]")!;
    expect(date).toHaveAttribute("min", "2025-10-30");
    expect(date).toHaveAttribute("max", "2026-10-30");
    expect(date.value).toBe("2026-10-30");
    const typed = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    date.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    date.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("after saving an earlier call date, says where the lead is before closing", async () => {
    const sent = mockApi([origins([])]);
    const onSaved = vi.fn();
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByText("Call date");
    fireEvent.change(document.querySelector("input[type=date]")!, { target: { value: "2026-10-01" } });
    await fillRequired();
    await save();
    expect(sent.posts[0]).toMatchObject({ callDate: "2026-10-01" });
    expect(await screen.findByRole("alertdialog", { name: "Lead saved" })).toHaveTextContent("1 Oct 2026");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSaved).toHaveBeenCalled();
  });

  it("when a platform was disconnected while the form was open, shows the error and the current platforms", async () => {
    mockApi([origins([FACEBOOK, GOOGLE]), origins([FACEBOOK])],
      () => json({ error: { code: "CALL_IN_ORIGIN_CHANGED", message: "The connected lead platforms or ads changed. Check \"Came from\" and save again." } }, 409));
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Came from/ }));
    fireEvent.click(screen.getByRole("option", { name: "Google Ads" }));
    await fillRequired();
    await save();
    expect(await screen.findByText(/The connected lead platforms or ads changed/)).toBeInTheDocument();
    // Only Facebook is connected now: it is shown chosen, with no dropdown.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Came from/ })).not.toBeInTheDocument());
    expect(screen.getByText("Facebook")).toBeInTheDocument();
  });

  it("does not let the member save until the platforms are known, and says so when they cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "Lead platforms could not be loaded." } }, 500)));
    render(<AddCallInLeadDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Lead platforms could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
  });
});
