"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronUp,
  CircleArrowUp,
  LogOut,
  Settings,
} from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
import { ThemeToggle } from "@/components/theme-toggle";

export interface UserMenuProps {
  fullName: string;
  tenantName: string;
}

export function UserMenu({ fullName, tenantName }: Readonly<UserMenuProps>) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  // Profile is reached only through Settings › Your account › Profile.
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const popupId = useId();

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeAndRestoreFocus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, closeAndRestoreFocus]);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Move focus into the menu on open so keyboard users land on the only action.
  useEffect(() => {
    if (isOpen) {
      popupRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [isOpen]);

  async function handleLogout(): Promise<void> {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  function openSettings(): void {
    setIsOpen(false);
    setIsSettingsOpen(true);
  }

  return (
    <div className="mvp-user-menu" ref={containerRef}>
      {isOpen ? (
        <div className="mvp-user-menu__popup" id={popupId} ref={popupRef} aria-label="Account menu">
          <button type="button" className="mvp-user-menu__item" onClick={openSettings}>
            <Settings size={17} aria-hidden="true" />
            <span>Settings</span>
          </button>

          <div className="mvp-user-menu__theme">
            <ThemeToggle />
          </div>

          <div className="mvp-user-menu__item mvp-user-menu__item--static">
            <CircleArrowUp size={17} aria-hidden="true" />
            <span>Upgrade plan</span>
          </div>

          <div className="mvp-user-menu__divider" role="separator" />

          <button
            type="button"
            className="mvp-user-menu__item mvp-user-menu__item--danger"
            disabled={isLoggingOut}
            onClick={() => void handleLogout()}
          >
            <LogOut size={17} aria-hidden="true" />
            <span>{isLoggingOut ? "Logging out…" : "Logout"}</span>
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="mvp-user-menu__trigger"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="mvp-user-menu__identity">
          <strong className="mvp-user-menu__name">{fullName}</strong>
          <span className="mvp-user-menu__tenant">{tenantName}</span>
        </span>
        <ChevronUp className="mvp-user-menu__chevron" size={16} aria-hidden="true" />
      </button>

      {isSettingsOpen ? <SettingsDialog fullName={fullName} onClose={closeSettings} /> : null}
    </div>
  );
}
