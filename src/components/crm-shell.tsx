"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ClipboardList, CreditCard, Link2 } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { SidebarCollapseButton, SidebarExpandButton } from "@/components/sidebar-toggle";
import { UserMenu } from "@/components/user-menu";

const navigation = [
  { href: "/leads", label: "Leads", icon: ClipboardList },
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/connection", label: "Connection", icon: Link2 },
] as const;

// Billing is managed by the company owner only.
const ownerNavigation = [{ href: "/billing", label: "Billing", icon: CreditCard }] as const;

export interface CrmShellProps {
  children: React.ReactNode;
  fullName: string;
  tenantName: string;
  membershipRole?: string;
}

export function CrmShell({ children, fullName, tenantName, membershipRole }: Readonly<CrmShellProps>) {
  const pathname = usePathname();
  const links = membershipRole === "owner" ? [...navigation, ...ownerNavigation] : navigation;

  return (
    <div className="mvp-shell">
      <SidebarExpandButton />
      <aside className="mvp-sidebar" id="primary-sidebar" aria-label="Primary navigation">
        <SidebarCollapseButton />
        <Link className="mvp-sidebar__brand" href="/leads" aria-label="Go to Leads">
          <BrandLogo />
        </Link>
        <nav className="mvp-sidebar__nav">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              className={pathname === href ? "mvp-nav-link mvp-nav-link--active" : "mvp-nav-link"}
              href={href}
              key={href}
              title={label}
            >
              <Icon size={19} aria-hidden="true" />
              <span className="mvp-nav-link__label">{label}</span>
            </Link>
          ))}
        </nav>
        <UserMenu fullName={fullName} tenantName={tenantName} />
      </aside>
      <main className="mvp-main">{children}</main>
    </div>
  );
}
