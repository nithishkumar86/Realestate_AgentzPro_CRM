import type { Metadata } from "next";
import { SettingsPageClient } from "@/features/settings/settings-page-client";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <SettingsPageClient />;
}
