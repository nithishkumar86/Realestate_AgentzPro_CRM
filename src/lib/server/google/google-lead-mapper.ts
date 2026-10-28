import "server-only";

import { z } from "zod";
import type { LeadField } from "@/lib/server/lead-redaction";

/**
 * The lead Google POSTs to a lead-form webhook (WebhookLead,
 * https://developers.google.com/google-ads/webhook/docs/implementation). Only lead_id and google_key are
 * required: every other field may be absent, and Google may add new ones, which are ignored rather than
 * rejected ("ignore unrecognized fields"). A lead missing its campaign or form id is still a lead.
 *
 * No per-field length caps: Google never resends a lead answered with 4XX, so a long free-text answer must
 * never be a reason to refuse it. The route's 64 KB body limit already bounds the size.
 */
const idValue = z.union([z.string(), z.number()]).optional().nullable();

const webhookLeadSchema = z.object({
  lead_id: z.union([z.string().trim().min(1), z.number()]),
  google_key: z.string(),
  user_column_data: z.array(z.object({
    column_id: z.string().optional().nullable(),
    column_name: z.string().optional().nullable(),
    string_value: z.string().optional().nullable(),
  }).loose()).optional().nullable(),
  form_id: idValue,
  campaign_id: idValue,
  adgroup_id: idValue,
  creative_id: idValue,
  asset_group_id: idValue,
  gcl_id: z.string().optional().nullable(),
  is_test: z.boolean().optional().nullable(),
  lead_submit_time: z.string().optional().nullable(),
}).loose();

export type GoogleWebhookLead = z.infer<typeof webhookLeadSchema>;

export interface MappedGoogleLead {
  googleKey: string;
  googleLeadId: string;
  isTest: boolean;
  formId: string | null;
  campaignId: string | null;
  adgroupId: string | null;
  creativeId: string | null;
  assetGroupId: string | null;
  gclId: string | null;
  submitTime: string | null;
  fieldData: LeadField[];
  /** The whole payload minus google_key, stored as lead_data.raw_lead_payload. */
  rawPayload: Record<string, unknown>;
}

export class GoogleLeadPayloadError extends Error {
  public constructor() {
    super("The Google lead payload is invalid.");
    this.name = "GoogleLeadPayloadError";
  }
}

/** Parses and validates the raw request body. Throws GoogleLeadPayloadError for anything unusable. */
export function mapGoogleWebhookLead(rawBody: string): MappedGoogleLead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new GoogleLeadPayloadError();
  }
  const result = webhookLeadSchema.safeParse(parsed);
  if (!result.success) throw new GoogleLeadPayloadError();
  const lead = result.data;

  const rawPayload: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rawPayload.google_key;

  return {
    googleKey: lead.google_key,
    googleLeadId: String(lead.lead_id).trim(),
    isTest: lead.is_test === true,
    formId: readId(lead.form_id, "form_id", rawBody),
    campaignId: readId(lead.campaign_id, "campaign_id", rawBody),
    adgroupId: readId(lead.adgroup_id, "adgroup_id", rawBody),
    creativeId: readId(lead.creative_id, "creative_id", rawBody),
    assetGroupId: readId(lead.asset_group_id, "asset_group_id", rawBody),
    gclId: lead.gcl_id?.trim() || null,
    submitTime: readSubmitTime(lead.lead_submit_time),
    fieldData: mapUserColumnData(lead.user_column_data ?? []),
    rawPayload,
  };
}

/**
 * Google's int64 ids, as digit strings. JSON.parse loses precision past 2^53, so an unsafe number is read
 * again from the raw text. Anything that is not a plain run of digits is treated as absent.
 */
function readId(value: string | number | null | undefined, key: string, rawBody: string): string | null {
  if (value === null || value === undefined) return null;
  let text = typeof value === "number" ? String(value) : value.trim();
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    text = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(rawBody)?.[1] ?? "";
  }
  return /^\d{1,30}$/.test(text) ? text : null;
}

function readSubmitTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

// Google's contact column_ids, stored under the exact keys public.extract_meta_lead_contact_fields and
// lead-redaction.ts treat as contact fields, so a Google lead's name, email and phone fill lead_name /
// lead_email / lead_phone and are masked before AI labelling, exactly like a Meta lead's.
// For each contact key, the column_ids that may fill it, best first. Only the best one present on the form
// takes the contact key; any other keeps its own key (the owner's choice: shown in the lead, not masked,
// the same as Meta's work_email / work_phone_number today).
const CONTACT_PRIORITY: Record<string, string[]> = {
  full_name: ["FULL_NAME"],
  first_name: ["FIRST_NAME"],
  last_name: ["LAST_NAME"],
  email: ["EMAIL", "WORK_EMAIL"],
  phone_number: ["PHONE_NUMBER", "PHONE_NUMBER_VERIFIED", "WORK_PHONE"],
};
const CONTACT_COLUMNS: Record<string, { key: string; ownKey?: string }> = {
  FULL_NAME: { key: "full_name" },
  FIRST_NAME: { key: "first_name" },
  LAST_NAME: { key: "last_name" },
  EMAIL: { key: "email" },
  WORK_EMAIL: { key: "email", ownKey: "work_email" },
  PHONE_NUMBER: { key: "phone_number" },
  PHONE_NUMBER_VERIFIED: { key: "phone_number", ownKey: "phone_number_verified" },
  WORK_PHONE: { key: "phone_number", ownKey: "work_phone" },
};
const CONTACT_KEYS = new Set(Object.keys(CONTACT_PRIORITY));

type UserColumn = { column_id?: string | null; column_name?: string | null; string_value?: string | null };

/**
 * user_column_data -> lead_data.field_data in Meta's shape ([{ name, values: [answer] }]), in form order.
 * At most one entry per contact key: extract_meta_lead_contact_fields picks max() when a key repeats, which
 * would make lead_phone (and phone search / the call-in duplicate check) depend on string order.
 */
export function mapUserColumnData(columns: UserColumn[]): LeadField[] {
  const columnIds = new Set(columns.map((column) => normalizeColumnId(column.column_id)));
  const winners = new Map(Object.entries(CONTACT_PRIORITY).flatMap(([key, ids]) => {
    const winner = ids.find((id) => columnIds.has(id));
    return winner ? [[key, winner] as const] : [];
  }));
  const usedContactKeys = new Set<string>();
  const contactValues = new Map<string, string>();
  const fields: LeadField[] = [];

  for (const column of columns) {
    const columnId = normalizeColumnId(column.column_id);
    const value = column.string_value ?? "";
    const contact = CONTACT_COLUMNS[columnId];
    let name: string | null;
    if (contact) {
      if (winners.get(contact.key) === columnId && !usedContactKeys.has(contact.key)) {
        name = contact.key;
        usedContactKeys.add(contact.key);
        contactValues.set(contact.key, value);
      } else if (!contact.ownKey) {
        continue; // a repeat of the same column: the first one already holds the contact key
      } else if (columnId === "PHONE_NUMBER_VERIFIED" && digitsOf(value) === digitsOf(contactValues.get("phone_number") ?? findValue(columns, winners.get("phone_number")))) {
        continue; // the verified number repeats the form's phone number
      } else {
        name = contact.ownKey;
      }
    } else {
      name = questionKey(column, columnId);
    }
    if (name) fields.push({ name, values: [value] });
  }
  return fields;
}

function normalizeColumnId(columnId: string | null | undefined): string {
  return (columnId ?? "").trim().toUpperCase();
}

function findValue(columns: UserColumn[], columnId: string | undefined): string {
  return columns.find((column) => normalizeColumnId(column.column_id) === columnId)?.string_value ?? "";
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Any other answer: the question text Google sends (column_name, deprecated but still sent for custom
 * questions), else the column_id lowercased (PROPERTY_TYPE -> property_type). A custom question whose text
 * happens to be "email" etc. is prefixed so it can never be mistaken for the form's real contact field.
 */
function questionKey(column: UserColumn, columnId: string): string | null {
  const name = (column.column_name ?? "").trim() || columnId.toLowerCase();
  if (!name) return null;
  return CONTACT_KEYS.has(name.toLowerCase()) ? `question_${name}` : name;
}
