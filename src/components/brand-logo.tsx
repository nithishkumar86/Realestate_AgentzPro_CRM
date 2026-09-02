import Image from "next/image";
import logo from "../../logo.png";

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand-logo" aria-label="AgentzPro CRM">
      <Image src={logo} alt="" width={compact ? 34 : 42} height={compact ? 34 : 42} priority />
      <span className="brand-logo__text">AgentzPro</span>
    </div>
  );
}
