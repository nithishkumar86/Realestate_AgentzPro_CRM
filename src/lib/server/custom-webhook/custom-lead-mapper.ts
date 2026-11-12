import "server-only";

import type { LeadField } from "@/lib/server/lead-redaction";

/**
 * The lead a company's own tools POST to its custom webhook URL, 3sigma-style:
 *
 *   { "name": "John Doe", "phone": "9876543210", "email": "john@example.com", "source": "Landing Page",
 *     "lead_id": "optional, the tool's own id", "...": "any other field" }
 *
 * sent as JSON or as an ordinary form post (application/x-www-form-urlencoded). One lead per request.
 *
 * Answers are stored in Meta's field_data shape ([{ name, values }]) and the contact fields under Meta's keys
 * (full_name, first_name, last_name, email, phone_number), so public.extract_meta_lead_contact_fields fills
 * lead_name / lead_email / lead_phone, and search, phone normalising, the AI-label redaction and the drawer all work
 * on a webhook lead exactly as on a Meta lead. `source` and `lead_id` are kept out of field_data: they go to
 * lead_data.custom_source_name and custom_lead_ref.
 */
export const MAX_CUSTOM_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_CUSTOM_LEAD_FIELDS = 100;
export const MAX_CUSTOM_FIELD_KEY_LENGTH = 100;
/** lead_id and source; the same cap as lead_data_custom_webhook_fields_check. */
export const MAX_CUSTOM_REF_LENGTH = 200;

export interface MappedCustomLead {
  /** The sending tool's own lead id; a repeat of it is never saved twice. */
  leadRef: string | null;
  /** What the tool says the lead came from ("Landing Page"); shown in the Ad Name column. */
  sourceName: string | null;
  fieldData: LeadField[];
  /** The parsed body, stored as lead_data.raw_lead_payload. It holds no secret: the URL is the secret. */
  rawPayload: Record<string, unknown>;
}

/** A body that can never become a lead. `status` is what the route answers: 400, or 415 for an unsupported format. */
export class CustomLeadPayloadError extends Error {
  public readonly status: 400 | 415;

  public constructor(message: string, status: 400 | 415 = 400) {
    super(message);
    this.name = "CustomLeadPayloadError";
    this.status = status;
  }
}

// For each contact key, the field names that may fill it, best first (compared case-insensitively, with spaces and
// hyphens read as "_"). Only the best one present with an answer takes the contact key; any other keeps its own name.
const CONTACT_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["full_name", ["name", "full_name", "fullname"]],
  ["first_name", ["first_name", "firstname"]],
  ["last_name", ["last_name", "lastname"]],
  ["email", ["email", "email_address"]],
  ["phone_number", ["phone", "phone_number", "mobile", "mobile_number"]],
];
const CONTACT_KEYS = new Set(CONTACT_ALIASES.map(([key]) => key));
const SOURCE_KEY = "source";
const LEAD_REF_KEY = "lead_id";

type Entry = { key: string; normalized: string; raw: unknown; values: string[] };

/** Parses and validates the raw request body. Throws CustomLeadPayloadError for anything unusable. */
export function mapCustomWebhookLead(contentType: string | null, rawBody: string): MappedCustomLead {
  const payload = parseBody(contentType, rawBody);
  const entries = Object.entries(payload).flatMap(([rawKey, raw]): Entry[] => {
    const key = rawKey.trim();
    if (!key) return [];
    if (key.length > MAX_CUSTOM_FIELD_KEY_LENGTH) throw new CustomLeadPayloadError(`Field names must be ${MAX_CUSTOM_FIELD_KEY_LENGTH} characters or fewer.`);
    return [{ key, normalized: normalizeKey(key), raw, values: toValues(raw, rawKey, rawBody) }];
  });
  if (entries.length > MAX_CUSTOM_LEAD_FIELDS) throw new CustomLeadPayloadError(`Send ${MAX_CUSTOM_LEAD_FIELDS} fields or fewer.`);

  const sourceEntry = entries.find((entry) => entry.normalized === SOURCE_KEY);
  const refEntry = entries.find((entry) => entry.normalized === LEAD_REF_KEY);
  const sourceName = singleText(sourceEntry, SOURCE_KEY);
  const leadRef = singleText(refEntry, LEAD_REF_KEY);

  // The winning entry for each contact key: the best alias present that has an answer.
  const winners = new Map<Entry, string>();
  for (const [contactKey, aliases] of CONTACT_ALIASES) {
    for (const alias of aliases) {
      const winner = entries.find((entry) => entry.normalized === alias && entry.values.length > 0 && !winners.has(entry));
      if (winner) { winners.set(winner, contactKey); break; }
    }
  }

  const fieldData: LeadField[] = [];
  for (const entry of entries) {
    if (entry === sourceEntry || entry === refEntry || entry.values.length === 0) continue;
    const contactKey = winners.get(entry);
    // A field that did not win keeps its own name, unless that name is itself a contact key: it would then be read as
    // the lead's name / email / phone, so it is prefixed (as google-lead-mapper.ts does).
    const name = contactKey ?? (CONTACT_KEYS.has(entry.key) ? `question_${entry.key}` : entry.key);
    fieldData.push({ name, values: entry.values });
  }

  const has = (key: string) => fieldData.some((field) => field.name === key && field.values.some((value) => value.trim()));
  if (!has("phone_number") && !has("email")) throw new CustomLeadPayloadError("Send phone or email.");

  return { leadRef, sourceName, fieldData, rawPayload: payload };
}

function parseBody(contentType: string | null, rawBody: string): Record<string, unknown> {
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") return parseForm(rawBody);
  // A missing or text/plain type is read as JSON: some tools post JSON without saying so.
  if (mediaType === "" || mediaType === "text/plain" || mediaType === "application/json" || mediaType.endsWith("+json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.replace(/^﻿/, ""));
    } catch {
      throw new CustomLeadPayloadError("Send the lead as a JSON object.");
    }
    if (Array.isArray(parsed)) throw new CustomLeadPayloadError("Send one lead per request.");
    if (!parsed || typeof parsed !== "object") throw new CustomLeadPayloadError("Send the lead as a JSON object.");
    return parsed as Record<string, unknown>;
  }
  throw new CustomLeadPayloadError("Send JSON or form data.", 415);
}

/** A form post: a repeated field becomes a list of answers. */
function parseForm(rawBody: string): Record<string, unknown> {
  // No prototype, so a field named "__proto__" is stored as a field like any other.
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (!Object.hasOwn(result, key)) result[key] = value;
    else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), value];
  }
  return result;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Every answer as text: numbers and true/false as written, a list as several answers, a nested object as JSON text. */
function toValues(raw: unknown, rawKey: string, rawBody: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap((item) => (item === null || item === undefined ? [] : [scalarText(item)])).filter(Boolean);
  if (typeof raw === "number" && Number.isInteger(raw) && !Number.isSafeInteger(raw)) return [unsafeIntegerText(raw, rawKey, rawBody)];
  const text = scalarText(raw);
  return text ? [text] : [];
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * JSON.parse loses digits past 2^53 (a long phone number sent as a number). The digits are read again from the raw
 * text; if that is not possible the parsed number is kept.
 */
function unsafeIntegerText(value: number, rawKey: string, rawBody: string): string {
  const escapedKey = JSON.stringify(rawKey).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?=\\s*[,}])`).exec(rawBody)?.[1] ?? String(value);
}

/** source / lead_id: one short text. A list or object is refused rather than guessed at. */
function singleText(entry: Entry | undefined, field: string): string | null {
  if (!entry || entry.values.length === 0) return null;
  if (entry.values.length > 1 || (entry.raw !== null && typeof entry.raw === "object")) {
    throw new CustomLeadPayloadError(`${field} must be a single value.`);
  }
  const text = entry.values[0];
  if (text.length > MAX_CUSTOM_REF_LENGTH) throw new CustomLeadPayloadError(`${field} must be ${MAX_CUSTOM_REF_LENGTH} characters or fewer.`);
  return text;
}
