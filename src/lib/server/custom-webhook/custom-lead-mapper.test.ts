// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CustomLeadPayloadError, mapCustomWebhookLead } from "@/lib/server/custom-webhook/custom-lead-mapper";

const JSON_TYPE = "application/json";
const FORM_TYPE = "application/x-www-form-urlencoded";

function mapJson(body: unknown, contentType: string | null = JSON_TYPE) {
  return mapCustomWebhookLead(contentType, JSON.stringify(body));
}

function expectRejected(run: () => unknown, status: 400 | 415, message?: RegExp) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CustomLeadPayloadError);
    expect((error as CustomLeadPayloadError).status).toBe(status);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected the payload to be rejected");
}

describe("mapCustomWebhookLead", () => {
  it("maps the 3sigma-style body to Meta's contact keys, keeps source and lead_id out of the answers", () => {
    const lead = mapJson({ name: "John Doe", phone: "9876543210", email: "john@example.com", source: "Landing Page", lead_id: "lp-42", city: "Chennai" });
    expect(lead.fieldData).toEqual([
      { name: "full_name", values: ["John Doe"] },
      { name: "phone_number", values: ["9876543210"] },
      { name: "email", values: ["john@example.com"] },
      { name: "city", values: ["Chennai"] },
    ]);
    expect(lead.sourceName).toBe("Landing Page");
    expect(lead.leadRef).toBe("lp-42");
    expect(lead.rawPayload).toMatchObject({ source: "Landing Page", lead_id: "lp-42" });
  });

  it("reads the aliases case-insensitively, with spaces and hyphens as underscores", () => {
    const lead = mapJson({ "Full Name": "Asha", "Mobile-Number": "98765 43210", "Email Address": "a@x.in" });
    expect(lead.fieldData).toEqual([
      { name: "full_name", values: ["Asha"] },
      { name: "phone_number", values: ["98765 43210"] },
      { name: "email", values: ["a@x.in"] },
    ]);
  });

  it("gives a contact key to the best alias only; another keeps its own name, prefixed if that name is a contact key", () => {
    const lead = mapJson({ mobile: "9000000001", phone: "9000000002", name: "Ravi", full_name: "Ravi Kumar", email: "r@x.in" });
    expect(lead.fieldData).toEqual([
      { name: "mobile", values: ["9000000001"] },
      { name: "phone_number", values: ["9000000002"] },
      { name: "full_name", values: ["Ravi"] },
      { name: "question_full_name", values: ["Ravi Kumar"] },
      { name: "email", values: ["r@x.in"] },
    ]);
  });

  it("skips an empty best alias, so the next one with an answer becomes the phone", () => {
    const lead = mapJson({ phone: "  ", mobile: "9000000003" });
    expect(lead.fieldData).toEqual([{ name: "phone_number", values: ["9000000003"] }]);
  });

  it("keeps first and last name for the database to join when there is no full name", () => {
    const lead = mapJson({ first_name: "Priya", last_name: "S", email: "p@x.in" });
    expect(lead.fieldData.slice(0, 2)).toEqual([{ name: "first_name", values: ["Priya"] }, { name: "last_name", values: ["S"] }]);
  });

  it("turns numbers, booleans, lists and nested objects into text answers, and skips nulls", () => {
    const lead = mapJson({ phone: 9876543210, budget: 4500000, agreed: true, rooms: ["2BHK", 3], extra: { floor: 4 }, note: null });
    expect(lead.fieldData).toEqual([
      { name: "phone_number", values: ["9876543210"] },
      { name: "budget", values: ["4500000"] },
      { name: "agreed", values: ["true"] },
      { name: "rooms", values: ["2BHK", "3"] },
      { name: "extra", values: ["{\"floor\":4}"] },
    ]);
  });

  it("keeps every digit of a long phone number sent as a JSON number", () => {
    const lead = mapCustomWebhookLead(JSON_TYPE, "{\"phone\": 9198765432101234567}");
    expect(lead.fieldData).toEqual([{ name: "phone_number", values: ["9198765432101234567"] }]);
  });

  it("reads an ordinary form post, a repeated field becoming several answers", () => {
    const lead = mapCustomWebhookLead(`${FORM_TYPE}; charset=UTF-8`, "name=Meena+R&phone=%2B91+98765+43210&interest=Villa&interest=Plot&source=Website");
    expect(lead.fieldData).toEqual([
      { name: "full_name", values: ["Meena R"] },
      { name: "phone_number", values: ["+91 98765 43210"] },
      { name: "interest", values: ["Villa", "Plot"] },
    ]);
    expect(lead.sourceName).toBe("Website");
    expect(lead.rawPayload).toMatchObject({ interest: ["Villa", "Plot"] });
  });

  it("stores a form field named __proto__ as a plain field", () => {
    const lead = mapCustomWebhookLead(FORM_TYPE, "email=a%40x.in&__proto__=x");
    expect(lead.fieldData).toContainEqual({ name: "__proto__", values: ["x"] });
  });

  it("reads JSON sent without a content type or as text/plain", () => {
    expect(mapJson({ email: "a@x.in" }, null).fieldData).toEqual([{ name: "email", values: ["a@x.in"] }]);
    expect(mapJson({ email: "a@x.in" }, "text/plain").fieldData).toEqual([{ name: "email", values: ["a@x.in"] }]);
  });

  it("requires a phone or an email", () => {
    expectRejected(() => mapJson({ name: "No Contact", city: "Madurai" }), 400, /phone or email/);
    expect(mapJson({ email: "only@x.in" }).fieldData).toHaveLength(1);
    expect(mapJson({ phone: "9876543210" }).fieldData).toHaveLength(1);
  });

  it.each([
    ["broken JSON", JSON_TYPE, "{oops", /JSON object/],
    ["several leads", JSON_TYPE, "[{\"phone\":\"1\"},{\"phone\":\"2\"}]", /one lead/],
    ["a bare value", JSON_TYPE, "\"hello\"", /JSON object/],
  ])("refuses %s with 400", (_case, type, body, message) => {
    expectRejected(() => mapCustomWebhookLead(type, body), 400, message);
  });

  it("refuses an unsupported format with 415", () => {
    expectRejected(() => mapCustomWebhookLead("multipart/form-data; boundary=x", "--x--"), 415);
    expectRejected(() => mapCustomWebhookLead("application/xml", "<lead/>"), 415);
  });

  it("caps fields, field names, source and lead_id", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`q${index}`, "a"]));
    expectRejected(() => mapJson({ ...many, phone: "1" }), 400, /100 fields/);
    expectRejected(() => mapJson({ phone: "1", ["k".repeat(101)]: "a" }), 400, /100 characters/);
    expectRejected(() => mapJson({ phone: "1", source: "s".repeat(201) }), 400, /source/);
    expectRejected(() => mapJson({ phone: "1", lead_id: "l".repeat(201) }), 400, /lead_id/);
    expect(mapJson({ phone: "1", source: "s".repeat(200), lead_id: "l".repeat(200) }).leadRef).toHaveLength(200);
  });

  it("refuses a list or object as source or lead_id rather than guessing", () => {
    expectRejected(() => mapJson({ phone: "1", lead_id: ["a", "b"] }), 400, /single value/);
    expectRejected(() => mapJson({ phone: "1", source: { name: "x" } }), 400, /single value/);
  });

  it("treats a blank source or lead_id as absent, and a numeric lead_id as text", () => {
    const lead = mapJson({ phone: "1", source: "  ", lead_id: 12345 });
    expect(lead.sourceName).toBeNull();
    expect(lead.leadRef).toBe("12345");
  });
});
