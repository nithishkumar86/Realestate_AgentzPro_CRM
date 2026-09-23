"use client";

import { useState, type InputHTMLAttributes } from "react";
import {
  sanitizePhoneInput,
  validateAccountField,
  type AccountDetailsErrors,
  type AccountDetailsField,
} from "@/lib/account-details";

type Values = Record<AccountDetailsField, string>;

const EMPTY_VALUES: Values = { fullName: "", phoneNumber: "", companyName: "", professionalRole: "" };

/**
 * Field state for the "Create account" forms. A field's error appears once the person leaves it
 * (or tries to submit), then updates live as they correct it, so nobody is shouted at mid-typing.
 */
export function useAccountDetailsForm(fields: readonly AccountDetailsField[]) {
  const [values, setValues] = useState<Values>(EMPTY_VALUES);
  const [errors, setErrors] = useState<AccountDetailsErrors>({});
  const [touched, setTouched] = useState<Partial<Record<AccountDetailsField, boolean>>>({});

  function setError(field: AccountDetailsField, message: string | null) {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  function change(field: AccountDetailsField, raw: string) {
    const value = field === "phoneNumber" ? sanitizePhoneInput(raw) : raw;
    setValues((current) => ({ ...current, [field]: value }));
    if (touched[field]) setError(field, validateAccountField(field, value));
  }

  function blur(field: AccountDetailsField) {
    setTouched((current) => ({ ...current, [field]: true }));
    setError(field, validateAccountField(field, values[field]));
  }

  /** Checks every field, shows every problem, and returns whether the form may be sent. */
  function validateAll(): boolean {
    const next: AccountDetailsErrors = {};
    for (const field of fields) {
      const message = validateAccountField(field, values[field]);
      if (message) next[field] = message;
    }
    setErrors(next);
    setTouched(Object.fromEntries(fields.map((field) => [field, true])) as Partial<Record<AccountDetailsField, boolean>>);
    return Object.keys(next).length === 0;
  }

  /** Puts the server's per-field messages under their fields; returns whether there were any. */
  function applyServerErrors(fieldErrors: unknown): boolean {
    if (!fieldErrors || typeof fieldErrors !== "object") return false;
    const next: AccountDetailsErrors = {};
    for (const field of fields) {
      const message = (fieldErrors as Record<string, unknown>)[field];
      if (typeof message === "string") next[field] = message;
    }
    if (Object.keys(next).length === 0) return false;
    setErrors(next);
    return true;
  }

  return { values, errors, change, blur, validateAll, applyServerErrors };
}

export interface AccountFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "value" | "onChange" | "onBlur"> {
  name: AccountDetailsField;
  label: string;
  value: string;
  error?: string;
  /** Fixed text shown inside the box before the value, e.g. the "+91" country code. */
  prefix?: string;
  onValueChange: (field: AccountDetailsField, value: string) => void;
  onFieldBlur: (field: AccountDetailsField) => void;
}

export function AccountField({ name, label, value, error, prefix, onValueChange, onFieldBlur, ...inputProps }: Readonly<AccountFieldProps>) {
  const errorId = `${name}-error`;
  const labelId = `${name}-label`;
  // Named by the label text alone, so a prefix such as "+91" never becomes part of the name.
  const input = (
    <input
      {...inputProps}
      name={name}
      value={value}
      required
      aria-labelledby={labelId}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      onChange={(event) => onValueChange(name, event.target.value)}
      onBlur={() => onFieldBlur(name)}
    />
  );
  // The message sits outside the <label> so it is announced as a description, not as the name.
  return (
    <div className="auth-field-group">
      <label className="auth-field">
        <span id={labelId}>{label}</span>
        {prefix ? (
          <span className="auth-field__affix" data-invalid={error ? "true" : undefined}>
            <span className="auth-field__prefix" aria-hidden="true">
              {prefix}
            </span>
            {input}
          </span>
        ) : (
          input
        )}
      </label>
      {error ? (
        <p className="auth-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
