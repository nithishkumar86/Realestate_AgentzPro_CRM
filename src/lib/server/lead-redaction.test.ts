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

  // Regression: the first real Meta ad lead (23 Oct 2026) carried Meta's own
  // `inbox_url` entry as {name} with no `values`, and redaction crashed with
  // "values is not iterable" on every retry. This is that lead's exact shape.
  it("redacts a real Meta ad lead whose inbox_url entry has no values, skipping that entry", () => {
    const realShape = [
      { name: "what_is_your_budget?", values: ["₹70l_–_₹75l"] },
      { name: "when_are_you_planning_to_buy?", values: ["within_1_month"] },
      { name: "are_you_okay_with_an_under-construction_property?", values: ["yes"] },
      { name: "do_you_need_home_loan_assistance?", values: ["no"] },
      { name: "preferred_floor?", values: ["higher_floor"] },
      { name: "email", values: ["ravi.kumar@example.com"] },
      { name: "full_name", values: ["Ravi Kumar"] },
      { name: "phone_number", values: ["+919876543210"] },
      { name: "street_address", values: ["12 Anna Nagar"] },
      { name: "inbox_url" },
    ];
    const redacted = redactLeadFieldsForAi(realShape);
    expect(redacted).toHaveLength(9);
    expect(redacted.map((f) => f.name)).not.toContain("inbox_url");
    expect(redacted.find((f) => f.name === "full_name")).toEqual({ name: "full_name", values: ["[NAME]"] });
    expect(redacted.find((f) => f.name === "when_are_you_planning_to_buy?")).toEqual({ name: "when_are_you_planning_to_buy?", values: ["within_1_month"] });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("Ravi Kumar");
    expect(serialized).not.toContain("ravi.kumar@example.com");
    expect(serialized).not.toContain("9876543210");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an object instead of an array", { name: "budget", values: ["50 lakh"] }],
    ["a string", "budget=50 lakh"],
    ["an empty array", []],
  ])("returns no fields, without throwing, when field_data is %s", (_label, fieldData) => {
    expect(redactLeadFieldsForAi(fieldData)).toEqual([]);
  });

  it("skips malformed entries without throwing and keeps every usable one", () => {
    const fieldData = [
      null,
      "budget",
      42,
      [],
      { values: ["no name"] },
      { name: 7, values: ["numeric name"] },
      { name: "   ", values: ["blank name"] },
      { name: "inbox_url" },
      { name: "empty_list", values: [] },
      { name: "null_values", values: null },
      { name: "blank_answers", values: ["", "   "] },
      { name: "object_values", values: { first: "x" } },
      { name: "single_string", values: "ready to buy" },
      { name: "numbers", values: [3, Number.NaN, 2.5] },
      { name: "mixed", values: ["yes", null, { nested: true }, ["x"], true, " padded "] },
    ];
    expect(redactLeadFieldsForAi(fieldData)).toEqual([
      { name: "single_string", values: ["ready to buy"] },
      { name: "numbers", values: ["3", "2.5"] },
      { name: "mixed", values: ["yes", "padded"] },
    ]);
  });

  it("caps an oversized answer only after redaction, so a name at the cut point never leaks", () => {
    const filler = "a ".repeat(497); // 994 characters, so the name straddles the 1,000-character cut
    const redacted = redactLeadFieldsForAi([
      { name: "full_name", values: ["Priya Sharma"] },
      { name: "message", values: [`${filler}Priya Sharma wants a site visit`] },
    ]);
    const message = redacted.find((f) => f.name === "message")?.values[0] ?? "";
    expect(message.length).toBeLessThanOrEqual(1_000);
    expect(message).not.toContain("Priya");
    expect(message).not.toContain("Sha");
  });

  it("still masks a phone number whose contact field sits beyond the field cap", () => {
    const fieldData = [
      { name: "message", values: ["Call 9876543210 after 6pm"] },
      ...Array.from({ length: 120 }, (_, index) => ({ name: `question_${index}`, values: ["x"] })),
      { name: "phone_number", values: ["9876543210"] },
    ];
    const redacted = redactLeadFieldsForAi(fieldData);
    expect(redacted).toHaveLength(100);
    expect(redacted[0]).toEqual({ name: "message", values: ["Call [PHONE] after 6pm"] });
    expect(JSON.stringify(redacted)).not.toContain("9876543210");
  });

  it("bounds how many answers one field can send", () => {
    const redacted = redactLeadFieldsForAi([{ name: "interests", values: Array.from({ length: 50 }, (_, index) => `option_${index}`) }]);
    expect(redacted[0].values).toHaveLength(20);
  });
});
