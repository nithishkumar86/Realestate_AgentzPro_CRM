import type { Metadata } from "next";
import { LeadsPageClient } from "@/features/leads/leads-page-client";

export const metadata: Metadata = {
  title: "Leads",
};

export default async function LeadsPage({ searchParams }: Readonly<{ searchParams: Promise<{ lead?: string }> }>) {
  const { lead } = await searchParams;
  return <LeadsPageClient focusLeadId={lead} />;
}
