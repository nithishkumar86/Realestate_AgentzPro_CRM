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

export const NAME_FIELD_KEYS = new Set(["full_name", "first_name", "last_name"]);
export const EMAIL_FIELD_KEYS = new Set(["email"]);
export const PHONE_FIELD_KEYS = new Set(["phone_number"]);

// Bounds on what one lead can send to the LLM, applied only AFTER redaction
// (so a cut can never split a name or phone number out of the PII scan).
// Real Meta forms sit far below these; they exist so one oversized lead
// cannot push a request past the model's context window and fail forever.
const MAX_FIELDS = 100;
const MAX_VALUES_PER_FIELD = 20;
const MAX_NAME_LENGTH = 200;
const MAX_VALUE_LENGTH = 1_000;

/**
 * Turns a lead's stored field_data into clean {name, values} entries,
 * whatever shape it arrived in. field_data is Meta's raw payload stored
 * as-is, and real leads carry entries that break the documented shape —
 * e.g. Meta's own `inbox_url` field arrives as {name} with no `values` at
 * all. Any entry without a usable name or a non-empty answer is skipped;
 * a lone string or number answer is accepted as a one-item list. Never
 * throws, so no lead's data can stop it from being classified.
 */
export function normalizeLeadFields(fieldData: unknown): LeadField[] {
  if (!Array.isArray(fieldData)) return [];
  const fields: LeadField[] = [];
  for (const field of fieldData) {
    if (!field || typeof field !== "object") continue;
    const { name, values } = field as { name?: unknown; values?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    const answered = (Array.isArray(values) ? values : [values]).flatMap((value) => {
      const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
      return text.trim() ? [text.trim()] : [];
    });
    if (answered.length) fields.push({ name: name.trim(), values: answered });
  }
  return fields;
}

/**
 * Replaces only the name/email/phone values before a lead's answers are
 * sent to the LLM. Every other field's key and value is passed through
 * unchanged apart from the size bounds above — no scrubbing beyond the
 * literal PII values themselves, since the classifier needs the full text
 * of every other answer to do its job.
 *
 * PII can also leak into an unrelated free-text answer (a lead typing their
 * own name or number into a "message" field), so every field is also
 * scanned for the PII values collected from the dedicated contact fields
 * and those occurrences are replaced too. Nothing else in that text moves.
 *
 * Accepts the raw stored field_data (any shape) and normalizes it first.
 */
export function redactLeadFieldsForAi(fieldData: unknown): LeadField[] {
  const fields = normalizeLeadFields(fieldData);
  const piiEntries = collectPiiEntries(fields);

  const redacted = fields.map((field) => {
    if (NAME_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[NAME]") };
    if (EMAIL_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[EMAIL]") };
    if (PHONE_FIELD_KEYS.has(field.name)) return { name: field.name, values: field.values.map(() => "[PHONE]") };
    return { name: field.name, values: field.values.map((value) => scrubPii(value, piiEntries)) };
  });

  return redacted.slice(0, MAX_FIELDS).map((field) => ({
    name: field.name.slice(0, MAX_NAME_LENGTH),
    values: field.values.slice(0, MAX_VALUES_PER_FIELD).map((value) => value.slice(0, MAX_VALUE_LENGTH)),
  }));
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
