import type { DueDatePreset } from "@/features/leads/lead-options";

/**
 * Pure date/time helpers for task due times. A task is due at a wall-clock date + time in the company
 * timezone (tenants.timezone); the server and the drawer both convert with these, so they always agree.
 * Calendar dates are "YYYY-MM-DD" strings and times "HH:mm" (24-hour).
 */

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface WallClock { date: string; hour: number; minute: number; }

/** The wall-clock date and time of an instant in a timezone. */
export function nowInZone(timezone: string, now: Date = new Date()): WallClock {
  // hourCycle "h23" (not hour12:false) so midnight is 00, never 24.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")), minute: Number(part("minute")) };
}

/** The instant at which the wall clock in `timezone` shows `date` `time`. */
export function zonedDateTime(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Offset of the zone at an instant: the wall clock read as UTC, minus the instant. Two passes settle the
  // offset across a DST change; a time that does not exist (skipped by DST) lands just after the gap.
  const offsetAt = (instant: number) => {
    const local = nowInZone(timezone, new Date(instant));
    const [y, m, d] = local.date.split("-").map(Number);
    return Date.UTC(y, m - 1, d, local.hour, local.minute) - Math.floor(instant / 60_000) * 60_000;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/** A calendar date moved by whole days (UTC arithmetic, so no timezone or DST can shift it). */
export function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** One month later; a day the next month lacks becomes its last day (31 Jan → 28/29 Feb). */
export function addCalendarMonth(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** The due date a preset means, counted from `today` (the company's today). Custom has no date of its own. */
export function presetDueDate(preset: Exclude<DueDatePreset, "custom">, today: string): string {
  switch (preset) {
    case "today": return today;
    case "tomorrow": return addCalendarDays(today, 1);
    case "3_days": return addCalendarDays(today, 3);
    case "1_week": return addCalendarDays(today, 7);
    case "1_month": return addCalendarMonth(today);
  }
}

/**
 * The form's starting choice: today at the next full hour, strictly after now (14:00:00 → 15:00).
 * From 23:00 the next full hour is tomorrow's 00:00, so the preset becomes Tomorrow.
 */
export function defaultDueChoice(timezone: string, now: Date = new Date()): { preset: "today" | "tomorrow"; time: string } {
  const { hour } = nowInZone(timezone, now);
  if (hour >= 23) return { preset: "tomorrow", time: "00:00" };
  return { preset: "today", time: `${String(hour + 1).padStart(2, "0")}:00` };
}
