"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Moon, Settings, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BrandLogo } from "@/components/brand-logo";

const navigationItems = [
  { href: "/connection", label: "Connection" },
  { href: "/leads", label: "Leads" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

export function CrmShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSettingsMenuOpen, setIsSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const themeMode = useThemeMode();

  useEffect(() => {
    function closeSettingsMenu(event: PointerEvent): void {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target as Node)) {
        setIsSettingsMenuOpen(false);
      }
    }

    function closeSettingsMenuOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsSettingsMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeSettingsMenu);
    document.addEventListener("keydown", closeSettingsMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeSettingsMenu);
      document.removeEventListener("keydown", closeSettingsMenuOnEscape);
    };
  }, []);

  return (
    <div className="crm-shell">
      <header className="app-header">
        <Link href="/connection" className="app-header__brand" aria-label="Go to Connection">
          <BrandLogo />
        </Link>

        <nav className="app-header__nav" aria-label="Main navigation">
          {navigationItems.map((item) => (
            <Link key={item.href} className={getNavClass(pathname, item.href)} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="app-header__actions">
          <button
            type="button"
            className="icon-button theme-toggle"
            aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={themeMode === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => toggleThemeMode(themeMode)}
          >
            {themeMode === "dark" ? <Sun aria-hidden="true" size={20} /> : <Moon aria-hidden="true" size={20} />}
          </button>

          <div ref={settingsMenuRef} className={`settings-menu${isSettingsMenuOpen ? " settings-menu--open" : ""}`}>
            <button
              className={getSettingsClass(pathname)}
              type="button"
              aria-label="Settings"
              aria-expanded={isSettingsMenuOpen}
              aria-haspopup="menu"
              onClick={() => setIsSettingsMenuOpen((current) => !current)}
            >
              <Settings aria-hidden="true" size={22} className="settings-icon" />
              <span className="sr-only">Settings</span>
            </button>
            {isSettingsMenuOpen ? (
              <div className="settings-dropdown" role="menu" aria-label="Settings menu">
                <Link role="menuitem" href="/settings#profile" onClick={() => setIsSettingsMenuOpen(false)}>Profile</Link>
                <Link role="menuitem" href="/settings#subscription" onClick={() => setIsSettingsMenuOpen(false)}>Subscription</Link>
                <Link role="menuitem" href="/settings#logout" onClick={() => setIsSettingsMenuOpen(false)}>Logout</Link>
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className="icon-button app-header__menu"
          aria-label={isMobileMenuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={isMobileMenuOpen}
          onClick={() => setIsMobileMenuOpen((current) => !current)}
        >
          {isMobileMenuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
        </button>
      </header>

      {isMobileMenuOpen ? (
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navigationItems.map((item) => (
            <Link key={item.href} className={getNavClass(pathname, item.href)} href={item.href} onClick={() => setIsMobileMenuOpen(false)}>
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <main className="app-main">{children}</main>
    </div>
  );
}

function getNavClass(pathname: string, href: string): string {
  return pathname === href ? "nav-link nav-link--active" : "nav-link";
}

function getSettingsClass(pathname: string): string {
  return pathname === "/settings" ? "settings-icon-link settings-icon-link--active" : "settings-icon-link";
}

type ThemeMode = "light" | "dark";

function useThemeMode(): ThemeMode {
  const themeMode = useSyncExternalStore<ThemeMode>(subscribeToThemeChanges, getThemeSnapshot, () => "light");

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  return themeMode;
}

function toggleThemeMode(currentThemeMode: ThemeMode): void {
  const nextThemeMode = currentThemeMode === "dark" ? "light" : "dark";
  window.localStorage.setItem("agentzpro-theme", nextThemeMode);
  document.documentElement.dataset.theme = nextThemeMode;
  window.dispatchEvent(new Event("agentzpro-theme-change"));
}

function subscribeToThemeChanges(onStoreChange: () => void): () => void {
  window.addEventListener("agentzpro-theme-change", onStoreChange);
  window.addEventListener("storage", onStoreChange);

  return () => {
    window.removeEventListener("agentzpro-theme-change", onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function getThemeSnapshot(): ThemeMode {
  const storedTheme = window.localStorage.getItem("agentzpro-theme");
  if (storedTheme === "dark" || storedTheme === "light") {
    return storedTheme;
  }

  const preferredTheme: ThemeMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return preferredTheme;
}
