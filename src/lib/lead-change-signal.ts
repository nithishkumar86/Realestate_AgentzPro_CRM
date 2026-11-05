/**
 * The live "lead changed" signal, as /leads uses it to decide whether a new-leads check is needed.
 *
 * notify_lead_update (migration 20261105150000) adds, per company, the newest created_at among the leads an update
 * changed, as whole microseconds since 1970 in a digit string. A digit string, not a JSON number, so no step on the way
 * can turn it into a rounded float. The new-leads count only includes leads saved after the table's cursor, so an
 * update whose newest lead is not after the cursor can never change it. Every other signal (a new lead, a delete, a
 * reconnect, an old database function, anything unreadable) carries no value and always gets a check.
 */

/** Microseconds since 1970 fit in a JS number exactly until the year 2255 (Number.MAX_SAFE_INTEGER). */
const DIGITS = /^\d{1,16}$/;

/** Reads `newest_saved_us`; undefined unless it is a digit string that is an exact whole number. */
export function readNewestSavedUs(value: unknown): string | undefined {
  return typeof value === "string" && DIGITS.test(value) && Number.isSafeInteger(Number(value)) ? value : undefined;
}

/** What the shell hands /leads with the leads-changed window event: only an update's newest saved lead. */
export interface LeadChangeDetail { newestSavedUs: number }

/** Reads the stream's "change" event data; null (= check) unless it is an update with a valid newest saved time. */
export function readLeadChange(data: unknown): LeadChangeDetail | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  const { kind, newestSavedUs } = (parsed && typeof parsed === "object" ? parsed : {}) as { kind?: unknown; newestSavedUs?: unknown };
  const value = readNewestSavedUs(newestSavedUs);
  return kind === "update" && value !== undefined ? { newestSavedUs: Number(value) } : null;
}

// Postgres timestamptz as PostgREST / JSON writes it: fraction trimmed of trailing zeros (or left out), offset as Z,
// ±HH, ±HHMM or ±HH:MM.
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A database timestamp as whole microseconds since 1970, exactly (a JS Date keeps only milliseconds). Null if it is
 * not in a form the database writes.
 */
export function timestampToMicros(value: string): number | null {
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, time, fraction = "", zone] = match;
  const offset = zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const wholeSeconds = Date.parse(`${date}T${time}${offset}`);
  if (!Number.isFinite(wholeSeconds)) return null;
  const micros = wholeSeconds * 1000 + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * True only when this event is an update whose newest changed lead was saved at or before `cursor` (the table's last
 * load): such a change can never alter the new-leads count, so no check is needed. Anything unknown answers false.
 */
export function onlyOlderLeadsChanged(event: Event, cursor: string | null): boolean {
  const detail = (event as CustomEvent<unknown>).detail as Partial<LeadChangeDetail> | null | undefined;
  if (!detail || typeof detail.newestSavedUs !== "number" || !Number.isSafeInteger(detail.newestSavedUs) || cursor === null) return false;
  const cursorUs = timestampToMicros(cursor);
  return cursorUs !== null && detail.newestSavedUs <= cursorUs;
}
