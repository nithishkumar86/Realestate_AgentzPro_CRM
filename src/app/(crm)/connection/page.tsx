import type { Metadata } from "next";
import { ConnectionPageClient } from "@/features/connection/connection-page-client";

export const metadata: Metadata = {
  title: "Connection",
};

export default function ConnectionPage() {
  return <ConnectionPageClient />;
}
