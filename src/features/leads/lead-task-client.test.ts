import { describe, expect, it } from "vitest";
import { describeRepeat, formatTaskDue } from "@/features/leads/lead-task-client";

describe("formatTaskDue", () => {
  it("shows the due time on the company clock", () => {
    expect(formatTaskDue("2026-10-08T17:30:00+00:00", "Asia/Kolkata")).toBe("Thu 08 Oct 2026, 11:00 PM");
    expect(formatTaskDue("2026-10-12T04:30:00Z", "Asia/Kolkata")).toBe("Mon 12 Oct 2026, 10:00 AM");
  });

  it("shows midnight as 12:00 AM of the new day", () => {
    expect(formatTaskDue("2026-10-07T18:30:00Z", "Asia/Kolkata")).toBe("Thu 08 Oct 2026, 12:00 AM");
  });

  it("follows the timezone, not the browser", () => {
    expect(formatTaskDue("2026-10-08T17:30:00Z", "America/New_York")).toBe("Thu 08 Oct 2026, 1:30 PM");
  });
});

describe("describeRepeat", () => {
  it("names the repeat unit, and nothing for Don't Repeat", () => {
    expect(describeRepeat("daily")).toBe("Repeats every day");
    expect(describeRepeat("weekly")).toBe("Repeats every week");
    expect(describeRepeat("monthly")).toBe("Repeats every month");
    expect(describeRepeat("yearly")).toBe("Repeats every year");
    expect(describeRepeat("none")).toBeNull();
  });
});
