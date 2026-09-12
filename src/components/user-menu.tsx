"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  Building2,
  ChevronUp,
  CircleAlert,
  CircleArrowUp,
  LoaderCircle,
  LogOut,
  Mail,
  Phone,
  RotateCcw,
  Settings,
  User,
  X,
} from "lucide-react";
import { getProfileDetails, type ProfileDetails } from "@/services/profile-api-client";
import { ThemeToggle } from "@/components/theme-toggle";

export interface UserMenuProps {
  fullName: string;
  tenantName: string;
}

type ProfileState =
  | { status: "loading" }
  | { status: "success"; profile: ProfileDetails }
  | { status: "error"; message: string };

export function UserMenu({ fullName, tenantName }: Readonly<UserMenuProps>) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profileRequestVersion, setProfileRequestVersion] = useState(0);
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const profileDialogRef = useRef<HTMLDivElement | null>(null);
  const profileCloseButtonRef = useRef<HTMLButtonElement | null>(null);
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

  const closeProfile = useCallback(() => {
    setIsProfileOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isProfileOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    profileCloseButtonRef.current?.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeProfile();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = profileDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) {
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDialogKeyDown);
    };
  }, [closeProfile, isProfileOpen]);

  useEffect(() => {
    if (!isProfileOpen) {
      return;
    }

    const controller = new AbortController();
    void getProfileDetails(controller.signal)
      .then((profile) => setProfileState({ status: "success", profile }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setProfileState({
            status: "error",
            message: error instanceof Error ? error.message : "Your profile could not be loaded.",
          });
        }
      });

    return () => controller.abort();
  }, [isProfileOpen, profileRequestVersion]);

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

  function openProfile(): void {
    setIsOpen(false);
    setProfileState({ status: "loading" });
    setIsProfileOpen(true);
  }

  function retryProfile(): void {
    setProfileState({ status: "loading" });
    setProfileRequestVersion((version) => version + 1);
  }

  return (
    <div className="mvp-user-menu" ref={containerRef}>
      {isOpen ? (
        <div className="mvp-user-menu__popup" id={popupId} ref={popupRef} aria-label="Account menu">
          <div className="mvp-user-menu__item mvp-user-menu__item--static">
            <Settings size={17} aria-hidden="true" />
            <span>Settings</span>
          </div>

          <button type="button" className="mvp-user-menu__item" onClick={openProfile}>
            <User size={17} aria-hidden="true" />
            <span>Profile</span>
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

      {isProfileOpen ? (
        <ProfileDialog
          dialogRef={profileDialogRef}
          closeButtonRef={profileCloseButtonRef}
          state={profileState}
          onClose={closeProfile}
          onRetry={retryProfile}
        />
      ) : null}
    </div>
  );
}

function ProfileDialog({
  dialogRef,
  closeButtonRef,
  state,
  onClose,
  onRetry,
}: Readonly<{
  dialogRef: React.RefObject<HTMLDivElement | null>;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  state: ProfileState;
  onClose: () => void;
  onRetry: () => void;
}>) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div
      className="mvp-profile-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="mvp-profile-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="mvp-profile-dialog__header">
          <div>
            <span className="mvp-profile-dialog__eyebrow">Account</span>
            <h2 id={titleId}>Profile details</h2>
            <p id={descriptionId}>Your personal and company information.</p>
          </div>
          <button
            type="button"
            className="mvp-profile-dialog__close"
            ref={closeButtonRef}
            aria-label="Close profile"
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="mvp-profile-dialog__body">
          {state.status === "loading" ? <ProfileLoading /> : null}
          {state.status === "error" ? <ProfileError message={state.message} onRetry={onRetry} /> : null}
          {state.status === "success" ? <ProfileContent profile={state.profile} /> : null}
        </div>
      </div>
    </div>
  );
}

function ProfileLoading() {
  return (
    <div className="mvp-profile-loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={26} aria-hidden="true" />
      <div>
        <strong>Loading your profile</strong>
        <span>Please wait a moment.</span>
      </div>
    </div>
  );
}

function ProfileError({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div className="mvp-profile-error" role="alert">
      <span className="mvp-profile-error__icon"><CircleAlert size={24} aria-hidden="true" /></span>
      <div>
        <strong>Profile unavailable</strong>
        <p>{message}</p>
        <button type="button" onClick={onRetry}>
          <RotateCcw size={15} aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
}

function ProfileContent({ profile }: Readonly<{ profile: ProfileDetails }>) {
  const fields = [
    { label: "Name", value: profile.fullName, icon: User },
    { label: "Phone", value: profile.phoneNumber, icon: Phone },
    { label: "Email", value: profile.emailAddress, icon: Mail },
    { label: "Company", value: profile.companyName, icon: Building2 },
    { label: "Professional Role", value: profile.professionalRole, icon: BriefcaseBusiness },
  ] as const;

  return (
    <>
      <div className="mvp-profile-summary">
        <span className="mvp-profile-summary__avatar" aria-hidden="true">{getInitials(profile.fullName)}</span>
        <div>
          <strong>{profile.fullName}</strong>
          <span>{profile.professionalRole}</span>
        </div>
      </div>

      <dl className="mvp-profile-fields">
        {fields.map(({ label, value, icon: Icon }) => (
          <div className="mvp-profile-field" key={label}>
            <span className="mvp-profile-field__icon"><Icon size={18} aria-hidden="true" /></span>
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </>
  );
}

function getInitials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}
