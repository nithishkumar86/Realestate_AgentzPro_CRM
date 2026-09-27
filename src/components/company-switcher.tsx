import Link from "next/link";
import { Building2, ChevronsUpDown } from "lucide-react";

export interface CompanySwitcherProps {
  tenantName: string;
}

/** Top-of-sidebar company switcher: always shows the active company, opens the company picker. */
export function CompanySwitcher({ tenantName }: Readonly<CompanySwitcherProps>) {
  return (
    <Link
      className="mvp-company-switcher"
      href="/workspaces"
      aria-label={`Switch company (current: ${tenantName})`}
      title="Switch company"
    >
      <span className="mvp-company-switcher__icon" aria-hidden="true">
        <Building2 size={16} />
      </span>
      <span className="mvp-company-switcher__text">
        <span className="mvp-company-switcher__label">Company</span>
        <strong className="mvp-company-switcher__name">{tenantName}</strong>
      </span>
      <ChevronsUpDown className="mvp-company-switcher__chevron" size={16} aria-hidden="true" />
    </Link>
  );
}
