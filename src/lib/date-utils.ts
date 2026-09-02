export const PRODUCT_TIME_ZONE = "Asia/Kolkata";
const KOLKATA_OFFSET_MINUTES = 330;

export interface DateRange {
  start: Date;
  end: Date;
}

function getDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PRODUCT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function toKolkataBoundary(year: number, month: number, day: number, endOfDay = false): Date {
  const localMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );

  return new Date(localMilliseconds - KOLKATA_OFFSET_MINUTES * 60 * 1000);
}

export function getTodayRange(now = new Date()): DateRange {
  const { year, month, day } = getDateParts(now);
  return { start: toKolkataBoundary(year, month, day), end: toKolkataBoundary(year, month, day, true) };
}

export function getMonthRange(now = new Date()): DateRange {
  const { year, month } = getDateParts(now);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: toKolkataBoundary(year, month, 1), end: toKolkataBoundary(year, month, lastDay, true) };
}

export function getWeekRange(now = new Date()): DateRange {
  const { year, month, day } = getDateParts(now);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const weekday = calendarDate.getUTCDay() === 0 ? 7 : calendarDate.getUTCDay();
  calendarDate.setUTCDate(calendarDate.getUTCDate() - (weekday - 1));

  const startYear = calendarDate.getUTCFullYear();
  const startMonth = calendarDate.getUTCMonth() + 1;
  const startDay = calendarDate.getUTCDate();
  const endDate = new Date(calendarDate);
  endDate.setUTCDate(endDate.getUTCDate() + 6);

  return {
    start: toKolkataBoundary(startYear, startMonth, startDay),
    end: toKolkataBoundary(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate(), true),
  };
}

export function getCustomRange(startDate: string, endDate: string): DateRange {
  if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate)) {
    throw new Error("Select a valid start and end date.");
  }

  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const start = toKolkataBoundary(startYear, startMonth, startDay);
  const end = toKolkataBoundary(endYear, endMonth, endDay, true);

  if (start > end) {
    throw new Error("Start date must be before the end date.");
  }

  return {
    start,
    end,
  };
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: PRODUCT_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function toReadableLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatCalendarDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PRODUCT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

export function formatRangeForFilename(range: DateRange | null): string {
  if (!range) {
    const today = formatCalendarDate(new Date());
    return `leads_all_${today}`;
  }

  return `leads_${formatCalendarDate(range.start)}_to_${formatCalendarDate(range.end)}`;
}
