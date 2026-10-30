import type { Metadata } from "next";
import { parseDashboardPlatform } from "@/features/dashboard/dashboard-platforms";
import { DashboardPageClient } from "@/features/dashboard/dashboard-page-client";

export const metadata: Metadata = { title: "Dashboard" };

/** `?platform=google_ads` opens that platform's view if the company uses it; otherwise the company's first platform opens. */
export default async function DashboardPage({ searchParams }: Readonly<{ searchParams: Promise<{ platform?: string | string[] }> }>) {
  const { platform } = await searchParams;
  return <DashboardPageClient initialPlatform={parseDashboardPlatform(platform)} />;
}
