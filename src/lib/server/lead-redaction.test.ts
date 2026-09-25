import { describe, expect, it } from "vitest";
import { redactLeadFieldsForAi, type LeadField } from "@/lib/server/lead-redaction";

describe("redactLeadFieldsForAi", () => {
  it("replaces the values of the dedicated name/email/phone fields", () => {
    const fields: LeadField[] = [
      { name: "full_name", values: ["Priya Sharma"] },
      { name: "email", values: ["priya.sharma@example.com"] },
      { name: "phone_number", values: ["+91 98765 43210"] },
    ];
    expect(redactLeadFieldsForAi(fields)).toEqual([
      { name: "full_name", values: ["[NAME]"] },
      { name: "email", values: ["[EMAIL]"] },
      { name: "phone_number", values: ["[PHONE]"] },
    ]);
  });

  it("leaves every other field's key and full value completely unchanged", () => {
    const fields: LeadField[] = [
      { name: "full_name", values: ["Priya Sharma"] },
      { name: "budget", values: ["I can spend up to 50 lakh on a 3BHK near the tech park"] },
      { name: "preferred_project", values: ["Skyline Residences"] },
    ];
    const redacted = redactLeadFieldsForAi(fields);
    expect(redacted.find((f) => f.name === "budget")).toEqual({ name: "budget", values: ["I can spend up to 50 lakh on a 3BHK near the tech park"] });
    expect(redacted.find((f) => f.name === "preferred_project")).toEqual({ name: "preferred_project", values: ["Skyline Residences"] });
  });

  it("never sends the original name, email, or phone anywhere in the output", () => {
    const fields: LeadField[] = [
      { name: "full_name", values: ["Priya Sharma"] },
      { name: "email", values: ["priya.sharma@example.com"] },
      { name: "phone_number", values: ["9876543210"] },
      { name: "message", values: ["Reach me at priya.sharma@example.com or 98765 43210, I'm Priya Sharma"] },
    ];
    const serialized = JSON.stringify(redactLeadFieldsForAi(fields));
    expect(serialized).not.toContain("Priya Sharma");
    expect(serialized).not.toContain("priya.sharma@example.com");
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("98765 43210");
  });

  it("scrubs only the leaked PII substring inside a free-text field, leaving the rest intact", () => {
    const fields: LeadField[] = [
      { name: "full_name", values: ["Arun Kumar"] },
      { name: "message", values: ["My name is Arun Kumar and I want a 2BHK by next month"] },
    ];
    const redacted = redactLeadFieldsForAi(fields);
    expect(redacted.find((f) => f.name === "message")?.values[0]).toBe("My name is [NAME] and I want a 2BHK by next month");
  });

  it("matches a re-typed phone number even with different formatting than the phone_number field", () => {
    const fields: LeadField[] = [
      { name: "phone_number", values: ["+91 98765-43210"] },
      { name: "message", values: ["Call me on 9876543210 after 6pm"] },
    ];
    const redacted = redactLeadFieldsForAi(fields);
    expect(redacted.find((f) => f.name === "message")?.values[0]).toBe("Call me on [PHONE] after 6pm");
  });

  it("does not touch a short, unrelated field that merely contains a name-like substring", () => {
    const fields: LeadField[] = [
      { name: "full_name", values: ["Anna"] },
      { name: "preferred_project", values: ["Ananta Heights"] },
    ];
    const redacted = redactLeadFieldsForAi(fields);
    // Whole-word matching: "Anna" must not eat part of "Ananta".
    expect(redacted.find((f) => f.name === "preferred_project")?.values[0]).toBe("Ananta Heights");
  });

  it("handles a lead with no contact fields at all without throwing", () => {
    const fields: LeadField[] = [{ name: "budget", values: ["50 lakh"] }];
    expect(redactLeadFieldsForAi(fields)).toEqual(fields);
  });
});
