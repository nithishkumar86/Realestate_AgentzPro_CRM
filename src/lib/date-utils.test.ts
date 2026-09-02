import { describe, expect, it } from "vitest";
import { getCustomRange, getTodayRange, getWeekRange, toReadableLabel } from "@/lib/date-utils";

describe("date utilities", () => {
  it("creates an inclusive Asia/Kolkata today range", () => {
    const range = getTodayRange(new Date("2026-09-01T10:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-01T18:29:59.999Z");
  });

  it("uses Monday through Sunday for week ranges", () => {
    const range = getWeekRange(new Date("2026-09-03T04:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-08-30T18:30:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-06T18:29:59.999Z");
  });

  it("rejects inverted custom ranges", () => {
    expect(() => getCustomRange("2026-09-05", "2026-09-01")).toThrow("Start date must be before the end date.");
  });

  it("converts dynamic Meta field keys into readable labels", () => {
    expect(toReadableLabel("preferred_location")).toBe("Preferred Location");
    expect(toReadableLabel("disclaimerConsent")).toBe("Disclaimer Consent");
  });
});
