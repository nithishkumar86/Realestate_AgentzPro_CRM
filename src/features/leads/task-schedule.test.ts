import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  addCalendarMonth,
  defaultDueChoice,
  nowInZone,
  presetDueDate,
  TIME_PATTERN,
  zonedDateTime,
} from "@/features/leads/task-schedule";

const IST = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

describe("zonedDateTime", () => {
  it("reads a date + time on the company clock (IST, no DST)", () => {
    expect(zonedDateTime("2026-10-08", "23:00", IST).toISOString()).toBe("2026-10-08T17:30:00.000Z");
    expect(zonedDateTime("2026-10-08", "00:00", IST).toISOString()).toBe("2026-10-07T18:30:00.000Z");
  });

  it("follows the zone's offset on each side of a DST change", () => {
    // New York: EDT (-4) in July, EST (-5) in December.
    expect(zonedDateTime("2026-07-01", "09:00", NEW_YORK).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedDateTime("2026-12-01", "09:00", NEW_YORK).toISOString()).toBe("2026-12-01T14:00:00.000Z");
    // The day clocks go back (1 Nov 2026): 09:00 is already EST.
    expect(zonedDateTime("2026-11-01", "09:00", NEW_YORK).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    // The day clocks go forward (8 Mar 2026): 09:00 is already EDT.
    expect(zonedDateTime("2026-03-08", "09:00", NEW_YORK).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("round-trips through nowInZone", () => {
    const instant = zonedDateTime("2026-02-28", "18:45", NEW_YORK);
    expect(nowInZone(NEW_YORK, instant)).toEqual({ date: "2026-02-28", hour: 18, minute: 45 });
  });
});

describe("nowInZone", () => {
  it("reports midnight as hour 0, never 24", () => {
    expect(nowInZone(IST, new Date("2026-10-07T18:30:00Z"))).toEqual({ date: "2026-10-08", hour: 0, minute: 0 });
  });
});

describe("presetDueDate", () => {
  it("counts each preset from the company's today", () => {
    expect(presetDueDate("today", "2026-10-07")).toBe("2026-10-07");
    expect(presetDueDate("tomorrow", "2026-10-07")).toBe("2026-10-08");
    expect(presetDueDate("3_days", "2026-10-07")).toBe("2026-10-10");
    expect(presetDueDate("1_week", "2026-10-07")).toBe("2026-10-14");
    expect(presetDueDate("1_month", "2026-10-07")).toBe("2026-11-07");
  });

  it("crosses month and year ends", () => {
    expect(presetDueDate("tomorrow", "2026-12-31")).toBe("2027-01-01");
    expect(presetDueDate("1_week", "2026-02-25")).toBe("2026-03-04");
    expect(presetDueDate("1_month", "2026-12-15")).toBe("2027-01-15");
  });

  it("clamps 1 Month to the last day of a shorter month", () => {
    expect(addCalendarMonth("2026-01-31")).toBe("2026-02-28");
    expect(addCalendarMonth("2028-01-31")).toBe("2028-02-29");
    expect(addCalendarMonth("2026-03-31")).toBe("2026-04-30");
    expect(addCalendarMonth("2026-08-31")).toBe("2026-09-30");
  });

  it("adds days without any timezone drift across DST", () => {
    expect(addCalendarDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("defaultDueChoice", () => {
  // 14:00:00 IST = 08:30:00Z
  it("is strictly the next full hour: 14:00:00 becomes 15:00", () => {
    expect(defaultDueChoice(IST, new Date("2026-10-07T08:30:00Z"))).toEqual({ preset: "today", time: "15:00" });
  });

  it("rounds up within the hour: 14:59 becomes 15:00", () => {
    expect(defaultDueChoice(IST, new Date("2026-10-07T09:29:00Z"))).toEqual({ preset: "today", time: "15:00" });
  });

  it("rolls over to Tomorrow 00:00 from 23:00", () => {
    // 23:00 and 23:30 IST
    expect(defaultDueChoice(IST, new Date("2026-10-07T17:30:00Z"))).toEqual({ preset: "tomorrow", time: "00:00" });
    expect(defaultDueChoice(IST, new Date("2026-10-07T18:00:00Z"))).toEqual({ preset: "tomorrow", time: "00:00" });
  });

  it("22:59 still defaults to Today 23:00", () => {
    expect(defaultDueChoice(IST, new Date("2026-10-07T17:29:00Z"))).toEqual({ preset: "today", time: "23:00" });
  });

  it("uses the company clock, not the server's", () => {
    // 08:30Z is 04:30 in New York (EDT).
    expect(defaultDueChoice(NEW_YORK, new Date("2026-10-07T08:30:00Z"))).toEqual({ preset: "today", time: "05:00" });
  });
});

describe("TIME_PATTERN", () => {
  it("accepts 24-hour HH:mm only", () => {
    expect(TIME_PATTERN.test("00:00")).toBe(true);
    expect(TIME_PATTERN.test("23:59")).toBe(true);
    expect(TIME_PATTERN.test("24:00")).toBe(false);
    expect(TIME_PATTERN.test("9:00")).toBe(false);
    expect(TIME_PATTERN.test("09:60")).toBe(false);
  });
});
