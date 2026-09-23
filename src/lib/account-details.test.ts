import { describe, expect, it } from "vitest";
import { parseIndianMobile, sanitizePhoneInput, validateAccountDetails, validateAccountField } from "@/lib/account-details";

const VALID = {
  fullName: "Ravi Kumar",
  phoneNumber: "9876543210",
  companyName: "BRIQ Aastha",
  professionalRole: "Real Estate Agent",
};

describe("parseIndianMobile", () => {
  it("stores exactly 10 digits under the fixed +91 code", () => {
    expect(parseIndianMobile("9876543210")).toBe("919876543210");
    expect(parseIndianMobile("6000000000")).toBe("916000000000");
  });

  it.each([
    ["15 digits", "987654321012345"],
    ["11 digits", "98765432101"],
    ["9 digits", "987654321"],
    ["the country code typed as well", "919876543210"],
    ["a leading 0", "09876543210"],
    ["a plus sign", "+919876543210"],
    ["spaces", "98765 43210"],
    ["letters", "98765abcde"],
    ["starting with 5", "5876543210"],
    ["all zeros", "0000000000"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(parseIndianMobile(input)).toBeNull();
  });
});

describe("sanitizePhoneInput", () => {
  it.each([
    ["letters and symbols", "98a76#5-43 210", "9876543210"],
    ["more than 10 digits", "987654321012345", "9876543210"],
    ["a pasted +91 number", "+91 98765 43210", "9876543210"],
    ["a pasted 91 number", "919876543210", "9876543210"],
    ["a pasted trunk 0", "09876543210", "9876543210"],
    ["a partial number", "98765", "98765"],
  ])("keeps only the 10-digit number from %s", (_label, input, expected) => {
    expect(sanitizePhoneInput(input)).toBe(expected);
  });
});

describe("validateAccountField", () => {
  it.each([
    ["", "Enter your full name."],
    ["R", "Full name must be 2 to 60 characters."],
    ["a".repeat(61), "Full name must be 2 to 60 characters."],
    ["Ravi123", "Full name can contain only letters, spaces, dots, apostrophes and hyphens."],
    ["Ravi@Kumar", "Full name can contain only letters, spaces, dots, apostrophes and hyphens."],
    ["-- --", "Full name can contain only letters, spaces, dots, apostrophes and hyphens."],
    ["<script>", "Full name can contain only letters, spaces, dots, apostrophes and hyphens."],
  ])("rejects the full name %j", (value, message) => {
    expect(validateAccountField("fullName", value)).toBe(message);
  });

  it.each(["Ravi Kumar", "M. Nithish Kumar", "D'Souza", "Anne-Marie", "रवि कुमार", "  Ravi   Kumar  "])(
    "accepts the full name %j",
    (value) => {
      expect(validateAccountField("fullName", value)).toBeNull();
    },
  );

  it("rejects a company name made only of digits or symbols", () => {
    expect(validateAccountField("companyName", "12345")).not.toBeNull();
    expect(validateAccountField("companyName", "<b>Co</b>")).not.toBeNull();
    expect(validateAccountField("companyName", "a".repeat(101))).toBe("Company name must be 2 to 100 characters.");
  });

  it("accepts realistic company names", () => {
    expect(validateAccountField("companyName", "BRIQ Aastha")).toBeNull();
    expect(validateAccountField("companyName", "A & B Realty (Pvt.) Ltd.")).toBeNull();
    expect(validateAccountField("companyName", "99acres Partners")).toBeNull();
  });

  it("rejects a professional role with digits and accepts a normal one", () => {
    expect(validateAccountField("professionalRole", "Agent 007")).not.toBeNull();
    expect(validateAccountField("professionalRole", "")).toBe("Enter your professional role.");
    expect(validateAccountField("professionalRole", "Sales / Marketing Head")).toBeNull();
  });

  it("explains an invalid mobile number", () => {
    expect(validateAccountField("phoneNumber", "")).toBe("Enter your mobile number.");
    expect(validateAccountField("phoneNumber", "98765abcde")).toBe("Mobile number can contain digits only.");
    expect(validateAccountField("phoneNumber", "987654321012345")).toBe("Mobile number must be exactly 10 digits.");
    expect(validateAccountField("phoneNumber", "98765")).toBe("Mobile number must be exactly 10 digits.");
    expect(validateAccountField("phoneNumber", "1234567890")).toBe("Enter a valid Indian mobile number starting with 6, 7, 8 or 9.");
    expect(validateAccountField("phoneNumber", "9876543210")).toBeNull();
  });
});

describe("validateAccountDetails", () => {
  it("returns cleaned values with the phone in stored form", () => {
    expect(validateAccountDetails({ ...VALID, fullName: "  Ravi   Kumar ", phoneNumber: "9876543210" })).toEqual({
      ok: true,
      values: { fullName: "Ravi Kumar", phoneNumber: "919876543210", companyName: "BRIQ Aastha", professionalRole: "Real Estate Agent" },
    });
  });

  it("reports every invalid field at once", () => {
    const result = validateAccountDetails({ fullName: "1", phoneNumber: "123", companyName: "", professionalRole: "x" });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.ok ? {} : result.errors).sort()).toEqual(["companyName", "fullName", "phoneNumber", "professionalRole"]);
  });

  it("does not require a company for an invited member", () => {
    const member = { fullName: VALID.fullName, phoneNumber: VALID.phoneNumber, professionalRole: VALID.professionalRole };
    expect(validateAccountDetails(member)).toEqual({
      ok: true,
      values: { fullName: "Ravi Kumar", phoneNumber: "919876543210", professionalRole: "Real Estate Agent" },
    });
  });
});
