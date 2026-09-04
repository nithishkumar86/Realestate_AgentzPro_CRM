import { describe, expect, it } from "vitest";
import { parseMetaLeadWebhook } from "@/lib/server/lead-webhook-service";

describe("parseMetaLeadWebhook", () => {
  it("normalizes every leadgen change across entries while ignoring other fields", () => {
    const changes = parseMetaLeadWebhook(JSON.stringify({
      object: "page",
      entry: [
        {
          id: 42,
          time: 1_725_000_000,
          changes: [
            { field: "feed", value: { ignored: true } },
            { field: "leadgen", value: { leadgen_id: 101, page_id: 202, form_id: 303, adgroup_id: 404, ad_id: 505, created_time: 1_725_000_001 } },
          ],
        },
        {
          id: "43",
          time: 1_725_000_002,
          changes: [
            { field: "leadgen", value: { leadgen_id: "102", page_id: "202", form_id: "304", created_time: "1725000003" } },
          ],
        },
      ],
    }));

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      metaEntryId: "42",
      leadgenId: "101",
      facebookPageId: "202",
      formId: "303",
      adgroupId: "404",
      adId: "505",
    });
    expect(changes[1]).toMatchObject({ leadgenId: "102", adgroupId: null, adId: null });
  });

  it("rejects a leadgen change missing a required Meta field", () => {
    expect(() => parseMetaLeadWebhook(JSON.stringify({
      object: "page",
      entry: [{ id: "42", time: 1_725_000_000, changes: [{ field: "leadgen", value: { leadgen_id: "101", page_id: "202", created_time: 1_725_000_001 } }] }],
    }))).toThrow();
  });
});
