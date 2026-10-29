"use client";

import { ChevronDown, Megaphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DASHBOARD_PLATFORMS, getDashboardPlatform, type DashboardPlatformId } from "@/features/dashboard/dashboard-platforms";

/**
 * The dashboard's "Leads: Facebook ▾" switch at the top right. It uses the same trigger, panel and option rows as the
 * filter bar's dropdowns (.mvp-field-box / .mvp-dropdown-panel), but has no "All" row: the dashboard always shows
 * exactly one platform. Options come from DASHBOARD_PLATFORMS, so a new platform appears here by itself.
 */
export function PlatformSwitcher({ value, onChange }: { value: DashboardPlatformId; onChange: (next: DashboardPlatformId) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("mousedown", handlePointerDown); document.removeEventListener("keydown", handleKeyDown); };
  }, [open]);

  function choose(next: DashboardPlatformId) {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== value) onChange(next);
  }

  return <div className="mvp-field-box dash-platform" ref={containerRef}>
    <button ref={triggerRef} type="button" className="mvp-field-box__control" aria-haspopup="listbox" aria-expanded={open} aria-label={`Leads platform: ${getDashboardPlatform(value).label}`} onClick={() => setOpen(!open)}>
      <span className="mvp-field-box__icon"><Megaphone size={16} aria-hidden="true" /></span>
      <span className="mvp-field-box__value"><span className="dash-platform__caption">Leads:</span> {getDashboardPlatform(value).label}</span>
      <ChevronDown size={16} className={`mvp-field-chevron${open ? " mvp-field-chevron--open" : ""}`} aria-hidden="true" />
    </button>
    {open ? <div className="mvp-dropdown-panel dash-platform__panel" role="listbox" aria-label="Leads platform">
      <div className="mvp-dropdown-panel__header">
        <span>Leads platform</span>
        <button type="button" className="mvp-dropdown-close" aria-label="Close Leads platform options" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={14} /></button>
      </div>
      <div className="mvp-dropdown-panel__options">
        {DASHBOARD_PLATFORMS.map((platform) => <button key={platform.id} type="button" role="option" aria-selected={value === platform.id}
          className={`mvp-dropdown-option${value === platform.id ? " mvp-dropdown-option--active" : ""}`} onClick={() => choose(platform.id)}>{platform.label}</button>)}
      </div>
    </div> : null}
  </div>;
}
