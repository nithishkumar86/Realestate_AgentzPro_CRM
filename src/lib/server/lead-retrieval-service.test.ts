import { describe, expect, it } from "vitest";
import { calculateRetryDelayMs } from "@/lib/server/lead-retrieval-service";

describe("calculateRetryDelayMs", () => {
  it("uses the approved 30-second base delay with a 30-minute cap", () => {
    expect(calculateRetryDelayMs(1, 1)).toBe(30_000);
    expect(calculateRetryDelayMs(2, 1)).toBe(60_000);
    expect(calculateRetryDelayMs(10, 1)).toBe(1_800_000);
  });

  it("keeps jitter within the current capped backoff window", () => {
    expect(calculateRetryDelayMs(3, 0)).toBe(0);
    expect(calculateRetryDelayMs(3, 0.5)).toBe(60_000);
  });
});
