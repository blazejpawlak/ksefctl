import type { Logger } from "pino";

export type SyncCycleLogEntry = {
  iteration: number;
  status: "completed" | "failed";
  downloaded: number;
  skipped: number;
  failed: number;
  pdfFailed: number;
  toPay: number;
  durationMs: number;
  lastSyncAt: string | null;
  nextRunAt: string | null;
  error?: string;
};

/**
 * Writes one structured entry per watch cycle, so the log file shows the
 * service is alive and syncing even when a cycle downloads nothing. A failed
 * cycle logs at warn; its error was already logged where it was caught.
 */
export const logSyncCycle = (
  logger: Logger,
  entry: SyncCycleLogEntry,
): void => {
  if (entry.status === "failed") {
    logger.warn(entry, "Sync cycle failed");
    return;
  }
  logger.info(entry, "Sync cycle completed");
};
