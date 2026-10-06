import { describe, expect, it } from "vitest";
import {
  addUtcMonths,
  computeSyncWindow,
  isBelowMinExportWindow,
  maxDate,
  minDate,
  parseCliTimeWindow,
  resolveConfiguredStart,
  resolveContinuation,
  resolveDefaultStart,
} from "../../src/core/window";
import { ConfigError } from "../../src/utils/errors";

describe("parseCliTimeWindow", () => {
  it("parses a valid DD-MM-YYYY:DD-MM-YYYY time window", () => {
    const result = parseCliTimeWindow("01-02-2026:31-03-2026");
    expect(result.from.getUTCFullYear()).toBe(2026);
    expect(result.from.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(result.from.getUTCDate()).toBe(1);
    expect(result.from.getUTCHours()).toBe(0);

    expect(result.to.getUTCFullYear()).toBe(2026);
    expect(result.to.getUTCMonth()).toBe(2); // March (0-indexed)
    expect(result.to.getUTCDate()).toBe(31);
    expect(result.to.getUTCHours()).toBe(23);
    expect(result.to.getUTCMinutes()).toBe(59);
    expect(result.to.getUTCSeconds()).toBe(59);
  });

  it("parses same-day window (from == to)", () => {
    const result = parseCliTimeWindow("15-06-2026:15-06-2026");
    expect(result.from.getUTCDate()).toBe(15);
    expect(result.to.getUTCDate()).toBe(15);
    // from is start-of-day, to is end-of-day
    expect(result.from.getTime()).toBeLessThan(result.to.getTime());
  });

  it("parses year boundary correctly", () => {
    const result = parseCliTimeWindow("01-12-2025:31-01-2026");
    expect(result.from.getUTCFullYear()).toBe(2025);
    expect(result.from.getUTCMonth()).toBe(11); // December
    expect(result.to.getUTCFullYear()).toBe(2026);
    expect(result.to.getUTCMonth()).toBe(0); // January
  });

  it("throws ConfigError for invalid format (missing separator)", () => {
    expect(() => parseCliTimeWindow("01-02-2026")).toThrow(ConfigError);
    expect(() => parseCliTimeWindow("01-02-2026")).toThrow(
      /expected DD-MM-YYYY:DD-MM-YYYY/,
    );
  });

  it("throws ConfigError for too many separators", () => {
    expect(() => parseCliTimeWindow("01-02-2026::31-03-2026")).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for invalid start date format", () => {
    expect(() => parseCliTimeWindow("2026-02-01:31-03-2026")).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for invalid end date format", () => {
    expect(() => parseCliTimeWindow("01-02-2026:03-31-2026")).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for non-existent calendar date", () => {
    expect(() => parseCliTimeWindow("31-02-2026:01-03-2026")).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError when start date is after end date", () => {
    expect(() => parseCliTimeWindow("01-03-2026:28-02-2026")).toThrow(
      ConfigError,
    );
    expect(() => parseCliTimeWindow("01-03-2026:28-02-2026")).toThrow(
      /start date must be before or equal to end date/,
    );
  });

  it("throws ConfigError for empty parts", () => {
    expect(() => parseCliTimeWindow(":31-03-2026")).toThrow(ConfigError);
    expect(() => parseCliTimeWindow("01-02-2026:")).toThrow(ConfigError);
  });

  it("sets from to start-of-day (00:00:00.000 UTC) and to to end-of-day (23:59:59.999 UTC)", () => {
    const result = parseCliTimeWindow("01-01-2026:31-12-2026");
    expect(result.from.getUTCHours()).toBe(0);
    expect(result.from.getUTCMinutes()).toBe(0);
    expect(result.from.getUTCSeconds()).toBe(0);
    expect(result.from.getUTCMilliseconds()).toBe(0);

    expect(result.to.getUTCHours()).toBe(23);
    expect(result.to.getUTCMinutes()).toBe(59);
    expect(result.to.getUTCSeconds()).toBe(59);
    expect(result.to.getUTCMilliseconds()).toBe(999);
  });
});

describe("computeSyncWindow", () => {
  const ksefStart = new Date("2026-02-01T00:00:00Z");

  it("uses configured start when no cursor", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const result = computeSyncWindow(now, null, ksefStart);
    expect(result.windowStart.toISOString()).toBe(ksefStart.toISOString());
    expect(result.cursor).toBeNull();
  });

  it("uses cursor when it is after configured start", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const cursor = "2026-04-01T00:00:00Z";
    const result = computeSyncWindow(now, cursor, ksefStart);
    expect(result.windowStart).toEqual(new Date(cursor));
  });

  it("uses configured start when cursor is before it", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const cursor = "2026-01-01T00:00:00Z";
    const result = computeSyncWindow(now, cursor, ksefStart);
    expect(result.windowStart.toISOString()).toBe(ksefStart.toISOString());
  });

  it("caps window end at now", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const result = computeSyncWindow(now, null, ksefStart);
    expect(result.windowEnd.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("resolveConfiguredStart", () => {
  const ksefStart = new Date("2026-02-01T00:00:00Z");

  it("returns ksef start when no initialSyncFrom", () => {
    const result = resolveConfiguredStart(undefined, ksefStart);
    expect(result.toISOString()).toBe(ksefStart.toISOString());
  });

  it("returns max of initialSyncFrom and ksefStart", () => {
    const later = "2026-06-01T00:00:00Z";
    const result = resolveConfiguredStart(later, ksefStart);
    expect(result).toEqual(new Date(later));
  });

  it("returns ksefStart when initialSyncFrom is earlier", () => {
    const earlier = "2025-01-01T00:00:00Z";
    const result = resolveConfiguredStart(earlier, ksefStart);
    expect(result.toISOString()).toBe(ksefStart.toISOString());
  });
});

describe("resolveDefaultStart", () => {
  it("returns ksef start when now minus 3 months is before ksef start", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const result = resolveDefaultStart(now);
    // 3 months before March 2026 = Dec 2025, which is before ksef start (Feb 2026)
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(1); // February
  });

  it("returns 3 months ago when it is after ksef start", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const result = resolveDefaultStart(now);
    // 3 months before Dec 2026 = Sep 2026, which is after ksef start
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(8); // September
  });
});

describe("addUtcMonths", () => {
  it("adds months correctly", () => {
    const date = new Date(Date.UTC(2026, 0, 15)); // Jan 15
    const result = addUtcMonths(date, 3);
    expect(result.getUTCMonth()).toBe(3); // April
    expect(result.getUTCDate()).toBe(15);
  });

  it("handles negative months", () => {
    const date = new Date(Date.UTC(2026, 5, 15)); // Jun 15
    const result = addUtcMonths(date, -3);
    expect(result.getUTCMonth()).toBe(2); // March
  });
});

describe("isBelowMinExportWindow", () => {
  it("returns true when the window is narrower than the minimum", () => {
    const start = new Date("2026-05-10T11:59:00Z");
    const end = new Date("2026-05-10T12:00:00Z"); // 60s window
    expect(isBelowMinExportWindow(start, end, 300)).toBe(true);
  });

  it("returns false when the window is exactly at the minimum", () => {
    const start = new Date("2026-05-10T11:55:00Z");
    const end = new Date("2026-05-10T12:00:00Z"); // exactly 300s
    expect(isBelowMinExportWindow(start, end, 300)).toBe(false);
  });

  it("returns false when the window is wider than the minimum", () => {
    const start = new Date("2026-02-01T00:00:00Z");
    const end = new Date("2026-05-01T00:00:00Z"); // 3 months
    expect(isBelowMinExportWindow(start, end, 300)).toBe(false);
  });

  it("returns false when the configured minimum is zero", () => {
    const start = new Date("2026-05-10T11:59:59Z");
    const end = new Date("2026-05-10T12:00:00Z"); // 1s window
    expect(isBelowMinExportWindow(start, end, 0)).toBe(false);
  });
});

describe("resolveContinuation", () => {
  const windowStart = new Date("2026-10-06T14:00:00.000Z");
  const windowEnd = new Date("2026-10-06T15:23:14.445Z");
  const basePackage = {
    invoiceCount: 0,
    size: 0,
    parts: [],
    isTruncated: false,
  };

  it("uses the HWM, not the requested end, for an empty package", () => {
    const result = resolveContinuation(
      {
        ...basePackage,
        permanentStorageHwmDate: "2026-10-06T15:21:14.51463+00:00",
      },
      windowStart,
      windowEnd,
    );
    expect(result).toEqual({
      kind: "advance",
      cursor: "2026-10-06T15:21:14.514Z",
      cursorDate: new Date("2026-10-06T15:21:14.514Z"),
    });
  });

  it("uses lastPermanentStorageDate for a truncated package", () => {
    const result = resolveContinuation(
      {
        ...basePackage,
        invoiceCount: 10000,
        isTruncated: true,
        lastPermanentStorageDate: "2026-10-06T14:30:00.123456+00:00",
        permanentStorageHwmDate: "2026-10-06T15:21:14.51463+00:00",
      },
      windowStart,
      windowEnd,
    );
    expect(result).toMatchObject({
      kind: "advance",
      cursor: "2026-10-06T14:30:00.123Z",
    });
  });

  it("holds a truncated package without lastPermanentStorageDate instead of using the HWM", () => {
    const result = resolveContinuation(
      {
        ...basePackage,
        isTruncated: true,
        permanentStorageHwmDate: "2026-10-06T15:21:14.51463+00:00",
      },
      windowStart,
      windowEnd,
    );
    expect(result).toEqual({
      kind: "hold",
      reason: "missing lastPermanentStorageDate",
    });
  });

  it.each([
    ["no package", undefined],
    ["null HWM", { ...basePackage, permanentStorageHwmDate: null }],
    ["empty HWM", { ...basePackage, permanentStorageHwmDate: "" }],
  ])("holds when the HWM is missing (%s)", (_label, packageInfo) => {
    expect(resolveContinuation(packageInfo, windowStart, windowEnd)).toEqual({
      kind: "hold",
      reason: "missing permanentStorageHwmDate",
    });
  });

  it("holds when the HWM is not a valid date", () => {
    const result = resolveContinuation(
      { ...basePackage, permanentStorageHwmDate: "not-a-date" },
      windowStart,
      windowEnd,
    );
    expect(result.kind).toBe("hold");
  });

  it.each([
    ["equal to", "2026-10-06T14:00:00.000Z"],
    ["before", "2026-10-06T13:59:59.999Z"],
  ])("holds when the HWM is %s the window start", (_label, hwm) => {
    const result = resolveContinuation(
      { ...basePackage, permanentStorageHwmDate: hwm },
      windowStart,
      windowEnd,
    );
    expect(result.kind).toBe("hold");
  });

  it("caps the cursor at the window end", () => {
    const result = resolveContinuation(
      { ...basePackage, permanentStorageHwmDate: "2026-10-06T16:00:00Z" },
      windowStart,
      windowEnd,
    );
    expect(result).toMatchObject({
      kind: "advance",
      cursor: windowEnd.toISOString(),
    });
  });
});

describe("minDate / maxDate", () => {
  const a = new Date("2026-01-01T00:00:00Z");
  const b = new Date("2026-06-01T00:00:00Z");

  it("minDate returns earlier date", () => {
    expect(minDate(a, b)).toBe(a);
    expect(minDate(b, a)).toBe(a);
  });

  it("maxDate returns later date", () => {
    expect(maxDate(a, b)).toBe(b);
    expect(maxDate(b, a)).toBe(b);
  });

  it("minDate returns first when equal", () => {
    expect(minDate(a, a)).toBe(a);
  });

  it("maxDate returns first when equal", () => {
    expect(maxDate(a, a)).toBe(a);
  });
});
