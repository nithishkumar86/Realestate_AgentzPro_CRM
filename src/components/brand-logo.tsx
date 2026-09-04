import Image from "next/image";
import logoIcon from "../logo-icon.png";

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  const size = compact ? 34 : 42;
  return (
    <div className="brand-logo" aria-label="AgentzPro CRM">
      <Image className="brand-logo__mark" src={logoIcon} alt="" width={size} height={size} priority />
      <span className="brand-logo__text">AgentzPro</span>
    </div>
  );
}
