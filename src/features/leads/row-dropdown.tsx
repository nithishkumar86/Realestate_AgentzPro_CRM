"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PanelPosition = { left: number; width: number; top: number | "auto"; bottom: number | "auto" };

// Same row metrics as .mvp-dropdown-option / .mvp-dropdown-panel__options (38px rows, 4px gap, 8px padding).
const panelHeight = (count: number) => Math.min(260, count * 38 + (count - 1) * 4 + 16) + 4;

/**
 * The per-row Status / Label picker. It reuses the exact panel and option classes of the
 * "All statuses" filter dropdown, so both look and space their options identically, but it is a
 * separate component: the filter's own dropdown is untouched. The table wrapper scrolls
 * (overflow: auto), which would clip an absolutely positioned panel, so the panel is portalled to
 * <body> and pinned with position: fixed beside the trigger (flipping upward near the screen bottom).
 * Choosing an option only calls onChange; the caller keeps the confirm popup, the same-value no-op
 * and the save exactly as before.
 */
export function RowDropdown<T extends string>({ ariaLabel, value, options, open, onOpenChange, onChange, width = 180 }: {
  ariaLabel: string; value: T; options: readonly T[]; open: boolean; onOpenChange: (open: boolean) => void; onChange: (next: T) => void; width?: number;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const needed = panelHeight(options.length) + 8;
    const below = window.innerHeight - rect.bottom;
    const flipUp = below < needed && rect.top > below;
    const panelWidth = Math.min(300, Math.max(rect.width, 220));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
    // Both edges are always set: the shared .mvp-dropdown-panel rule carries its own `top`, which would
    // otherwise fight an upward-flipped panel's `bottom` and squash it.
    setPosition(flipUp ? { left, width: panelWidth, top: "auto", bottom: window.innerHeight - rect.top + 8 } : { left, width: panelWidth, top: rect.bottom + 8, bottom: "auto" });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    }
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    function handleScroll(event: Event) { if (!panelRef.current?.contains(event.target as Node)) close(); }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onOpenChange]);

  return <>
    <button ref={triggerRef} type="button" className="mvp-row-dropdown" style={{ width }} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => onOpenChange(!open)}>
      <span className="mvp-row-dropdown__value">{value}</span>
      <ChevronDown size={14} className={`mvp-field-chevron${open ? " mvp-field-chevron--open" : ""}`} />
    </button>
    {open && position ? createPortal(
      <div ref={panelRef} className="mvp-dropdown-panel mvp-row-dropdown__panel" role="listbox" aria-label={ariaLabel} style={position}>
        <div className="mvp-dropdown-panel__options">
          {options.map((option) => <button key={option} type="button" role="option" aria-selected={option === value} className={`mvp-dropdown-option${option === value ? " mvp-dropdown-option--active" : ""}`} onClick={() => { onOpenChange(false); onChange(option); }}>{option}</button>)}
        </div>
      </div>,
      document.body,
    ) : null}
  </>;
}
