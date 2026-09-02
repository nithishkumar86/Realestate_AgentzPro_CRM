import { CrmShell } from "@/components/crm-shell";

export default function CrmLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <CrmShell>{children}</CrmShell>;
}
