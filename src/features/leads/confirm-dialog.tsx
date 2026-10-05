"use client";

import { useEffect, useId, useRef } from "react";

/**
 * A small in-app confirmation (replaces the browser's confirm popup). Click confirms; Escape, the
 * backdrop or Cancel dismisses. Focus starts on the confirm button.
 */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return <div className="mvp-confirm-backdrop" onPointerDown={onCancel}>
    <div className="mvp-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onPointerDown={(event) => event.stopPropagation()}>
      <h2 id={titleId} className="mvp-confirm__title">{title}</h2>
      <p className="mvp-confirm__message">{message}</p>
      <div className="mvp-confirm__actions">
        <button type="button" className="mvp-confirm__button" onClick={onCancel}>Cancel</button>
        <button type="button" ref={confirmRef} className="mvp-confirm__button mvp-confirm__button--primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>;
}
