import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./paths";

export type AdaptivePollingOptions = {
  enabled: boolean;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  growthFactor: number;
  decayFactor: number;
  respectRetryAfter: boolean;
};

export type RateLimitInfo = {
  path: string;
  retryAfterMs: number;
  at: number;
};

export type RateLimitCycle = {
  hadRateLimit: boolean;
  rateLimitCount: number;
  cleanCycles: number;
};

/**
 * Accumulates the rate-limit signals KSeF returns during a sync cycle so the
 * watch loop can schedule the next poll from them. Pure in-memory bookkeeping:
 * HttpClient reports, this tracker remembers, the scheduler decides.
 */
export class RateLimitTracker {
  private retryAfterDeadlineMs: number | null = null;
  private rateLimitCount = 0;
  private successCount = 0;
  private cleanCycles = 0;

  /** Record a 429 response; keeps the newest (furthest) Retry-After deadline. */
  recordRateLimit(info: RateLimitInfo): void {
    this.rateLimitCount += 1;
    const deadline = info.at + Math.max(0, info.retryAfterMs);
    if (
      this.retryAfterDeadlineMs === null ||
      deadline > this.retryAfterDeadlineMs
    ) {
      this.retryAfterDeadlineMs = deadline;
    }
  }

  /** Record a successful response in the current cycle. */
  recordSuccess(): void {
    this.successCount += 1;
  }

  /** Re-apply a deadline observed before a restart. Older values are ignored. */
  restoreRetryAfterDeadline(deadlineMs: number | null): void {
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return;
    if (
      this.retryAfterDeadlineMs === null ||
      deadlineMs > this.retryAfterDeadlineMs
    ) {
      this.retryAfterDeadlineMs = deadlineMs;
    }
  }

  getRetryAfterDeadline(): number | null {
    return this.retryAfterDeadlineMs;
  }

  /** Milliseconds left until the newest Retry-After deadline (0 when past). */
  msUntilRetryAfter(now: number = Date.now()): number {
    if (this.retryAfterDeadlineMs === null) return 0;
    return Math.max(0, this.retryAfterDeadlineMs - now);
  }

  getRateLimitCount(): number {
    return this.rateLimitCount;
  }

  getSuccessCount(): number {
    return this.successCount;
  }

  /** Close the current cycle and return what it observed. */
  completeCycle(): RateLimitCycle {
    const hadRateLimit = this.rateLimitCount > 0;
    this.cleanCycles = hadRateLimit ? 0 : this.cleanCycles + 1;
    const cycle: RateLimitCycle = {
      hadRateLimit,
      rateLimitCount: this.rateLimitCount,
      cleanCycles: this.cleanCycles,
    };
    this.rateLimitCount = 0;
    this.successCount = 0;
    return cycle;
  }
}

export const clampIntervalSeconds = (
  seconds: number,
  options: Pick<
    AdaptivePollingOptions,
    "minIntervalSeconds" | "maxIntervalSeconds"
  >,
): number => {
  const min = options.minIntervalSeconds;
  const max = Math.max(min, options.maxIntervalSeconds);
  if (!Number.isFinite(seconds)) return min;
  return Math.min(max, Math.max(min, Math.round(seconds)));
};

export type NextIntervalInput = {
  currentIntervalSeconds: number;
  hadRateLimit: boolean;
  options: AdaptivePollingOptions;
  retryAfterDeadlineMs?: number | null;
  now?: number;
};

/**
 * Grow the interval after a rate-limited cycle, decay it after a clean one, and
 * never schedule before the newest Retry-After deadline the API handed us.
 * The Retry-After floor is applied after clamping: KSeF is authoritative, so it
 * may push the interval beyond maxIntervalSeconds.
 */
export const computeNextIntervalSeconds = ({
  currentIntervalSeconds,
  hadRateLimit,
  options,
  retryAfterDeadlineMs = null,
  now = Date.now(),
}: NextIntervalInput): number => {
  if (!options.enabled) return currentIntervalSeconds;

  const scaled = hadRateLimit
    ? currentIntervalSeconds * options.growthFactor
    : currentIntervalSeconds * options.decayFactor;
  const next = clampIntervalSeconds(scaled, options);

  if (!options.respectRetryAfter || retryAfterDeadlineMs === null) {
    return next;
  }
  const remainingMs = Math.max(0, retryAfterDeadlineMs - now);
  return Math.max(next, Math.ceil(remainingMs / 1000));
};

export type RateLimitState = {
  intervalSeconds: number;
  nextRunAt: string | null;
  retryAfterDeadlineMs: number | null;
};

const stateVersion = 1;

export const resolveRateLimitStatePath = (storageRoot: string): string =>
  path.join(storageRoot, "state", "rateLimit.json");

const parseState = (raw: unknown): RateLimitState | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const intervalSeconds = record.intervalSeconds;
  if (typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds)) {
    return null;
  }
  if (intervalSeconds <= 0) return null;
  const nextRunAt =
    typeof record.nextRunAt === "string" ? record.nextRunAt : null;
  const deadline = record.retryAfterDeadlineMs;
  const retryAfterDeadlineMs =
    typeof deadline === "number" && Number.isFinite(deadline) ? deadline : null;
  return { intervalSeconds, nextRunAt, retryAfterDeadlineMs };
};

/**
 * Read the persisted adaptive state. A missing, unreadable or corrupt file is
 * not an error: the caller falls back to the configured interval.
 */
export const readRateLimitState = async (
  filePath: string,
): Promise<RateLimitState | null> => {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    return parseState(JSON.parse(contents));
  } catch {
    return null;
  }
};

export const writeRateLimitState = async (
  filePath: string,
  state: RateLimitState,
): Promise<void> => {
  await atomicWriteFile(
    filePath,
    JSON.stringify(
      {
        version: stateVersion,
        intervalSeconds: state.intervalSeconds,
        nextRunAt: state.nextRunAt,
        retryAfterDeadlineMs: state.retryAfterDeadlineMs,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};
