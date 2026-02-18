import { describe, expect, it } from "vitest";
import { calculateBackoff } from "../../src/utils/backoff";

describe("backoff", () => {
  it("respects max delay", () => {
    const delay = calculateBackoff({
      attempt: 10,
      baseDelayMs: 500,
      maxDelayMs: 1000,
      jitter: 0,
    });
    expect(delay).toBe(1000);
  });

  it("applies jitter within range", () => {
    const delay = calculateBackoff({
      attempt: 2,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      jitter: 0.5,
    });
    expect(delay).toBeGreaterThanOrEqual(250);
    expect(delay).toBeLessThanOrEqual(1500);
  });
});
