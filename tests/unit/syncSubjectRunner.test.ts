import type { KsefClient } from "../../src/api/ksefClient.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { PdfService } from "../../src/services/pdfService.js";
import type { Logger } from "pino";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncSubjectType } from "../../src/core/syncSubjectRunner.js";
import {
  getContinuationPoint,
  getInvoice,
  setContinuationPoint,
  upsertInvoice,
} from "../../src/db/repository.js";
import { SqliteStore } from "../../src/db/sqlite.js";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto.js";

const testKey = Buffer.alloc(32, 3);
const testIv = Buffer.alloc(16, 4);

vi.mock("../../src/core/encryption.js", () => ({
  createEncryptionData: vi.fn().mockResolvedValue({
    key: Buffer.alloc(32, 3),
    iv: Buffer.alloc(16, 4),
    encryptionInfo: {
      encryptedSymmetricKey: "enc",
      initializationVector: "iv",
    },
  }),
  selectCertificateByUsage: vi.fn(() => "cert"),
}));

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createConfig = (
  storageRoot: string,
  syncOverrides: Partial<AppConfig["sync"]> = {},
): AppConfig => ({
  environment: "test",
  apiBaseUrl: "http://localhost/v2",
  auth: { method: "ksefToken", keychainServiceName: "ksefctl-test" },
  organizations: [{ nip: "1234567890" }],
  pollingIntervalSeconds: 300,
  storage: { root: storageRoot },
  notifications: {
    macosNotification: false,
    unpaidInvoiceCatchUp: false,
    unpaidCatchUpLookbackDays: 30,
    email: { enabled: false },
  },
  logging: {
    level: "info",
    file: path.join(storageRoot, "logs", "app.log"),
    pretty: false,
    rotation: {
      enabled: false,
      maxFileMegabytes: 16,
      maxFiles: 5,
      maxAgeDays: 30,
    },
  },
  operational: {
    maxConcurrency: 2,
    timeoutSeconds: 60,
    pollIntervalSeconds: 5,
    authPollMaxAttempts: 1,
    exportPollMaxAttempts: 2,
    exportCooldownSeconds: 0,
    allowInsecureHttp: true,
    retry: {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: 0,
    },
  },
  security: {
    tls: { enablePinning: false, pins: [], pinningHosts: [] },
    allowedHosts: ["example.test"],
  },
  sync: {
    subjectTypes: ["Subject1"],
    includeMetadataHeader: true,
    generatePdf: false,
    pdfGenerationTimeoutMs: 30000,
    pdfMaxConsecutiveTimeouts: 3,
    minExportWindowSeconds: 300,
    adaptivePolling: {
      enabled: false,
      minIntervalSeconds: 300,
      maxIntervalSeconds: 3600,
      growthFactor: 2,
      decayFactor: 0.8,
      respectRetryAfter: true,
    },
    flatSync: false,
    maxConcurrentNips: 1,
    ...syncOverrides,
  },
});

const buildEncryptedPackage = (ksefNumber: string, xmlText: string) => {
  const zip = new AdmZip();
  zip.addFile(`${ksefNumber}.xml`, Buffer.from(xmlText, "utf-8"));
  const zipBuffer = zip.toBuffer();
  const encrypted = encryptAes256Cbc(testKey, testIv, zipBuffer);
  return {
    encrypted,
    partHash: sha256Base64(zipBuffer),
    encryptedPartHash: sha256Base64(encrypted),
  };
};

const createRunnerDeps = (
  client: KsefClient,
  config: AppConfig,
  logger: Logger,
  store: SqliteStore,
) => ({
  client,
  config,
  logger,
  store,
  pdfService: {} as PdfService,
  reportProgress: vi.fn(),
  sleepWithProgress: vi.fn().mockResolvedValue(undefined),
  getEncryptionCertificate: vi.fn().mockResolvedValue("cert"),
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("syncSubjectType - narrow window skip (ksefctl-9of)", () => {
  it("does not issue an export request when the window is narrower than minExportWindowSeconds", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));

    // Cursor is only 60s behind "now" - narrower than the 300s minimum.
    const cursor = new Date(now.getTime() - 60_000).toISOString();
    await store.withDb((db) =>
      setContinuationPoint(db, "1234567890", "Subject1", cursor),
    );

    const exportInvoices = vi.fn();
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    const result = await syncSubjectType(deps, "ACCESS", "1234567890", "Subject1");

    expect(exportInvoices).not.toHaveBeenCalled();
    expect(result).toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      pdfFailed: 0,
      items: [],
    });

    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1"),
    );
    expect(continuation).toBe(cursor);
  });

  it("still issues the request when the window is exactly at the configured minimum", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));

    // Window is exactly minExportWindowSeconds wide - "below" is a strict
    // inequality, so this must still be attempted.
    const cursor = new Date(now.getTime() - 300_000).toISOString();
    await store.withDb((db) =>
      setContinuationPoint(db, "1234567890", "Subject1", cursor),
    );

    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 400 POST /invoices/exports: zakres filtrowania wykracza poza dostepny zakres danych",
        ),
      );
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    await syncSubjectType(deps, "ACCESS", "1234567890", "Subject1");

    expect(exportInvoices).toHaveBeenCalledTimes(1);
  });

  it("terminates the loop rather than retrying a narrow window forever", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const cursor = new Date(now.getTime() - 8_000).toISOString();
    await store.withDb((db) =>
      setContinuationPoint(db, "1234567890", "Subject1", cursor),
    );

    const exportInvoices = vi.fn();
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    await expect(
      syncSubjectType(deps, "ACCESS", "1234567890", "Subject1"),
    ).resolves.toBeDefined();
    expect(exportInvoices).not.toHaveBeenCalled();
  });
});

describe("syncSubjectType - out-of-range rejection (ksefctl-1f1)", () => {
  it("does not advance the continuation point on an out-of-range rejection", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));

    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 400 POST /invoices/exports: zakres filtrowania wykracza poza dostepny zakres danych",
        ),
      );
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    const result = await syncSubjectType(
      deps,
      "ACCESS",
      "1234567890",
      "Subject1",
    );

    // No data was returned; the cursor must stay where it was (unset).
    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1"),
    );
    expect(continuation).toBeNull();
    expect(result).toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      pdfFailed: 0,
      items: [],
    });
    // Exactly one attempt - proves the loop terminates rather than
    // re-requesting the same rejected range indefinitely.
    expect(exportInvoices).toHaveBeenCalledTimes(1);
  });

  it("preserves a pre-existing cursor after an out-of-range rejection", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const priorCursor = "2026-04-01T00:00:00.000Z";
    await store.withDb((db) =>
      setContinuationPoint(db, "1234567890", "Subject1", priorCursor),
    );

    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 400 POST /invoices/exports: zakres filtrowania wykracza poza dostepny zakres danych",
        ),
      );
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    await syncSubjectType(deps, "ACCESS", "1234567890", "Subject1");

    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1"),
    );
    expect(continuation).toBe(priorCursor);
  });

  it("propagates non-out-of-range errors instead of swallowing them", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));

    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error("HTTP 500 POST /invoices/exports: upstream failure"),
      );
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    await expect(
      syncSubjectType(deps, "ACCESS", "1234567890", "Subject1"),
    ).rejects.toThrow("upstream failure");
  });
});

describe("syncSubjectType - normal path unaffected", () => {
  it("downloads invoices and advances the cursor to the KSeF high-water mark on a normal export", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const ksefNumber = "KSEF-NORMAL-1";
    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      "<Faktura><P_2>NORMAL</P_2></Faktura>",
    );
    const hwmDate = new Date(now.getTime() - 30_000).toISOString();

    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          permanentStorageHwmDate: hwmDate,
          parts: [
            {
              ordinalNumber: 1,
              partName: "part1.zip.aes",
              method: "GET",
              url: "https://example.test/part1",
              partHash,
              encryptedPartHash,
            },
          ],
        },
      }),
      downloadPackagePart: vi.fn().mockResolvedValue(encrypted),
    } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: new Date(now.getTime() - 86_400_000).toISOString(),
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);

    const result = await syncSubjectType(
      deps,
      "ACCESS",
      "1234567890",
      "Subject1",
    );

    expect(exportInvoices).toHaveBeenCalledTimes(1);
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);

    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1"),
    );
    expect(continuation).toBe(hwmDate);
  });
});

describe("syncSubjectType - HWM continuation point", () => {
  const nip = "1234567890";
  // Reproduced on production 2026-10-06: an empty export whose HWM lags
  // the requested `to` by about two minutes.
  const now = new Date("2026-10-06T15:23:14.445Z");
  const priorCursor = "2026-10-06T14:00:00.000Z";
  const hwm = "2026-10-06T15:21:14.51463+00:00";
  const hwmIso = "2026-10-06T15:21:14.514Z";

  const emptyPackage = (permanentStorageHwmDate?: string | null) => ({
    status: { code: 200, description: "OK" },
    package: {
      invoiceCount: 0,
      size: 0,
      isTruncated: false,
      permanentStorageHwmDate,
      parts: [],
    },
  });

  const invoicePackage = (
    ksefNumber: string,
    packageFields: Record<string, unknown>,
  ) => {
    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      `<Faktura><P_2>${ksefNumber}</P_2></Faktura>`,
    );
    return {
      encrypted,
      status: {
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          parts: [
            {
              ordinalNumber: 1,
              partName: `${ksefNumber}.zip.aes`,
              method: "GET",
              url: `https://example.test/${ksefNumber}`,
              partHash,
              encryptedPartHash,
            },
          ],
          ...packageFields,
        },
      },
    };
  };

  const setup = async (cursor: string | null = priorCursor) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    if (cursor) {
      await store.withDb((db) =>
        setContinuationPoint(db, nip, "Subject1", cursor),
      );
    }
    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const getExportStatus = vi.fn();
    const downloadPackagePart = vi.fn();
    const client = {
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
    } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const logger = createLogger();
    const deps = createRunnerDeps(client, config, logger, store);
    const readCursor = () =>
      store.withDb((db) => getContinuationPoint(db, nip, "Subject1"));
    const requestedRange = (call: number) =>
      (
        exportInvoices.mock.calls[call]?.[1] as {
          filters: { dateRange: { from: string; to: string } };
        }
      ).filters.dateRange;
    return {
      store,
      deps,
      logger,
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
      readCursor,
      requestedRange,
    };
  };

  it("stores the HWM, not the requested end, for an empty package", async () => {
    const t = await setup();
    t.getExportStatus.mockResolvedValue(emptyPackage(hwm));

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedRange(0)).toMatchObject({
      from: priorCursor,
      to: now.toISOString(),
    });
    expect(await t.readCursor()).toBe(hwmIso);
    expect(t.exportInvoices).toHaveBeenCalledTimes(1);
  });

  it("fetches an invoice committed between the previous HWM and the previous end in the next cycle", async () => {
    const t = await setup();
    t.getExportStatus.mockResolvedValueOnce(emptyPackage(hwm));
    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    // The invoice lands in (HWM, previous `to`] after the first export.
    const later = new Date(now.getTime() + 15 * 60_000);
    vi.setSystemTime(later);
    const ksefNumber = "KSEF-LATE-COMMIT";
    const { encrypted, status } = invoicePackage(ksefNumber, {
      permanentStorageHwmDate: "2026-10-06T15:36:00.000+00:00",
    });
    t.getExportStatus.mockResolvedValueOnce(status);
    t.downloadPackagePart.mockResolvedValueOnce(encrypted);

    const result = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedRange(1).from).toBe(hwmIso);
    expect(result.downloaded).toBe(1);
    expect(result.items[0]?.ksefNumber).toBe(ksefNumber);
    expect(await t.readCursor()).toBe("2026-10-06T15:36:00.000Z");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", "not-a-date"],
    ["equal to the window start", priorCursor],
    ["before the window start", "2026-10-06T13:00:00.000Z"],
  ])(
    "keeps the cursor and stops when the HWM is %s",
    async (_label, hwmValue) => {
      const t = await setup();
      t.getExportStatus.mockResolvedValue(emptyPackage(hwmValue));

      const result = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

      expect(result.failed).toBe(0);
      expect(t.exportInvoices).toHaveBeenCalledTimes(1);
      expect(await t.readCursor()).toBe(priorCursor);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.any(String) as string }),
        "Continuation point not advanced",
      );
    },
  );

  it("keeps the cursor when a non-empty package has no HWM", async () => {
    const t = await setup();
    const { encrypted, status } = invoicePackage("KSEF-NO-HWM", {});
    t.getExportStatus.mockResolvedValue(status);
    t.downloadPackagePart.mockResolvedValue(encrypted);

    const result = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(result.downloaded).toBe(1);
    expect(t.exportInvoices).toHaveBeenCalledTimes(1);
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("keeps the cursor when KSeF reports invoices but no package parts", async () => {
    const t = await setup();
    t.getExportStatus.mockResolvedValue({
      ...emptyPackage(hwm),
      package: { ...emptyPackage(hwm).package, invoiceCount: 3 },
    });

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.exportInvoices).toHaveBeenCalledTimes(1);
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("does not move the regular cursor for an empty explicit-window export", async () => {
    const t = await setup();
    t.getExportStatus.mockResolvedValue(
      emptyPackage("2026-09-30T23:59:59.999+00:00"),
    );

    await syncSubjectType(
      t.deps,
      "ACCESS",
      nip,
      "Subject1",
      undefined,
      false,
      false,
      false,
      undefined,
      {
        from: new Date("2026-09-01T00:00:00.000Z"),
        to: new Date("2026-09-30T23:59:59.999Z"),
      },
    );

    expect(t.exportInvoices).toHaveBeenCalledTimes(1);
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("does not move the regular cursor for a non-empty explicit-window export", async () => {
    const t = await setup();
    const { encrypted, status } = invoicePackage("KSEF-EXPLICIT", {
      permanentStorageHwmDate: "2026-09-30T23:59:59.999+00:00",
    });
    t.getExportStatus.mockResolvedValue(status);
    t.downloadPackagePart.mockResolvedValue(encrypted);

    const result = await syncSubjectType(
      t.deps,
      "ACCESS",
      nip,
      "Subject1",
      undefined,
      false,
      false,
      false,
      undefined,
      {
        from: new Date("2026-09-01T00:00:00.000Z"),
        to: new Date("2026-09-30T23:59:59.999Z"),
      },
    );

    expect(result.downloaded).toBe(1);
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("continues a truncated package from lastPermanentStorageDate and deduplicates the overlap", async () => {
    const t = await setup();
    const lastStored = "2026-10-06T14:30:00.123456+00:00";
    const first = invoicePackage("KSEF-OVERLAP", {
      invoiceCount: 10000,
      isTruncated: true,
      lastPermanentStorageDate: lastStored,
      permanentStorageHwmDate: hwm,
    });
    // KSeF repeats the invoice stored at lastPermanentStorageDate.
    const second = invoicePackage("KSEF-OVERLAP", {
      permanentStorageHwmDate: hwm,
    });
    t.getExportStatus
      .mockResolvedValueOnce(first.status)
      .mockResolvedValueOnce(second.status);
    t.downloadPackagePart
      .mockResolvedValueOnce(first.encrypted)
      .mockResolvedValueOnce(second.encrypted);

    const result = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.exportInvoices).toHaveBeenCalledTimes(2);
    expect(t.requestedRange(1).from).toBe("2026-10-06T14:30:00.123Z");
    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await t.readCursor()).toBe(hwmIso);
  });
});

describe("syncSubjectType - output-path exports (ksefctl-h40)", () => {
  const nip = "1234567890";
  const now = new Date("2026-10-06T15:23:14.445Z");
  const priorCursor = "2026-10-06T14:00:00.000Z";
  const hwm = "2026-10-06T15:21:14.514Z";

  const invoicePackage = (ksefNumber: string) => {
    const xmlText = `<Faktura><P_2>${ksefNumber}</P_2></Faktura>`;
    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      xmlText,
    );
    return {
      encrypted,
      xmlHash: sha256Base64(Buffer.from(xmlText, "utf-8")),
      status: {
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          permanentStorageHwmDate: hwm,
          parts: [
            {
              ordinalNumber: 1,
              partName: `${ksefNumber}.zip.aes`,
              method: "GET",
              url: `https://example.test/${ksefNumber}`,
              partHash,
              encryptedPartHash,
            },
          ],
        },
      },
    };
  };

  const setup = async (cursor: string = priorCursor) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    await store.withDb((db) => setContinuationPoint(db, nip, "Subject1", cursor));
    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const getExportStatus = vi.fn();
    const downloadPackagePart = vi.fn();
    const client = {
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
    } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const deps = createRunnerDeps(client, config, createLogger(), store);
    const outputPath = path.join(tmpDir, "scratch-export");
    const readCursor = () =>
      store.withDb((db) => getContinuationPoint(db, nip, "Subject1"));
    const readInvoice = (ksefNumber: string) =>
      store.withDb((db) => getInvoice(db, nip, ksefNumber));
    const runExport = (forceRedownloadAll = false) =>
      syncSubjectType(
        deps,
        "ACCESS",
        nip,
        "Subject1",
        undefined,
        false,
        forceRedownloadAll,
        false,
        outputPath,
      );
    return {
      deps,
      store,
      config,
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
      outputPath,
      readCursor,
      readInvoice,
      runExport,
    };
  };

  it("does not create a canonical invoice row for an exported invoice", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-EXPORT-NEW");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);

    const result = await t.runExport();

    expect(result.downloaded).toBe(1);
    expect(result.items[0]?.path.startsWith(t.outputPath)).toBe(true);
    expect(await t.readInvoice("KSEF-EXPORT-NEW")).toBeNull();
  });

  it("exports an invoice already in the store without touching its canonical row", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-EXPORT-KNOWN");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);
    const canonicalDir = path.join(t.config.storage.root, "invoices", "known");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "KSEF-EXPORT-KNOWN.xml"),
      "<Faktura><P_2>KSEF-EXPORT-KNOWN</P_2></Faktura>",
    );
    const canonicalRow = {
      nip,
      ksef_number: "KSEF-EXPORT-KNOWN",
      file_path: canonicalDir,
      hash: pkg.xmlHash,
      status: "downloaded",
      downloaded_at: "2026-10-01T00:00:00.000Z",
      received_at: "2026-10-01T00:00:00.000Z",
      error: null,
    };
    await t.store.withDb((db) => upsertInvoice(db, canonicalRow));

    const result = await t.runExport();

    // Deduplication is against the output directory, so a canonical copy
    // does not suppress the export.
    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await t.readInvoice("KSEF-EXPORT-KNOWN")).toEqual(canonicalRow);
  });

  it("does not record a failed canonical row when an export write fails", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-EXPORT-FAIL");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);
    // A regular file where the output directory should be makes the write fail.
    await fs.writeFile(t.outputPath, "not a directory");

    const result = await t.runExport();

    expect(result.failed).toBe(1);
    expect(await t.readInvoice("KSEF-EXPORT-FAIL")).toBeNull();
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("skips invoices already present in the output directory", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-EXPORT-TWICE");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);

    const first = await t.runExport();
    const second = await t.runExport();
    const forced = await t.runExport(true);

    expect(first.downloaded).toBe(1);
    expect(second).toMatchObject({ downloaded: 0, skipped: 1 });
    // A forced re-download replays from initialSyncFrom (several windows, each
    // served the same package here) and rewrites the file every time.
    expect(forced.skipped).toBe(0);
    expect(forced.downloaded).toBeGreaterThan(0);
  });

  it("does not move the regular cursor", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-EXPORT-CURSOR");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);

    await t.runExport();

    const range = (
      t.exportInvoices.mock.calls[0]?.[1] as {
        filters: { dateRange: { from: string } };
      }
    ).filters.dateRange;
    // The window still starts at the regular cursor ...
    expect(range.from).toBe(priorCursor);
    // ... but the cursor is not advanced to the HWM.
    expect(await t.readCursor()).toBe(priorCursor);
  });

  it("does not rewrite the cursor when flooring it or forcing a full re-download", async () => {
    const staleCursor = "2026-01-15T00:00:00.000Z";
    const t = await setup(staleCursor);
    const pkg = invoicePackage("KSEF-EXPORT-FLOOR");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);

    await t.runExport();
    expect(await t.readCursor()).toBe(staleCursor);

    await t.runExport(true);
    expect(await t.readCursor()).toBe(staleCursor);
  });

  it("still records canonical state for a regular run (no output path)", async () => {
    const t = await setup();
    const pkg = invoicePackage("KSEF-REGULAR");
    t.getExportStatus.mockResolvedValue(pkg.status);
    t.downloadPackagePart.mockResolvedValue(pkg.encrypted);

    const result = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(result.downloaded).toBe(1);
    const row = await t.readInvoice("KSEF-REGULAR");
    expect(row).toMatchObject({ status: "downloaded", hash: pkg.xmlHash });
    expect(
      row?.file_path.startsWith(path.join(t.config.storage.root, "invoices")),
    ).toBe(true);
    expect(await t.readCursor()).toBe(hwm);
  });
});

describe("syncSubjectType - saved cursor without initialSyncFrom", () => {
  const nip = "1234567890";
  const now = new Date("2026-10-06T15:23:14.445Z");
  // now minus 3 months: what the rolling default start resolves to.
  const defaultStartIso = "2026-07-06T15:23:14.445Z";

  const emptyPackage = (permanentStorageHwmDate?: string) => ({
    status: { code: 200, description: "OK" },
    package: {
      invoiceCount: 0,
      size: 0,
      isTruncated: false,
      permanentStorageHwmDate,
      parts: [],
    },
  });

  const setup = async (cursor: string | null) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    if (cursor) {
      await store.withDb((db) =>
        setContinuationPoint(db, nip, "Subject1", cursor),
      );
    }
    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const getExportStatus = vi.fn();
    const downloadPackagePart = vi.fn();
    const client = {
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
    } as unknown as KsefClient;
    // `initialSyncFrom` is deliberately left unset.
    const storageRoot = path.join(tmpDir, "storage");
    const config = createConfig(storageRoot, { minExportWindowSeconds: 300 });
    const deps = createRunnerDeps(client, config, createLogger(), store);
    const readCursor = () =>
      store.withDb((db) => getContinuationPoint(db, nip, "Subject1"));
    const requestedFrom = (call: number) =>
      (
        exportInvoices.mock.calls[call]?.[1] as {
          filters: { dateRange: { from: string } };
        }
      ).filters.dateRange.from;
    return {
      deps,
      storageRoot,
      exportInvoices,
      getExportStatus,
      downloadPackagePart,
      readCursor,
      requestedFrom,
    };
  };

  it("starts at a cursor older than 3 months and does not rewrite it to the rolling default", async () => {
    const oldCursor = "2026-05-01T00:00:00.000Z";
    const t = await setup(oldCursor);
    // No usable HWM: the export holds the cursor, exposing where it started.
    t.getExportStatus.mockResolvedValue(emptyPackage(undefined));

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedFrom(0)).toBe(oldCursor);
    expect(await t.readCursor()).toBe(oldCursor);
  });

  it("catches a lagging cursor up in windows of at most 3 months", async () => {
    const oldCursor = "2026-05-01T00:00:00.000Z";
    const t = await setup(oldCursor);
    t.getExportStatus.mockImplementation(() => {
      const range = (
        t.exportInvoices.mock.calls.at(-1)?.[1] as {
          filters: { dateRange: { to: string } };
        }
      ).filters.dateRange;
      return Promise.resolve(emptyPackage(range.to));
    });

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedFrom(0)).toBe(oldCursor);
    expect(t.requestedFrom(1)).toBe("2026-08-01T00:00:00.000Z");
    expect(t.exportInvoices).toHaveBeenCalledTimes(2);
    expect(await t.readCursor()).toBe(now.toISOString());
  });

  it("floors a cursor older than the KSeF start date at that date", async () => {
    const t = await setup("2026-01-15T00:00:00.000Z");
    t.getExportStatus.mockResolvedValue(emptyPackage(undefined));

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedFrom(0)).toBe("2026-02-01T00:00:00.000Z");
    expect(await t.readCursor()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("retries a failed write near the initial boundary from the held cursor on a later cycle", async () => {
    // The cursor equals the default start, as after a first sync 3 months ago.
    const t = await setup(defaultStartIso);
    const ksefNumber = "KSEF-FAILS-AT-BOUNDARY";
    const xmlText = `<Faktura><P_2>${ksefNumber}</P_2></Faktura>`;
    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      xmlText,
    );
    t.getExportStatus.mockResolvedValueOnce({
      status: { code: 200, description: "OK" },
      package: {
        invoiceCount: 1,
        size: encrypted.length,
        isTruncated: false,
        permanentStorageHwmDate: "2026-07-06T15:25:00.000+00:00",
        parts: [
          {
            ordinalNumber: 1,
            partName: `${ksefNumber}.zip.aes`,
            method: "GET",
            url: `https://example.test/${ksefNumber}`,
            partHash,
            encryptedPartHash,
          },
        ],
      },
    });
    t.downloadPackagePart.mockResolvedValueOnce(encrypted);
    // A regular file where the storage root should be makes the write fail.
    await fs.writeFile(t.storageRoot, "not a directory");

    const first = await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(first.failed).toBe(1);
    expect(await t.readCursor()).toBe(defaultStartIso);

    // Later, the rolling default start has moved past the held cursor.
    vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
    t.getExportStatus.mockResolvedValueOnce(emptyPackage(undefined));

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedFrom(0)).toBe(defaultStartIso);
    expect(t.requestedFrom(1)).toBe(defaultStartIso);
    expect(await t.readCursor()).toBe(defaultStartIso);
  });

  it("starts a first sync, with no cursor, 3 months back", async () => {
    const t = await setup(null);
    t.getExportStatus.mockResolvedValue(emptyPackage(undefined));

    await syncSubjectType(t.deps, "ACCESS", nip, "Subject1");

    expect(t.requestedFrom(0)).toBe(defaultStartIso);
  });
});

describe("syncSubjectType - export-only runs never write the canonical DB", () => {
  const nip = "1234567890";
  const priorCursor = "2026-04-01T00:00:00.000Z";
  const canWriteDespiteMode = process.getuid?.() === 0;
  const tmpDirs: string[] = [];

  const setup = async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00Z"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-runner-"));
    tmpDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "db", "state.sqlite");
    const store = new SqliteStore(dbPath);
    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 400 POST /invoices/exports: zakres filtrowania wykracza poza dostepny zakres danych",
        ),
      );
    const client = { exportInvoices } as unknown as KsefClient;
    const config = createConfig(path.join(tmpDir, "storage"), {
      minExportWindowSeconds: 300,
      initialSyncFrom: "2026-02-01T00:00:00Z",
    });
    const deps = createRunnerDeps(client, config, createLogger(), store);
    const runExport = (forceRedownloadAll = false) =>
      syncSubjectType(
        deps,
        "ACCESS",
        nip,
        "Subject1",
        undefined,
        false,
        forceRedownloadAll,
        false,
        path.join(tmpDir, "scratch"),
      );
    return { tmpDir, dbPath, store, exportInvoices, runExport };
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tmpDirs.splice(0).map(async (dir) => {
        await fs.chmod(path.join(dir, "db", "state.sqlite"), 0o600).catch(
          () => undefined,
        );
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
  });

  it("reads the cursor without rewriting an existing DB, for plain and redownload-all runs", async () => {
    const t = await setup();
    await t.store.withDb((db) =>
      setContinuationPoint(db, nip, "Subject1", priorCursor),
    );
    const bytesBefore = await fs.readFile(t.dbPath);
    const mtimeBefore = (await fs.stat(t.dbPath)).mtimeMs;
    const open = vi.spyOn(fs, "open");
    const writeFile = vi.spyOn(fs, "writeFile");
    const rename = vi.spyOn(fs, "rename");

    await t.runExport();
    await t.runExport(true);

    expect(t.exportInvoices).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect((await fs.stat(t.dbPath)).mtimeMs).toBe(mtimeBefore);
    expect(Buffer.compare(await fs.readFile(t.dbPath), bytesBefore)).toBe(0);
    // Windowing came from the stored cursor, read without a write.
    expect(JSON.stringify(t.exportInvoices.mock.calls[0])).toContain(
      "2026-04-01",
    );
  });

  it.skipIf(canWriteDespiteMode)(
    "exports when the canonical DB exists but is read-only",
    async () => {
      const t = await setup();
      await t.store.withDb((db) =>
        setContinuationPoint(db, nip, "Subject1", priorCursor),
      );
      await fs.chmod(t.dbPath, 0o400);

      await expect(t.runExport()).resolves.toMatchObject({ failed: 0 });
      expect(t.exportInvoices).toHaveBeenCalledTimes(1);
    },
  );

  it("treats a missing DB as no cursor and does not create it", async () => {
    const t = await setup();

    await t.runExport();

    expect(t.exportInvoices).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.dirname(t.dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
