import { describe, expect, it } from "vitest";
import { getLeadCounts, getLeads } from "@/services/crm-data-service";

describe("crm data service", () => {
  it("returns no fabricated lead data before Phase 2", async () => {
    await expect(getLeadCounts()).resolves.toEqual({ today: 0, month: 0, all: 0 });
    await expect(getLeads({ view: "all", search: "", dateFilter: null, customStartDate: null, customEndDate: null, page: 1, pageSize: 10 })).resolves.toMatchObject({ items: [], total: 0 });
  });
});
