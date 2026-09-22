import type { Metadata } from "next";
import { InviteConfirmClient } from "@/features/auth/invite-confirm-client";

export const metadata: Metadata = {
  title: "Accept invitation",
};

export default function InviteConfirmPage() {
  return <InviteConfirmClient />;
}
