import "server-only";

/**
 * Meta lead form answers, in the same shape lead_data.field_data stores
 * them: an array of one {name, values} entry per form question. The key
 * names checked below (full_name/first_name/last_name/email/phone_number)
 * are the exact set public.extract_meta_lead_contact_fields already treats
 * as contact fields — kept in sync with that function deliberately, since
 * it is the single source of truth for which Meta field names carry PII.
 */
export type LeadField = { name: string; values: string[] };

const NAME_FIELD_KEYS = new Set(["full_name", "first_name", "last_name"]);
const EMAIL_FIELD_KEYS = new Set(["email"]);
const PHONE_FIELD_KEYS = new Set(["phone_number"]);

/**
 * Replaces only the name/email/phone values before a lead's answers are
 * sent to the LLM. Every other field's key and value is passed through
 * completely unchanged — no dropping, no truncation, no scrubbing beyond
 * the literal PII values themselves, since the classifier needs the full
 * text of every other answer to do its job.
 *
 * PII can also leak into an unrelated free-text answer (a lead typing their
 * own name or number into a "message" field), so every field is also
 * scanned for the PII values collected from the dedicated contact fields
 * and those occurrences are replaced too. Nothing else in that text moves.
 */
export function redactLeadFieldsForAi(fieldData: LeadField[]): LeadField[] {
  const piiEntries = collectPiiEntries(fieldData);

  return fieldData.map((field) => {
    if (NAME_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[NAME]") };
    if (EMAIL_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[EMAIL]") };
    if (PHONE_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[PHONE]") };
    return { name: field.name, values: field.values.map((value) => scrubPii(value, piiEntries)) };
  });
}

type PiiEntry = { pattern: RegExp; placeholder: string };

function collectPiiEntries(fieldData: LeadField[]): PiiEntry[] {
  const entries: PiiEntry[] = [];
  for (const field of fieldData) {
    for (const raw of field.values) {
      const value = raw.trim();
      if (!value) continue;
      if (NAME_FIELD_KEYS.has(field.name)) entries.push({ pattern: new RegExp(`\\b${escapeRegExp(value)}\\b`, "gi"), placeholder: "[NAME]" });
      else if (EMAIL_FIELD_KEYS.has(field.name)) entries.push({ pattern: new RegExp(escapeRegExp(value), "gi"), placeholder: "[EMAIL]" });
      else if (PHONE_FIELD_KEYS.has(field.name)) entries.push({ pattern: buildPhonePattern(value), placeholder: "[PHONE]" });
    }
  }
  // Longest literal first, so "John Smith" is replaced whole before a later
  // "John" or "Smith" entry could match half of it.
  return entries.sort((a, b) => b.pattern.source.length - a.pattern.source.length);
}

function scrubPii(value: string, entries: PiiEntry[]): string {
  let result = value;
  for (const entry of entries) {
    result = result.replace(entry.pattern, entry.placeholder);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the phone's digits with optional spacing/punctuation and an optional +91/91 country prefix, so a differently formatted repeat of the same number elsewhere in the lead's answers is still caught. */
function buildPhonePattern(rawPhone: string): RegExp {
  const digits = rawPhone.replace(/\D/g, "").replace(/^91/, "");
  if (digits.length < 6) return new RegExp(escapeRegExp(rawPhone), "g");
  const spaced = digits.split("").map(escapeRegExp).join("[\\s.-]*");
  return new RegExp(`(?:\\+?91[\\s.-]*)?${spaced}`, "g");
}
