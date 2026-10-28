// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GoogleLeadPayloadError, mapGoogleWebhookLead, mapUserColumnData } from "@/lib/server/google/google-lead-mapper";
import { redactLeadFieldsForAi } from "@/lib/server/lead-redaction";

const column = (column_id: string, string_value: string, column_name?: string) => ({ column_id, string_value, ...(column_name ? { column_name } : {}) });

describe("mapGoogleWebhookLead", () => {
  it("maps Google's documented payload and strips google_key from the stored payload", () => {
    const lead = mapGoogleWebhookLead(JSON.stringify({
      lead_id: "TeSter-123-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-0123456789-AaBbCcDdEeFf",
      user_column_data: [column("FULL_NAME", "Ravi Kumar"), column("EMAIL", "ravi@example.com"), column("PHONE_NUMBER", "+919876543210")],
      api_version: "1.0", form_id: 40000000000, campaign_id: 20000000000, gcl_id: "TeSter-gclid", adgroup_id: 30000000000,
      creative_id: 50000000000, google_key: "secret-key", is_test: true, lead_submit_time: "2026-10-28T10:15:00+05:30",
    }));
    expect(lead).toMatchObject({
      googleKey: "secret-key", isTest: true, formId: "40000000000", campaignId: "20000000000", adgroupId: "30000000000",
      creativeId: "50000000000", assetGroupId: null, gclId: "TeSter-gclid", submitTime: "2026-10-28T04:45:00.000Z",
    });
    expect(lead.fieldData).toEqual([
      { name: "full_name", values: ["Ravi Kumar"] }, { name: "email", values: ["ravi@example.com"] }, { name: "phone_number", values: ["+919876543210"] },
    ]);
    expect(lead.rawPayload).not.toHaveProperty("google_key");
    expect(lead.rawPayload).toHaveProperty("api_version", "1.0");
  });

  it("accepts a lead with only lead_id and google_key, and ignores fields Google adds later", () => {
    const lead = mapGoogleWebhookLead(JSON.stringify({ lead_id: "abc", google_key: "k", some_future_field: { x: 1 } }));
    expect(lead).toMatchObject({ googleLeadId: "abc", isTest: false, campaignId: null, formId: null, submitTime: null, fieldData: [] });
  });

  it("accepts Google's test-sample spelling Google_key and keeps every spelling out of the stored payload", () => {
    const lead = mapGoogleWebhookLead(JSON.stringify({ lead_id: "x", campaign_id: 123456, Google_key: "secret-key", is_test: true }));
    expect(lead).toMatchObject({ googleKey: "secret-key", isTest: true, campaignId: "123456" });
    expect(Object.keys(lead.rawPayload).some((key) => key.toLowerCase() === "google_key")).toBe(false);
  });

  it("never rejects a lead for a long answer or many questions", () => {
    const longAnswer = "a".repeat(20_000);
    const columns = [column("FULL_NAME", "Ravi"), ...Array.from({ length: 250 }, (_, index) => column(`Q${index}`, "x")), column("OTHER", longAnswer, "Tell us more")];
    const lead = mapGoogleWebhookLead(JSON.stringify({ lead_id: "x".repeat(300), google_key: "k", user_column_data: columns }));
    expect(lead.fieldData).toHaveLength(252);
    expect(lead.fieldData.at(-1)).toEqual({ name: "Tell us more", values: [longAnswer] });
  });

  it("keeps ids above 2^53 exact by reading them from the raw text", () => {
    const lead = mapGoogleWebhookLead('{"lead_id":"x","google_key":"k","campaign_id":12345678901234567890}');
    expect(lead.campaignId).toBe("12345678901234567890");
  });

  it("treats a non-numeric id or a bad timestamp as absent instead of rejecting the lead", () => {
    const lead = mapGoogleWebhookLead(JSON.stringify({ lead_id: "x", google_key: "k", campaign_id: "abc", lead_submit_time: "not a date" }));
    expect(lead).toMatchObject({ campaignId: null, submitTime: null });
  });

  it.each(["not json", "[]", JSON.stringify({ google_key: "k" }), JSON.stringify({ lead_id: "x" }), JSON.stringify({ lead_id: "", google_key: "k" })])(
    "rejects an unusable body %s", (body) => {
      expect(() => mapGoogleWebhookLead(body)).toThrow(GoogleLeadPayloadError);
    });
});

describe("mapUserColumnData", () => {
  it("puts first and last name under the contact keys", () => {
    expect(mapUserColumnData([column("FIRST_NAME", "Ravi"), column("LAST_NAME", "Kumar")])).toEqual([
      { name: "first_name", values: ["Ravi"] }, { name: "last_name", values: ["Kumar"] },
    ]);
  });

  it("uses the work email / work phone as the contact value when the form has no personal one", () => {
    expect(mapUserColumnData([column("WORK_EMAIL", "ravi@corp.com"), column("WORK_PHONE", "9876543210")])).toEqual([
      { name: "email", values: ["ravi@corp.com"] }, { name: "phone_number", values: ["9876543210"] },
    ]);
  });

  it("keeps the work email / phone on their own keys when a personal one exists, whatever the form order", () => {
    expect(mapUserColumnData([column("WORK_EMAIL", "ravi@corp.com"), column("EMAIL", "ravi@example.com"), column("WORK_PHONE", "044 1234 5678"), column("PHONE_NUMBER", "9876543210")])).toEqual([
      { name: "work_email", values: ["ravi@corp.com"] }, { name: "email", values: ["ravi@example.com"] },
      { name: "work_phone", values: ["044 1234 5678"] }, { name: "phone_number", values: ["9876543210"] },
    ]);
  });

  it("prefers the verified phone over the work phone, and drops a verified phone that repeats the phone number", () => {
    expect(mapUserColumnData([column("WORK_PHONE", "0441234567"), column("PHONE_NUMBER_VERIFIED", "+91 98765 43210")])).toEqual([
      { name: "work_phone", values: ["0441234567"] }, { name: "phone_number", values: ["+91 98765 43210"] },
    ]);
    expect(mapUserColumnData([column("PHONE_NUMBER", "+919876543210"), column("PHONE_NUMBER_VERIFIED", "+91 98765 43210")])).toEqual([
      { name: "phone_number", values: ["+919876543210"] },
    ]);
  });

  it("never writes a contact key twice", () => {
    expect(mapUserColumnData([column("EMAIL", "a@example.com"), column("EMAIL", "b@example.com")])).toEqual([{ name: "email", values: ["a@example.com"] }]);
  });

  it("names other answers by question text, else by the lowercased column id", () => {
    expect(mapUserColumnData([column("PROPERTY_TYPE", "Villa"), { column_id: "", column_name: "What is your budget?", string_value: "50L" }])).toEqual([
      { name: "property_type", values: ["Villa"] }, { name: "What is your budget?", values: ["50L"] },
    ]);
  });

  it("never lets a custom question pose as the contact field", () => {
    expect(mapUserColumnData([{ column_id: "", column_name: "Email", string_value: "other@example.com" }])).toEqual([
      { name: "question_Email", values: ["other@example.com"] },
    ]);
  });
});

describe("Google lead redaction before AI labelling", () => {
  it("masks the name, email and phone of a mapped Google lead, including repeats in other answers", () => {
    const fields = mapUserColumnData([column("FULL_NAME", "Ravi Kumar"), column("EMAIL", "ravi@example.com"), column("PHONE_NUMBER", "+919876543210"), column("PREFERRED_CONTACT_TIME", "Call Ravi Kumar on 98765 43210")]);
    expect(redactLeadFieldsForAi(fields)).toEqual([
      { name: "full_name", values: ["[NAME]"] }, { name: "email", values: ["[EMAIL]"] }, { name: "phone_number", values: ["[PHONE]"] },
      { name: "preferred_contact_time", values: ["Call [NAME] on [PHONE]"] },
    ]);
  });

  it("masks a work email / phone that took the contact key", () => {
    const fields = mapUserColumnData([column("WORK_EMAIL", "ravi@corp.com"), column("WORK_PHONE", "9876543210")]);
    expect(redactLeadFieldsForAi(fields)).toEqual([{ name: "email", values: ["[EMAIL]"] }, { name: "phone_number", values: ["[PHONE]"] }]);
  });
});
