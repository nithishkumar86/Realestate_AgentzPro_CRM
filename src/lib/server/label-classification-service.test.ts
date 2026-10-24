// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LabelClassificationService } from "@/lib/server/label-classification-service";
import { classifyLead } from "@/lib/server/label-ai-client";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => mocks }));
vi.mock("@/lib/server/label-ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/label-ai-client")>();
  return { ...actual, classifyLead: vi.fn() };
});

const claimed = { lead_id: "lead-1", tenant_id: "tenant-1", claim_token: "claim-1", retry_count: 1 };
const lead = { id: "lead-1", tenant_id: "tenant-1", field_data: [{ name: "budget", values: ["50 lakh"] }], ad_name: "Spring Sale", status: "New Lead" };

function leadQuery() {
  const builder = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: lead, error: null }) };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockReturnValue(leadQuery());
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_due_label_classification") return { data: null, error: null };
    return { data: true, error: null };
  });
});

describe("LabelClassificationService", () => {
  it("repairs the queue, claims one job, redacts the lead, classifies it, and completes it", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Hot", confidence: 0.9, reason: "Ready to buy" });

    await new LabelClassificationService().processDue(1);

    expect(mocks.rpc).toHaveBeenCalledWith("recover_label_classifications");
    expect(mocks.rpc).toHaveBeenCalledWith("backfill_missing_label_classifications");
    expect(classifyLead).toHaveBeenCalledWith({ redactedFields: lead.field_data, adName: "Spring Sale", status: "New Lead" });
    expect(mocks.rpc).toHaveBeenCalledWith("complete_label_classification", {
      p_lead_id: "lead-1", p_tenant_id: "tenant-1", p_claim_token: "claim-1",
      p_ai_label: "Hot", p_ai_confidence: 0.9, p_ai_reason: "Ready to buy",
    });
  });

  it("passes only redacted fields to the AI client, never the lead's raw PII columns", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { ...lead, field_data: [{ name: "full_name", values: ["Priya Sharma"] }, { name: "budget", values: ["50 lakh"] }] },
        error: null,
      }),
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Warm", confidence: 0.5, reason: "x" });

    await new LabelClassificationService().processDue(1);

    const call = vi.mocked(classifyLead).mock.calls[0][0];
    expect(JSON.stringify(call.redactedFields)).not.toContain("Priya Sharma");
    expect(JSON.stringify(call.redactedFields)).toContain("[NAME]");
  });

  it("records a bounded retry, never throwing, when the AI call fails", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockRejectedValue(new Error("gateway down"));

    await expect(new LabelClassificationService().processDue(1)).resolves.toBeUndefined();

    expect(mocks.rpc).toHaveBeenCalledWith("schedule_label_classification_retry", expect.objectContaining({
      p_lead_id: "lead-1", p_tenant_id: "tenant-1", p_claim_token: "claim-1", p_status: "retry_scheduled",
    }));
  });

  it("classifies and completes a real Meta ad lead whose inbox_url entry has no values (23 Oct regression)", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          ...lead,
          field_data: [
            { name: "what_is_your_budget?", values: ["₹70l_–_₹75l"] },
            { name: "when_are_you_planning_to_buy?", values: ["within_1_month"] },
            { name: "are_you_okay_with_an_under-construction_property?", values: ["yes"] },
            { name: "do_you_need_home_loan_assistance?", values: ["no"] },
            { name: "preferred_floor?", values: ["higher_floor"] },
            { name: "email", values: ["ravi.kumar@example.com"] },
            { name: "full_name", values: ["Ravi Kumar"] },
            { name: "phone_number", values: ["+919876543210"] },
            { name: "street_address", values: ["12 Anna Nagar"] },
            { name: "inbox_url" },
          ],
        },
        error: null,
      }),
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Hot", confidence: 0.8, reason: "Buying within a month" });

    await new LabelClassificationService().processDue(1);

    expect(vi.mocked(classifyLead).mock.calls[0][0].redactedFields).toHaveLength(9);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_label_classification", expect.objectContaining({ p_lead_id: "lead-1", p_ai_label: "Hot" }));
    expect(mocks.rpc).not.toHaveBeenCalledWith("schedule_label_classification_retry", expect.anything());
  });

  it("classifies a lead whose field_data is not an array at all instead of failing it", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { ...lead, field_data: null }, error: null }),
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Cold", confidence: 0.6, reason: "No answers" });

    await new LabelClassificationService().processDue(1);

    expect(classifyLead).toHaveBeenCalledWith({ redactedFields: [], adName: "Spring Sale", status: "New Lead" });
    expect(mocks.rpc).toHaveBeenCalledWith("complete_label_classification", expect.objectContaining({ p_ai_label: "Cold" }));
  });

  it("keeps working through other tenants' leads when one lead's retry cannot be recorded", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const otherTenant = { lead_id: "lead-2", tenant_id: "tenant-2", claim_token: "claim-2", retry_count: 1 };
    const queue = [claimed, otherTenant];
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: queue.shift() ?? null, error: null };
      if (name === "schedule_label_classification_retry") return { data: null, error: { message: "db hiccup" } };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead)
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce({ label: "Warm", confidence: 0.5, reason: "Some interest" });

    await expect(new LabelClassificationService().processDue(5)).resolves.toBeUndefined();

    expect(mocks.rpc).toHaveBeenCalledWith("complete_label_classification", expect.objectContaining({ p_lead_id: "lead-2", p_tenant_id: "tenant-2" }));
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ operation: "label_classification_worker", code: "RETRY_RECORD_FAILED", lead_id: "lead-1", tenant_id: "tenant-1" }));
    consoleError.mockRestore();
  });

  it("keeps working when recording a retry throws instead of returning an error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = [claimed, { ...claimed, lead_id: "lead-2", claim_token: "claim-2" }];
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: queue.shift() ?? null, error: null };
      if (name === "schedule_label_classification_retry") throw new Error("connection reset");
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockRejectedValue(new Error("gateway down"));

    await expect(new LabelClassificationService().processDue(5)).resolves.toBeUndefined();

    expect(classifyLead).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("logs which lead failed, with its error code but never the error text", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockRejectedValue(new Error("Priya Sharma 9876543210"));

    await new LabelClassificationService().processDue(1);

    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      operation: "label_classification_worker", code: "LEAD_CLASSIFICATION_FAILED",
      error_code: "LABEL_CLASSIFICATION_UNEXPECTED_FAILURE", lead_id: "lead-1", tenant_id: "tenant-1",
    }));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("Priya");
    consoleError.mockRestore();
  });

  it("stops without error when there is no due work", async () => {
    await expect(new LabelClassificationService().processDue(5)).resolves.toBeUndefined();
    expect(classifyLead).not.toHaveBeenCalled();
  });

  it("stops claiming new work once the sweep's time budget is spent", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_due_label_classification") return { data: claimed, error: null };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Hot", confidence: 0.9, reason: "Ready to buy" });
    // Each clock read advances 100s: start=0, then 100s (claim #1), 200s (claim #2), 300s (over budget).
    let clock = -100_000;
    const now = () => (clock += 100_000);

    await new LabelClassificationService().processDue(25, now);

    expect(mocks.rpc.mock.calls.filter(([name]) => name === "claim_due_label_classification")).toHaveLength(2);
    expect(classifyLead).toHaveBeenCalledTimes(2);
  });

  it("logs a failed queue repair and still processes due work", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let claims = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "recover_label_classifications") return { data: null, error: { message: "db down" } };
      if (name === "backfill_missing_label_classifications") return { data: null, error: { message: "db down" } };
      if (name === "claim_due_label_classification") return { data: claims++ === 0 ? claimed : null, error: null };
      return { data: true, error: null };
    });
    vi.mocked(classifyLead).mockResolvedValue({ label: "Cold", confidence: 0.8, reason: "No intent" });

    await expect(new LabelClassificationService().processDue(5)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ operation: "label_classification_worker", code: "QUEUE_RECOVERY_FAILED" }));
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ operation: "label_classification_worker", code: "QUEUE_BACKFILL_FAILED" }));
    expect(mocks.rpc).toHaveBeenCalledWith("complete_label_classification", expect.objectContaining({ p_ai_label: "Cold" }));
    consoleError.mockRestore();
  });
});
