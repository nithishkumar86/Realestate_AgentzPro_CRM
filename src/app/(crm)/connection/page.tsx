import type { Metadata } from "next";
import { ConnectionPageClient } from "@/features/connection/connection-page-client";
import { CustomWebhookConnectionCard } from "@/features/connection/custom-webhook-connection-card";
import { GoogleAdsConnectionCard } from "@/features/connection/google-ads-connection-card";

export const metadata: Metadata = {
  title: "Connection",
};

export default function ConnectionPage() {
  return <div className="stack">
    <ConnectionPageClient />
    <GoogleAdsConnectionCard />
    <CustomWebhookConnectionCard />
  </div>;
}
