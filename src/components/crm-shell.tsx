"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, ClipboardList, Link2, LogOut } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarToggle } from "@/components/sidebar-toggle";

const navigation = [
  { href: "/leads", label: "Leads", icon: ClipboardList },
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/connection", label: "Connection", icon: Link2 },
] as const;

export interface CrmShellProps {
  children: React.ReactNode;
  fullName: string;
  tenantName: string;
}

export function CrmShell({ children, fullName, tenantName }: Readonly<CrmShellProps>) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut(): Promise<void> {
    setIsSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="mvp-shell">
      <div className="theme-toggle-fixed">
        <ThemeToggle />
      </div>
      <aside className="mvp-sidebar" aria-label="Primary navigation">
        <SidebarToggle />
        <Link className="mvp-sidebar__brand" href="/leads" aria-label="Go to Leads">
          <BrandLogo />
        </Link>
        <nav className="mvp-sidebar__nav">
          {navigation.map(({ href, label, icon: Icon }) => (
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
        <div className="mvp-sidebar__user">
          <div className="mvp-sidebar__user-info">
            <strong className="mvp-sidebar__user-name">{fullName}</strong>
            <span className="mvp-sidebar__user-tenant">{tenantName}</span>
          </div>
          <button
            type="button"
            className="mvp-sidebar__sign-out"
            title="Sign out"
            disabled={isSigningOut}
            onClick={() => void handleSignOut()}
          >
            <LogOut size={17} aria-hidden="true" />
            <span className="mvp-nav-link__label">{isSigningOut ? "Signing out…" : "Sign out"}</span>
          </button>
        </div>
      </aside>
      <main className="mvp-main">{children}</main>
    </div>
  );
}
