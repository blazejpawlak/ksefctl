import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { logSyncCycle, type SyncCycleLogEntry } from "../../src/cli/cycleLog.js";

const createLogger = () =>
  ({ info: vi.fn(), warn: vi.fn() }) as unknown as Logger;

const baseEntry: SyncCycleLogEntry = {
  iteration: 3,
  status: "completed",
  downloaded: 0,
  skipped: 0,
  failed: 0,
  pdfFailed: 0,
  toPay: 0,
  durationMs: 95_000,
  lastSyncAt: "2026-11-14T09:30:09.681Z",
  nextRunAt: "2026-11-14T09:45:09.708Z",
};

describe("logSyncCycle", () => {
  it("logs a completed cycle at info, even when nothing was downloaded", () => {
    const logger = createLogger();

    logSyncCycle(logger, baseEntry);

    expect(logger.info).toHaveBeenCalledWith(baseEntry, "Sync cycle completed");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a failed cycle at warn with its error", () => {
    const logger = createLogger();
    const entry: SyncCycleLogEntry = {
      ...baseEntry,
      status: "failed",
      failed: 1,
      nextRunAt: null,
      error: "Network failure: fetch failed",
    };

    logSyncCycle(logger, entry);

    expect(logger.warn).toHaveBeenCalledWith(entry, "Sync cycle failed");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
