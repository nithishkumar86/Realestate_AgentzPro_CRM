import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

const { OnboardingFormClient } = await import("@/features/auth/onboarding-form-client");
const { InvitationOnboardingFormClient } = await import("@/features/auth/invitation-onboarding-form-client");

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fill(values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

const VALID = {
  "Full name": "Ravi Kumar",
  "Mobile number": "9876543210",
  "Company name": "BRIQ Aastha",
  "Professional role": "Real Estate Agent",
};

describe("OnboardingFormClient", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("is a Create account form, not Complete setup", () => {
    render(<OnboardingFormClient />);
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.queryByText("Complete setup")).not.toBeInTheDocument();
  });

  it("blocks submission and shows every problem when fields are invalid", () => {
    const fetchMock = stubFetch(201, {});
    render(<OnboardingFormClient />);
    fill({ ...VALID, "Full name": "Ravi123", "Mobile number": "98765" });

    submit();

    expect(screen.getByText("Full name can contain only letters, spaces, dots, apostrophes and hyphens.")).toBeInTheDocument();
    expect(screen.getByText("Mobile number must be exactly 10 digits.")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Full name")).toHaveAccessibleDescription(/only letters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags empty required fields on submit", () => {
    const fetchMock = stubFetch(201, {});
    render(<OnboardingFormClient />);

    submit();

    expect(screen.getByText("Enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your mobile number.")).toBeInTheDocument();
    expect(screen.getByText("Enter your company name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your professional role.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a field error when the person leaves it and clears it once corrected", () => {
    render(<OnboardingFormClient />);
    const phone = screen.getByLabelText("Mobile number");

    fireEvent.change(phone, { target: { value: "12345" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(phone);
    expect(screen.getByRole("alert")).toHaveTextContent("Mobile number must be exactly 10 digits.");

    fireEvent.change(phone, { target: { value: "9876543210" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows +91 as the fixed country code beside the mobile box", () => {
    render(<OnboardingFormClient />);
    const phone = screen.getByLabelText("Mobile number");
    expect(phone.parentElement).toHaveTextContent("+91");
    expect(phone).toHaveAttribute("inputMode", "numeric");
    expect(screen.getByLabelText("Full name")).toHaveAttribute("maxLength", "60");
  });

  it.each([
    ["letters and symbols", "98a76#5-43 210"],
    ["more than 10 digits", "987654321012345"],
    ["a pasted +91 number", "+91 98765 43210"],
    ["a pasted trunk 0", "09876543210"],
  ])("keeps the mobile box to the 10 digits when given %s", (_label, typed) => {
    render(<OnboardingFormClient />);
    const phone = screen.getByLabelText("Mobile number");
    fireEvent.change(phone, { target: { value: typed } });
    expect(phone).toHaveValue("9876543210");
  });

  it("sends valid details and continues to the app", async () => {
    const fetchMock = stubFetch(201, { tenantId: "t", subscriptionStatus: "trialing" });
    render(<OnboardingFormClient />);
    fill(VALID);

    submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      fullName: "Ravi Kumar",
      phoneNumber: "9876543210",
      companyName: "BRIQ Aastha",
      professionalRole: "Real Estate Agent",
    });
  });

  it("puts the server's field errors under their fields", async () => {
    stubFetch(400, {
      error: {
        code: "INVALID_PHONE_NUMBER",
        message: "Mobile number must be exactly 10 digits.",
        details: { fieldErrors: { phoneNumber: "Mobile number must be exactly 10 digits." } },
      },
    });
    render(<OnboardingFormClient />);
    fill(VALID);

    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Mobile number must be exactly 10 digits.");
    expect(screen.getByLabelText("Mobile number")).toHaveAttribute("aria-invalid", "true");
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("InvitationOnboardingFormClient", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("validates the same way and never sends the company", async () => {
    const fetchMock = stubFetch(201, { tenantId: "t", role: "employee" });
    render(<InvitationOnboardingFormClient tenantName="QA Test Co" role="employee" />);

    fill({ "Full name": "Ravi Kumar", "Mobile number": "12345", "Professional role": "Sales" });
    submit();
    expect(screen.getByText("Mobile number must be exactly 10 digits.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fill({ "Mobile number": "9876543210" });
    submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      fullName: "Ravi Kumar",
      phoneNumber: "9876543210",
      professionalRole: "Sales",
    });
  });
});
