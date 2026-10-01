import { Building2 } from "lucide-react";

export interface CompanySwitcherProps {
  tenantName: string;
}

/** Top-of-sidebar company label. One login belongs to one company, so there is nothing to switch to. */
export function CompanySwitcher({ tenantName }: Readonly<CompanySwitcherProps>) {
  return (
    <div className="mvp-company-switcher" title={tenantName}>
      <span className="mvp-company-switcher__icon" aria-hidden="true">
        <Building2 size={16} />
      </span>
      <span className="mvp-company-switcher__text">
        <span className="mvp-company-switcher__label">Company</span>
        <strong className="mvp-company-switcher__name">{tenantName}</strong>
      </span>
    </div>
  );
}
