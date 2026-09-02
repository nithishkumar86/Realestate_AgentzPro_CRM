import type { Metadata } from "next";
import { LeadsPageClient } from "@/features/leads/leads-page-client";

export const metadata: Metadata = {
  title: "Leads",
};

export default function LeadsPage() {
  return <LeadsPageClient />;
}
