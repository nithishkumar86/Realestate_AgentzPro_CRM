"use client";

import { CircleCheck, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { CALL_IN_PHONE_MAX_LENGTH, CALL_IN_PHONE_MIN_DIGITS, CALL_IN_REF_LABELS, CALL_IN_TEXT_MAX_LENGTH, type CallInPlatform } from "@/features/leads/lead-options";
import { OptionPicker } from "@/features/leads/option-picker";
import { readError } from "@/features/leads/use-lead-filters";

type Field = "leadName" | "phone" | "whatsapp" | "projectName";
type Values = Record<Field, string>;
type FieldErrors = Partial<Record<Field | "cameFrom", string>>;

/** GET /api/leads/telecaller/origins: the platforms connected right now, each with its named ads or campaigns. */
export type CallInOrigins = { today: string; minDate: string; platforms: Array<{ id: CallInPlatform; label: string; refs: Array<{ id: string; name: string }> }> };

const EMPTY: Values = { leadName: "", phone: "", whatsapp: "", projectName: "" };
/** The ad / campaign picker's "Not sure" choice: saved as no ad. */
const REF_NOT_SURE = "__not_sure__";
const hasEnoughDigits = (value: string) => value.replace(/\D/g, "").length >= CALL_IN_PHONE_MIN_DIGITS;

export function validateCallInLead(values: Values): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!values.leadName.trim()) errors.leadName = "Enter the lead's name.";
  if (!hasEnoughDigits(values.phone)) errors.phone = `Enter a phone number with at least ${CALL_IN_PHONE_MIN_DIGITS} digits.`;
  if (values.whatsapp.trim() && !hasEnoughDigits(values.whatsapp)) errors.whatsapp = `Enter a WhatsApp number with at least ${CALL_IN_PHONE_MIN_DIGITS} digits, or leave it empty.`;
  if (!values.projectName.trim()) errors.projectName = "Enter the project name.";
  return errors;
}

/**
 * The platform a lead is credited to once the origins are known: the only connected one is chosen for the member; with
 * two or more the member picks (a choice still connected is kept). With none connected there is nothing to pick.
 */
export function resolveCameFrom(origins: CallInOrigins, current: string): string {
  if (origins.platforms.length === 1) return origins.platforms[0].id;
  return origins.platforms.some((platform) => platform.id === current) ? current : "";
}

const formatDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/**
 * The "+" form on the Leads page: a member adds a lead who phoned in. Saved as a Telecaller lead assigned to them,
 * credited to the platform (and optionally the ad or campaign) the person came from, on the day of the call.
 */
export function AddCallInLeadDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const cameFromLabelId = useId();
  const refLabelId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [origins, setOrigins] = useState<CallInOrigins | null>(null);
  const [originsError, setOriginsError] = useState<string | null>(null);
  // Where the lead came from: the platform, and the ad / campaign on it ("" = not picked yet).
  const [choice, setChoice] = useState<{ platform: string; ref: string }>({ platform: "", ref: "" });
  const [callDate, setCallDate] = useState("");
  const [savedOn, setSavedOn] = useState<string | null>(null);

  const loadOrigins = useCallback(async () => {
    try {
      const response = await fetch("/api/leads/telecaller/origins");
      if (!response.ok) throw new Error(await readError(response, "Lead platforms could not be loaded."));
      const next = await response.json() as CallInOrigins;
      setOrigins(next);
      setOriginsError(null);
      setChoice((current) => {
        const platform = resolveCameFrom(next, current.platform);
        // An ad that is no longer offered is dropped; "Not sure" and a still-offered ad are kept.
        const keepRef = platform === current.platform && (current.ref === REF_NOT_SURE || next.platforms.find((entry) => entry.id === platform)?.refs.some((entry) => entry.id === current.ref));
        return { platform, ref: keepRef ? current.ref : "" };
      });
      setCallDate((current) => current && current >= next.minDate && current <= next.today ? current : next.today);
    } catch (cause) {
      setOriginsError(cause instanceof Error ? cause.message : "Lead platforms could not be loaded.");
    }
  }, []);

  useEffect(() => { void loadOrigins(); }, [loadOrigins]);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !saving && !savedOn) onClose(); }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving, savedOn]);

  const update = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  const platforms = origins?.platforms ?? [];
  const chosenPlatform = platforms.find((platform) => platform.id === choice.platform);
  const refId = choice.ref;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!origins) return;
    const nextErrors: FieldErrors = validateCallInLead(values);
    if (platforms.length > 0 && !chosenPlatform) nextErrors.cameFrom = "Pick where the lead came from.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch("/api/leads/telecaller", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leadName: values.leadName.trim(), phone: values.phone.trim(), whatsapp: values.whatsapp.trim(), projectName: values.projectName.trim(),
          ...(chosenPlatform ? { cameFromPlatform: chosenPlatform.id } : {}),
          ...(chosenPlatform && refId && refId !== REF_NOT_SURE ? { cameFromRefId: refId } : {}),
          callDate,
        }),
      });
      if (!response.ok) {
        const message = await readError(response, "The lead could not be saved.");
        // The connected platforms or ads may have changed while the form was open: show the current ones.
        void loadOrigins();
        throw new Error(message);
      }
      // A lead dated another day is not at the top of today's list, so say where it went before closing.
      if (callDate !== origins.today) { setSaving(false); setSavedOn(callDate); return; }
      onSaved();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The lead could not be saved.");
      setSaving(false);
    }
  }

  // The call date is picked on the calendar only, never typed: keys other than Tab / Escape are blocked, and
  // Enter / Space open the calendar. showPicker can throw (or be missing) where the browser does not allow it.
  const openCalendar = (input: HTMLInputElement) => { try { input.showPicker?.(); } catch { /* the field still opens its own calendar */ } };
  const onDateKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" || event.key === "Escape") return;
    event.preventDefault();
    if (event.key === "Enter" || event.key === " ") openCalendar(event.currentTarget);
  };
  const onDateClick = (event: ReactMouseEvent<HTMLInputElement>) => openCalendar(event.currentTarget);

  const input = (field: Field, label: string, options: { required?: boolean; type?: "text" | "tel"; maxLength: number; placeholder: string }) => <label className="mvp-call-in__field">
    <span>{label}{options.required ? <em aria-hidden="true"> *</em> : <small> (optional)</small>}</span>
    <input ref={field === "leadName" ? firstFieldRef : undefined} type={options.type ?? "text"} inputMode={options.type === "tel" ? "tel" : undefined}
      value={values[field]} maxLength={options.maxLength} placeholder={options.placeholder} required={options.required}
      aria-invalid={errors[field] ? true : undefined} onChange={(event) => update(field, event.target.value)} />
    {errors[field] ? <span className="mvp-call-in__error" role="alert">{errors[field]}</span> : null}
  </label>;

  if (savedOn) return <SavedOnPopup day={savedOn} onOk={onSaved} />;

  const refLabel = chosenPlatform ? CALL_IN_REF_LABELS[chosenPlatform.id] : "";
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
        {platforms.length === 1 ? <div className="mvp-call-in__field">
          <span id={cameFromLabelId}>Came from</span>
          <div className="mvp-settings-input mvp-call-in__fixed" aria-labelledby={cameFromLabelId}>{platforms[0].label}</div>
        </div> : null}
        {platforms.length > 1 ? <div className="mvp-call-in__field">
          <span id={cameFromLabelId}>Came from<em aria-hidden="true"> *</em></span>
          <OptionPicker labelId={cameFromLabelId} value={choice.platform} placeholder="Select the platform" options={platforms.map((platform) => ({ value: platform.id, label: platform.label }))}
            onChange={(next) => { setChoice({ platform: next, ref: "" }); setErrors((current) => ({ ...current, cameFrom: undefined })); setFormError(null); }} />
          {errors.cameFrom ? <span className="mvp-call-in__error" role="alert">{errors.cameFrom}</span> : null}
        </div> : null}
        {chosenPlatform && chosenPlatform.refs.length > 0 ? <div className="mvp-call-in__field">
          <span id={refLabelId}>{refLabel}<small> (optional)</small></span>
          <OptionPicker labelId={refLabelId} value={refId} placeholder={`Select the ${refLabel.toLowerCase()}`} scrollable
            options={[...chosenPlatform.refs.map((ref) => ({ value: ref.id, label: ref.name })), { value: REF_NOT_SURE, label: "Not sure" }]} dividerBeforeLast
            onChange={(next) => { setChoice((current) => ({ ...current, ref: next })); setFormError(null); }} />
        </div> : null}
        {origins ? <label className="mvp-call-in__field">
          <span>Call date<em aria-hidden="true"> *</em></span>
          <input type="date" required value={callDate} min={origins.minDate} max={origins.today} className="mvp-call-in__date"
            onKeyDown={onDateKeyDown} onPaste={(event) => event.preventDefault()} onClick={onDateClick}
            onChange={(event) => { if (event.target.value) setCallDate(event.target.value); setFormError(null); }} />
        </label> : null}
        {!origins && !originsError ? <p className="mvp-call-in__loading">Loading lead platforms...</p> : null}
        {originsError ? <div className="mvp-inline-error" role="alert">{originsError}</div> : null}
        {formError ? <div className="mvp-inline-error" role="alert">{formError}</div> : null}
        <div className="mvp-call-in__actions">
          <button type="button" className="mvp-call-in__cancel" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="mvp-date-popover__apply mvp-call-in__save" disabled={saving || !origins}>{saving ? "Saving..." : "Save lead"}</button>
        </div>
      </form>
    </div>
  </div>;
}

/** After saving a lead dated another day (same look as the app's other pop-ups, OK only). */
function SavedOnPopup({ day, onOk }: { day: string; onOk: () => void }) {
  const titleId = useId();
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { okRef.current?.focus(); }, []);
  return <div className="mvp-invite-popup__backdrop" onKeyDown={(event) => { if (event.key === "Escape") onOk(); }}>
    <div className="mvp-invite-popup" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <span className="mvp-invite-popup__icon" aria-hidden="true"><CircleCheck size={28} /></span>
      <h4 id={titleId}>Lead saved</h4>
      <p>It is dated <strong>{formatDay(day)}</strong>, so you will find it under that date in the list.</p>
      <button type="button" className="mvp-invite-popup__ok" ref={okRef} onClick={onOk}>OK</button>
    </div>
  </div>;
}
