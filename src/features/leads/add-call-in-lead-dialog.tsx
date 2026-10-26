"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CALL_IN_PHONE_MAX_LENGTH, CALL_IN_PHONE_MIN_DIGITS, CALL_IN_TEXT_MAX_LENGTH } from "@/features/leads/lead-options";
import { readError } from "@/features/leads/use-lead-filters";

type Field = "leadName" | "phone" | "whatsapp" | "projectName";
type Values = Record<Field, string>;

const EMPTY: Values = { leadName: "", phone: "", whatsapp: "", projectName: "" };
const hasEnoughDigits = (value: string) => value.replace(/\D/g, "").length >= CALL_IN_PHONE_MIN_DIGITS;

export function validateCallInLead(values: Values): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!values.leadName.trim()) errors.leadName = "Enter the lead's name.";
  if (!hasEnoughDigits(values.phone)) errors.phone = `Enter a phone number with at least ${CALL_IN_PHONE_MIN_DIGITS} digits.`;
  if (values.whatsapp.trim() && !hasEnoughDigits(values.whatsapp)) errors.whatsapp = `Enter a WhatsApp number with at least ${CALL_IN_PHONE_MIN_DIGITS} digits, or leave it empty.`;
  if (!values.projectName.trim()) errors.projectName = "Enter the project name.";
  return errors;
}

/** The "+" form on the Leads page: a member adds a lead who phoned in. Saved as a Telecaller lead assigned to them. */
export function AddCallInLeadDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !saving) onClose(); }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const update = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextErrors = validateCallInLead(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch("/api/leads/telecaller", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadName: values.leadName.trim(), phone: values.phone.trim(), whatsapp: values.whatsapp.trim(), projectName: values.projectName.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response, "The lead could not be saved."));
      onSaved();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The lead could not be saved.");
      setSaving(false);
    }
  }

  const input = (field: Field, label: string, options: { required?: boolean; type?: "text" | "tel"; maxLength: number; placeholder: string }) => <label className="mvp-call-in__field">
    <span>{label}{options.required ? <em aria-hidden="true"> *</em> : <small> (optional)</small>}</span>
    <input ref={field === "leadName" ? firstFieldRef : undefined} type={options.type ?? "text"} inputMode={options.type === "tel" ? "tel" : undefined}
      value={values[field]} maxLength={options.maxLength} placeholder={options.placeholder} required={options.required}
      aria-invalid={errors[field] ? true : undefined} onChange={(event) => update(field, event.target.value)} />
    {errors[field] ? <span className="mvp-call-in__error" role="alert">{errors[field]}</span> : null}
  </label>;

  return <div className="mvp-call-in__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="mvp-call-in" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="mvp-call-in__header">
        <h2 id={titleId}>Add call-in lead</h2>
        <button type="button" className="mvp-dropdown-close" aria-label="Close" disabled={saving} onClick={onClose}><X size={14} /></button>
      </div>
      <form className="mvp-call-in__form" noValidate onSubmit={(event) => void submit(event)}>
        {input("leadName", "Lead Name", { required: true, maxLength: CALL_IN_TEXT_MAX_LENGTH, placeholder: "Full name" })}
        {input("phone", "Phone", { required: true, type: "tel", maxLength: CALL_IN_PHONE_MAX_LENGTH, placeholder: "10-digit mobile number" })}
        {input("whatsapp", "WhatsApp", { type: "tel", maxLength: CALL_IN_PHONE_MAX_LENGTH, placeholder: "WhatsApp number" })}
        {input("projectName", "Project Name", { required: true, maxLength: CALL_IN_TEXT_MAX_LENGTH, placeholder: "Project the lead asked about" })}
        {formError ? <div className="mvp-inline-error" role="alert">{formError}</div> : null}
        <div className="mvp-call-in__actions">
          <button type="button" className="mvp-call-in__cancel" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="mvp-date-popover__apply mvp-call-in__save" disabled={saving}>{saving ? "Saving..." : "Save lead"}</button>
        </div>
      </form>
    </div>
  </div>;
}
