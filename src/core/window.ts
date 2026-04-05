import type { InvoiceExportStatusResponse } from "../api/ksefClient";
import { ConfigError } from "../utils/errors";

export const ksefStartDateIso = "2026-02-01T00:00:00Z";
export const maxDateRangeMonths = 3;

export const outOfRangeErrorToken =
  "zakres filtrowania wykracza poza dostepny zakres danych";

export const isOutOfRangeError = (message: string): boolean => {
  const normalized = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized.includes(outOfRangeErrorToken);
};

export const addUtcMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

export const minDate = (first: Date, second: Date): Date =>
  first.getTime() <= second.getTime() ? first : second;

export const maxDate = (first: Date, second: Date): Date =>
  first.getTime() >= second.getTime() ? first : second;

export const parseIsoDate = (value: string, label: string): Date => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ConfigError(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

export const resolveNextCursor = (
  packageInfo: InvoiceExportStatusResponse["package"] | undefined,
  fallback: string,
): string => {
  if (packageInfo?.isTruncated && packageInfo.lastPermanentStorageDate) {
    return packageInfo.lastPermanentStorageDate;
  }
  if (packageInfo?.permanentStorageHwmDate) {
    return packageInfo.permanentStorageHwmDate;
  }
  return fallback;
};

export type MetadataFile = {
  invoices?: (Record<string, unknown> & {
    ksefNumber?: string;
    permanentStorageDate?: string;
    invoiceNumber?: string;
    seller?: {
      nip?: string;
      name?: string | null;
    };
  })[];
};

/**
 * Compute the initial sync window boundaries for a given NIP / subject type.
 *
 * Returns { windowStart, windowEnd, cursor } where:
 * - windowStart: the lower bound (ISO string)
 * - windowEnd:   the upper bound capped at `now`
 * - cursor:      the DB-stored continuation point, or null for a full reset
 */
export type SyncWindow = {
  windowStart: Date;
  windowEnd: Date;
  cursor: string | null;
};

export const computeSyncWindow = (
  now: Date,
  cursor: string | null,
  configuredStart: Date,
): SyncWindow => {
  let windowStart = configuredStart;

  if (cursor) {
    const cursorDate = parseIsoDate(cursor, "continuation point");
    if (cursorDate.getTime() < configuredStart.getTime()) {
      windowStart = configuredStart;
    } else {
      windowStart = cursorDate;
    }
  }

  if (windowStart.getTime() > now.getTime()) {
    windowStart = now;
  }

  return {
    windowStart,
    windowEnd: minDate(addUtcMonths(windowStart, maxDateRangeMonths), now),
    cursor,
  };
};

/**
 * Advance the window to the next cursor position.
 * Returns null when the cursor has not moved (indicating a potential stall).
 */
export const advanceWindow = (
  currentStart: Date,
  nextCursor: string,
): { nextStart: Date; stalled: boolean } => {
  const nextStart = parseIsoDate(nextCursor, "continuation point");
  return {
    nextStart,
    stalled: nextStart.getTime() <= currentStart.getTime(),
  };
};

/**
 * Resolve the configured start date from config, respecting the KSeF epoch.
 */
export const resolveConfiguredStart = (
  initialSyncFrom: string | undefined,
  ksefStartDate: Date,
): Date => {
  if (!initialSyncFrom) return ksefStartDate;
  return maxDate(
    parseIsoDate(initialSyncFrom, "initialSyncFrom"),
    ksefStartDate,
  );
};

/**
 * Build the default window start (max of KSeF epoch and 3 months ago).
 */
export const resolveDefaultStart = (now: Date): Date =>
  maxDate(
    parseIsoDate(ksefStartDateIso, "KSeF start date"),
    addUtcMonths(now, -maxDateRangeMonths),
  );
