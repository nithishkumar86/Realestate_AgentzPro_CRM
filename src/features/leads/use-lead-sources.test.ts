import { describe, expect, it } from "vitest";
import { availableLeadSources } from "@/features/leads/use-lead-sources";

const NO_META = { pages: [] };
const META_PAGE = { pages: [{ id: "page-1", connectionId: "c-1", pageName: "Chennai Homes", category: null, pageIdLastFour: "1234", status: "active" as const, lastConnectedAt: "2026-10-01T00:00:00Z" }] };
const NO_GOOGLE = { hasWebhook: false, webhookStopped: false };
const NO_WEBHOOK = { hasWebhook: false, webhookStopped: false };

describe("availableLeadSources", () => {
  it("offers only Telecaller to a company with nothing connected", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK })).toEqual(["telecaller"]);
  });

  it("counts Facebook once a Page was connected, not at Facebook login", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK })).not.toContain("facebook");
    expect(availableLeadSources({ meta: META_PAGE, google: NO_GOOGLE, webhook: NO_WEBHOOK })).toEqual(["facebook", "telecaller"]);
  });

  it("keeps Facebook after its Page was disconnected, so old leads stay filterable", () => {
    const disconnected = { pages: [{ ...META_PAGE.pages[0], status: "disconnected" as const }] };
    expect(availableLeadSources({ meta: disconnected, google: NO_GOOGLE, webhook: NO_WEBHOOK })).toContain("facebook");
  });

  it.each([
    ["the webhook was created", { ...NO_GOOGLE, hasWebhook: true }],
    ["the webhook was stopped", { ...NO_GOOGLE, webhookStopped: true }],
  ])("counts Google Ads once %s", (_case, google) => {
    expect(availableLeadSources({ meta: NO_META, google, webhook: NO_WEBHOOK })).toEqual(["telecaller", "google_ads"]);
  });

  // Without a webhook no Google lead can exist yet. After "Disconnect Google" the API sends `connection: null` with the
  // same webhook flags, so counting the sign-in would make Google Ads appear and then vanish.
  it("does not count Google sign-in alone, which brings no leads", () => {
    const signedInOnly = { ...NO_GOOGLE, connection: { email: "owner@example.com", connectedAt: "2026-10-01T00:00:00Z" } };
    expect(availableLeadSources({ meta: NO_META, google: signedInOnly, webhook: NO_WEBHOOK })).toEqual(["telecaller"]);
  });

  it.each([
    ["the webhook was created", { ...NO_WEBHOOK, hasWebhook: true }],
    ["the webhook was stopped", { ...NO_WEBHOOK, webhookStopped: true }],
  ])("counts Webhook once %s, and only then", (_case, webhook) => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook })).toEqual(["telecaller", "custom_webhook"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK })).not.toContain("custom_webhook");
  });

  it("lists Facebook and Google Ads in the usual order when both are connected", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: NO_WEBHOOK })).toEqual(["facebook", "telecaller", "google_ads"]);
  });

  it("lists every source, in the usual order, when all are connected", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true } }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook"]);
  });

  it("keeps a source whose check could not be loaded, so an error never hides real leads", () => {
    expect(availableLeadSources({ meta: null, google: NO_GOOGLE, webhook: NO_WEBHOOK })).toEqual(["facebook", "telecaller"]);
    expect(availableLeadSources({ meta: NO_META, google: null, webhook: NO_WEBHOOK })).toEqual(["telecaller", "google_ads"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: null })).toEqual(["telecaller", "custom_webhook"]);
  });
});
