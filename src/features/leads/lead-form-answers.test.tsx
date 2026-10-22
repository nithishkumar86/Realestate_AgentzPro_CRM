import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadFormAnswers, formatAnswer, formatQuestion } from "@/features/leads/lead-form-answers";

const navigation = vi.hoisted(() => ({ goToLogin: vi.fn(), reloadPage: vi.fn() }));
vi.mock("@/features/dashboard/navigation", () => navigation);

const LEAD = "11111111-1111-4111-8111-111111111111";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); navigation.goToLogin.mockReset(); });

describe("formatQuestion", () => {
  it("turns Meta's question key into readable text and keeps punctuation", () => {
    expect(formatQuestion("budget_range")).toBe("Budget range");
    expect(formatQuestion("how_many_days_you're_going_to_buy_the_flat?")).toBe("How many days you're going to buy the flat?");
    expect(formatQuestion("need__2BHK_or_3BHK")).toBe("Need 2BHK or 3BHK");
    expect(formatQuestion("___")).toBe("___");
  });
});

describe("formatAnswer", () => {
  it("makes a multiple-choice option key readable", () => {
    expect(formatAnswer("within_a_month")).toBe("Within a month");
    expect(formatAnswer("no")).toBe("No");
    expect(formatAnswer("70_lakhs")).toBe("70 lakhs");
    expect(formatAnswer("70")).toBe("70");
  });

  it("leaves anything the lead typed exactly as written", () => {
    expect(formatAnswer("20-30 lakh")).toBe("20-30 lakh");
    expect(formatAnswer("Anna Nagar, Chennai")).toBe("Anna Nagar, Chennai");
    expect(formatAnswer("kumar_r@example.com")).toBe("kumar_r@example.com");
    expect(formatAnswer("https://example.com/my_plan")).toBe("https://example.com/my_plan");
    expect(formatAnswer("NO")).toBe("NO");
  });
});

describe("LeadFormAnswers", () => {
  it("loads this lead's answers without caching and shows them in the form's order", async () => {
    const fetchMock = vi.fn(async () => json({ answers: [
      { name: "budget_range", values: ["70_lakhs"] },
      { name: "home_loan_needed?", values: ["no"] },
      { name: "when_are_you_planning_to_buy?", values: ["within_a_month"] },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LeadFormAnswers leadId={LEAD} />);
    const card = screen.getByRole("region", { name: "Form answers" });
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(await within(card).findByText("3 answers")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/leads/${LEAD}`, { cache: "no-store" });
    expect(card).not.toHaveAttribute("aria-busy");
    const questions = within(card).getAllByRole("term").map((term) => term.textContent);
    const answers = within(card).getAllByRole("definition").map((definition) => definition.textContent);
    expect(questions).toEqual(["Budget range", "Home loan needed?", "When are you planning to buy?"]);
    expect(answers).toEqual(["70 lakhs", "No", "Within a month"]);
  });

  it("shows several answers to one question as separate chips and gives a long answer the full width", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ answers: [
      { name: "preferred_areas", values: ["Anna Nagar", "Velachery"] },
      { name: "anything_else?", values: ["Need a corner flat close to the school and the metro station, east facing"] },
    ] })));
    render(<LeadFormAnswers leadId={LEAD} />);
    const chips = await screen.findAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Anna Nagar", "Velachery"]);
    expect(screen.getByText("2 answers")).toBeInTheDocument();
    const longAnswer = screen.getByText(/corner flat/).closest(".mvp-form-answer");
    expect(longAnswer).toHaveClass("mvp-form-answer--wide");
    expect(chips[0].closest(".mvp-form-answer")).not.toHaveClass("mvp-form-answer--wide");
  });

  it("says so when the form asked nothing besides name, phone and email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ answers: [] })));
    render(<LeadFormAnswers leadId={LEAD} />);
    expect(await screen.findByText(/no questions besides name, phone and email/)).toBeInTheDocument();
    expect(screen.queryByText(/^[0-9]+ answers?$/)).not.toBeInTheDocument();
  });

  it("shows a failed load inside the card and loads again on Retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "LEAD_ANSWERS_FAILED", message: "The form answers could not be loaded." } }, 500))
      .mockResolvedValueOnce(json({ answers: [{ name: "budget_range", values: ["70_lakhs"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LeadFormAnswers leadId={LEAD} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The form answers could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("70 lakhs")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a network failure like any other failed load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<LeadFormAnswers leadId={LEAD} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The form answers could not be loaded.");
  });

  it("goes to the login page when the session has expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "UNAUTHENTICATED", message: "Sign in" } }, 401)));
    render(<LeadFormAnswers leadId={LEAD} />);
    await vi.waitFor(() => expect(navigation.goToLogin).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
