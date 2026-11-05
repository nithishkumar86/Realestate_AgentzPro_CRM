import { describe, expect, it } from "vitest";
import { onlyOlderLeadsChanged, readLeadChange, readNewestSavedUs, timestampToMicros } from "@/lib/lead-change-signal";

// 2026-11-05T13:38:06.123456Z, as the live database computed it for this instant.
const US = 1793885886123456;
const update = (newestSavedUs: unknown) => new CustomEvent("x", { detail: { newestSavedUs } });

describe("timestampToMicros", () => {
  it("keeps every microsecond, whatever the database trimmed", () => {
    expect(timestampToMicros("2026-11-05T13:38:06.123456+00:00")).toBe(US);
    expect(timestampToMicros("2026-11-05T13:38:06.12+00:00")).toBe(US - 3456);
    expect(timestampToMicros("2026-11-05T13:38:06+00:00")).toBe(US - 123456);
    expect(timestampToMicros("2026-11-05T13:38:06.000001Z")).toBe(US - 123455);
  });

  it("reads every offset form and a space separator", () => {
    expect(timestampToMicros("2026-11-05T13:38:06.123456Z")).toBe(US);
    expect(timestampToMicros("2026-11-05 13:38:06.123456+00")).toBe(US);
    expect(timestampToMicros("2026-11-05T19:08:06.123456+05:30")).toBe(US);
    expect(timestampToMicros("2026-11-05T19:08:06.123456+0530")).toBe(US);
    expect(timestampToMicros("2026-11-05T08:38:06.123456-05")).toBe(US);
  });

  it("refuses anything the database does not write", () => {
    for (const value of ["", "2026-11-05", "2026-11-05T13:38:06", "2026-11-05T13:38:06.1234567Z", "2026-13-45T13:38:06Z", "not a date", "2026-11-05T13:38:06.123456+00:00 "]) {
      expect(timestampToMicros(value)).toBeNull();
    }
  });
});

describe("readNewestSavedUs", () => {
  it("accepts only a digit string that is an exact whole number", () => {
    expect(readNewestSavedUs(String(US))).toBe(String(US));
    for (const value of [US, "", "-1", "1.5", "1e15", " 1", "99999999999999999", "9007199254740993", null, undefined, {}]) {
      expect(readNewestSavedUs(value)).toBeUndefined();
    }
  });
});

describe("readLeadChange", () => {
  it("returns the newest saved time of an update only", () => {
    expect(readLeadChange(JSON.stringify({ kind: "update", newestSavedUs: String(US) }))).toEqual({ newestSavedUs: US });
  });

  it("returns null (check) for a plain change, another kind or anything unreadable", () => {
    for (const data of ["{}", JSON.stringify({ kind: "insert", newestSavedUs: String(US) }), JSON.stringify({ kind: "update" }), JSON.stringify({ kind: "update", newestSavedUs: US }), JSON.stringify({ kind: "update", newestSavedUs: "12x" }), "null", "[]", "not json", undefined, 42]) {
      expect(readLeadChange(data)).toBeNull();
    }
  });
});

describe("onlyOlderLeadsChanged", () => {
  const cursor = "2026-11-05T13:38:06.123456+00:00";

  it("skips an update whose newest lead was saved at or before the cursor", () => {
    expect(onlyOlderLeadsChanged(update(US), cursor)).toBe(true);
    expect(onlyOlderLeadsChanged(update(US - 1), cursor)).toBe(true);
    expect(onlyOlderLeadsChanged(update(US - 86_400_000_000), cursor)).toBe(true);
  });

  it("checks an update to a lead saved after the cursor, even one microsecond after", () => {
    expect(onlyOlderLeadsChanged(update(US + 1), cursor)).toBe(false);
    expect(onlyOlderLeadsChanged(update(US + 1), "2026-11-05T13:38:06.123456Z")).toBe(false);
  });

  it("checks whenever anything is unknown", () => {
    expect(onlyOlderLeadsChanged(new Event("x"), cursor)).toBe(false);
    expect(onlyOlderLeadsChanged(new CustomEvent("x", { detail: null }), cursor)).toBe(false);
    expect(onlyOlderLeadsChanged(update(String(US)), cursor)).toBe(false);
    expect(onlyOlderLeadsChanged(update(1.5), cursor)).toBe(false);
    expect(onlyOlderLeadsChanged(update(US), null)).toBe(false);
    expect(onlyOlderLeadsChanged(update(US), "garbage")).toBe(false);
  });
});
