import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clampIntervalSeconds,
  computeNextIntervalSeconds,
  RateLimitTracker,
  readRateLimitState,
  resolveRateLimitStatePath,
  writeRateLimitState,
  type AdaptivePollingOptions,
} from "../../src/utils/rateLimit";

const options = (
  overrides: Partial<AdaptivePollingOptions> = {},
): AdaptivePollingOptions => ({
  enabled: true,
  minIntervalSeconds: 300,
  maxIntervalSeconds: 3600,
  growthFactor: 2,
  decayFactor: 0.8,
  respectRetryAfter: true,
  ...overrides,
});

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-ratelimit-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("RateLimitTracker", () => {
  it("keeps the newest Retry-After deadline and counts 429s per cycle", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit({
      path: "/invoices/exports",
      retryAfterMs: 720_000,
      at: 1_000,
    });
    tracker.recordRateLimit({
      path: "/invoices/exports",
      retryAfterMs: 60_000,
      at: 2_000,
    });

    expect(tracker.getRateLimitCount()).toBe(2);
    expect(tracker.getRetryAfterDeadline()).toBe(721_000);
    expect(tracker.msUntilRetryAfter(721_000 - 5_000)).toBe(5_000);
    expect(tracker.msUntilRetryAfter(800_000)).toBe(0);
  });

  it("counts consecutive clean cycles and resets them on a rate limit", () => {
    const tracker = new RateLimitTracker();

    expect(tracker.completeCycle()).toEqual({
      hadRateLimit: false,
      rateLimitCount: 0,
      cleanCycles: 1,
    });
    tracker.recordSuccess();
    expect(tracker.completeCycle()).toEqual({
      hadRateLimit: false,
      rateLimitCount: 0,
      cleanCycles: 2,
    });

    tracker.recordRateLimit({ path: "/p", retryAfterMs: 1_000, at: 0 });
    expect(tracker.completeCycle()).toEqual({
      hadRateLimit: true,
      rateLimitCount: 1,
      cleanCycles: 0,
    });
    // Counters are per-cycle; the deadline survives the cycle boundary.
    expect(tracker.getRateLimitCount()).toBe(0);
    expect(tracker.getRetryAfterDeadline()).toBe(1_000);
  });

  it("restores only a newer deadline after a restart", () => {
    const tracker = new RateLimitTracker();
    tracker.restoreRetryAfterDeadline(5_000);
    expect(tracker.getRetryAfterDeadline()).toBe(5_000);

    tracker.restoreRetryAfterDeadline(1_000);
    expect(tracker.getRetryAfterDeadline()).toBe(5_000);

    tracker.restoreRetryAfterDeadline(null);
    expect(tracker.getRetryAfterDeadline()).toBe(5_000);
  });
});

describe("clampIntervalSeconds", () => {
  it("clamps to the configured bounds", () => {
    expect(clampIntervalSeconds(10, options())).toBe(300);
    expect(clampIntervalSeconds(100_000, options())).toBe(3600);
    expect(clampIntervalSeconds(600, options())).toBe(600);
    expect(clampIntervalSeconds(Number.NaN, options())).toBe(300);
  });
});

describe("computeNextIntervalSeconds", () => {
  it("grows the interval after a rate-limited cycle", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 300,
        hadRateLimit: true,
        options: options(),
        now: 0,
      }),
    ).toBe(600);
  });

  it("decays the interval after a clean cycle", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 1000,
        hadRateLimit: false,
        options: options(),
        now: 0,
      }),
    ).toBe(800);
  });

  it("clamps growth at maxIntervalSeconds and decay at minIntervalSeconds", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 3000,
        hadRateLimit: true,
        options: options(),
        now: 0,
      }),
    ).toBe(3600);
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 310,
        hadRateLimit: false,
        options: options(),
        now: 0,
      }),
    ).toBe(300);
  });

  it("never schedules before the Retry-After deadline, even past the max", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 300,
        hadRateLimit: true,
        options: options(),
        retryAfterDeadlineMs: 5_000_000,
        now: 0,
      }),
    ).toBe(5_000);
  });

  it("ignores the deadline when respectRetryAfter is off", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 300,
        hadRateLimit: true,
        options: options({ respectRetryAfter: false }),
        retryAfterDeadlineMs: 5_000_000,
        now: 0,
      }),
    ).toBe(600);
  });

  it("ignores an expired deadline", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 1000,
        hadRateLimit: false,
        options: options(),
        retryAfterDeadlineMs: 1_000,
        now: 10_000,
      }),
    ).toBe(800);
  });

  it("keeps the current interval when adaptive polling is disabled", () => {
    expect(
      computeNextIntervalSeconds({
        currentIntervalSeconds: 300,
        hadRateLimit: true,
        options: options({ enabled: false }),
        retryAfterDeadlineMs: 5_000_000,
        now: 0,
      }),
    ).toBe(300);
  });
});

describe("rate limit state persistence", () => {
  it("round-trips the effective interval across a restart", async () => {
    const dir = await createTempDir();
    const statePath = resolveRateLimitStatePath(dir);
    expect(statePath).toBe(path.join(dir, "state", "rateLimit.json"));

    await writeRateLimitState(statePath, {
      intervalSeconds: 1200,
      nextRunAt: "2026-09-18T10:00:00.000Z",
      retryAfterDeadlineMs: 1_700_000_000_000,
    });

    await expect(readRateLimitState(statePath)).resolves.toEqual({
      intervalSeconds: 1200,
      nextRunAt: "2026-09-18T10:00:00.000Z",
      retryAfterDeadlineMs: 1_700_000_000_000,
    });
  });

  it("returns null for a missing state file", async () => {
    const dir = await createTempDir();
    await expect(
      readRateLimitState(resolveRateLimitStatePath(dir)),
    ).resolves.toBeNull();
  });

  it("returns null for a corrupt or incomplete state file", async () => {
    const dir = await createTempDir();
    const statePath = resolveRateLimitStatePath(dir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });

    await fs.writeFile(statePath, "{not json", "utf-8");
    await expect(readRateLimitState(statePath)).resolves.toBeNull();

    await fs.writeFile(statePath, JSON.stringify({ nextRunAt: null }), "utf-8");
    await expect(readRateLimitState(statePath)).resolves.toBeNull();

    await fs.writeFile(
      statePath,
      JSON.stringify({ intervalSeconds: 0 }),
      "utf-8",
    );
    await expect(readRateLimitState(statePath)).resolves.toBeNull();
  });
});
