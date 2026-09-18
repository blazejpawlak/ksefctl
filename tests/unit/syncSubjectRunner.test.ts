import type { KsefClient } from "../../src/api/ksefClient";
import type { AppConfig } from "../../src/config/schema";
import type { PdfService } from "../../src/services/pdfService";
import type { Logger } from "pino";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncSubjectType } from "../../src/core/syncSubjectRunner";
import {
  getContinuationPoint,
  setContinuationPoint,
} from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto";

const testKey = Buffer.alloc(32, 3);
const testIv = Buffer.alloc(16, 4);

vi.mock("../../src/core/encryption", () => ({
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
