// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveDateRange } from "@/lib/server/lead-query-service";
import { isValidDateRange } from "@/features/leads/use-lead-filters";

vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => { throw new Error("not used"); } }));

function serverAccepts(from: string, to: string): boolean {
  try { resolveDateRange({ dateFrom: from || undefined, dateTo: to || undefined }, "Asia/Kolkata"); return true; }
  catch { return false; }
}

/**
 * The Date popover's Apply button is enabled by isValidDateRange. If it ever allowed a range the query service
 * rejects, the user would see "Select a valid inclusive date range." — so the two must agree on every case.
 */
describe("isValidDateRange", () => {
  const cases: Array<[string, string, boolean]> = [
    ["2026-10-20", "2026-10-25", true],
    ["2026-10-25", "2026-10-25", true],
    ["2025-12-31", "2026-01-01", true],
    ["2026-10-25", "2026-10-20", false],
    ["20262-10-20", "2026-10-25", false],
    ["2026-10-20", "202610-25", false],
    ["2026-10-20", "", false],
    ["", "2026-10-25", false],
    ["20/10/2026", "25/10/2026", false],
  ];

  it.each(cases)("from %s to %s → %s, exactly as the server decides", (from, to, expected) => {
    expect(isValidDateRange(from, to)).toBe(expected);
    expect(serverAccepts(from, to)).toBe(expected);
  });
});
