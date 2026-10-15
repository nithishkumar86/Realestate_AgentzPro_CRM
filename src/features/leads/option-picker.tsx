"use client";

import { ChevronDown } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export type PickerOption = { value: string; label: string };

/**
 * A single-choice field for the Add Task form (Title, Due Date). A native <select> cannot be spaced or styled and
 * opens upward when the form is low in the scrolling drawer, so this renders its options inline, directly under the
 * field: they always open downward, scroll with the drawer and can never be clipped. It reuses the option look of the
 * app's other dropdowns (.mvp-dropdown-option). Choosing an option only calls onChange.
 */
export function OptionPicker({ labelId, value, options, placeholder, dividerBeforeLast = false, scrollable = false, handsFocusOnValue, onChange }: {
  /** id of the visible label; names the trigger and the list for screen readers. */
  labelId: string;
  /** The `value` of the chosen option, or anything else (such as "") when nothing is chosen. */
  value: string;
  options: readonly PickerOption[];
  /** Shown in the trigger while no option is chosen. */
  placeholder?: string;
  /** Sets the last option apart with a divider (the one that reveals an extra field: "Other", "Custom"). */
  dividerBeforeLast?: boolean;
  /** Caps the list's height and scrolls it inside, for long lists (the 60 minutes). */
  scrollable?: boolean;
  /** The option that moves focus to a field it reveals; choosing it leaves focus to that field. Every other choice returns focus to the trigger. */
  handsFocusOnValue?: string;
  onChange: (next: string) => void;
}) {
  const listId = useId();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chosenIndex = options.findIndex((option) => option.value === value);
  const shownLabel = chosenIndex >= 0 ? options[chosenIndex].label : "";
  const focusIndex = Math.max(0, chosenIndex);

  useEffect(() => {
    if (!open) return;
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]");
    items?.[focusIndex]?.focus();
    // Bring the whole list into view inside the scrolling drawer. (Absent in some test environments.)
    panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open; the focused option must not jump while it is open
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    }
    // Capture phase, so the first Escape closes only this list: the drawer's own Escape handler (which closes the
    // whole drawer) listens on the same document in the bubble phase and never sees the event.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  function choose(next: string) {
    setOpen(false);
    onChange(next);
    // Choosing the option that reveals a field hands focus to that field; every other choice (and re-choosing it when its field is already open) returns it to the trigger.
    if (next !== handsFocusOnValue || value === handsFocusOnValue) triggerRef.current?.focus();
  }

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    items[next]?.focus();
  }

  const tabStop = options[chosenIndex >= 0 ? chosenIndex : 0]?.value;

  return <div className="mvp-option-picker">
    <button ref={triggerRef} type="button" className="mvp-settings-input mvp-option-picker__trigger" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-labelledby={`${labelId} ${valueId}`} onClick={() => setOpen((current) => !current)}>
      <span id={valueId} className={shownLabel ? undefined : "mvp-option-picker__placeholder"}>{shownLabel || placeholder}</span>
      <ChevronDown size={16} className={`mvp-field-chevron${open ? " mvp-field-chevron--open" : ""}`} aria-hidden="true" />
    </button>
    {open ? <div ref={panelRef} id={listId} role="listbox" aria-labelledby={labelId} className={`mvp-option-picker__panel${scrollable ? " mvp-option-picker__panel--scroll" : ""}`} onKeyDown={moveFocus}>
      {options.map((option, index) => <Fragment key={option.value}>
        {dividerBeforeLast && index === options.length - 1 && index > 0 ? <div className="mvp-option-picker__divider" role="separator" /> : null}
        <button type="button" role="option" aria-selected={option.value === value} tabIndex={option.value === tabStop ? 0 : -1}
          className={`mvp-dropdown-option${option.value === value ? " mvp-dropdown-option--active" : ""}`} onClick={() => choose(option.value)}>{option.label}</button>
      </Fragment>)}
    </div> : null}
  </div>;
}
