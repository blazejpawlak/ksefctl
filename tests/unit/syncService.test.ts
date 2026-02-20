import type { KsefClient } from "../../src/api/ksefClient";
import type { AuthService } from "../../src/auth/authService";
import type { AppConfig, SubjectType } from "../../src/config/schema";
import type { Logger } from "pino";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncService } from "../../src/core/syncService";
import { getContinuationPoint, upsertInvoice } from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto";

const { testKey, testIv } = vi.hoisted(() => ({
  testKey: Buffer.alloc(32, 1),
  testIv: Buffer.alloc(16, 2),
}));

vi.mock("../../src/core/encryption", () => ({
  createEncryptionData: vi.fn().mockResolvedValue({
    key: testKey,
    iv: testIv,
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

const createConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  environment: "test",
  apiBaseUrl: "http://localhost/v2",
  auth: { method: "ksefToken", keychainServiceName: "ksefctl-test" },
  organizations: [{ nip: "1234567890" }],
  pollingIntervalSeconds: 300,
  storage: { root: "/tmp/ksef" },
  notifications: { macosNotification: false, email: { enabled: false } },
  logging: { level: "info", file: "/tmp/ksef/logs/app.log", pretty: false },
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
    allowedHosts: [],
  },
  sync: {
    subjectTypes: ["Subject1"],
    includeMetadataHeader: true,
    generatePdf: false,
  },
  ...overrides,
});

const createAuth = (): AuthService =>
  ({
    getAccessToken: vi.fn().mockResolvedValue({
      accessToken: "ACCESS",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    }),
  }) as unknown as AuthService;

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

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SyncService", () => {
  it("advances continuation point when export window is out of range", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const exportInvoices = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 400 POST /invoices/exports: zakres filtrowania wykracza poza dostepny zakres danych",
        ),
      );
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
        initialSyncFrom: "2026-02-01T00:00:00Z",
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService(client, auth, config, logger, store);
    await service.runOnce();

    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1" as SubjectType),
    );
    expect(continuation).toBe(now.toISOString());
    expect(exportInvoices).toHaveBeenCalledTimes(2);
  });

  it("uses sanitized invoice number for file names", async () => {
    const now = new Date("2026-02-15T08:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const client = {
      downloadInvoiceXml: vi
        .fn()
        .mockResolvedValue("<Faktura><P_2>FV/1:2026?</P_2></Faktura>"),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService(client, auth, config, logger, store);
    await service.runOnce("KSEF-INV-1");

    const invoiceDir = path.join(
      config.storage.root,
      "invoices",
      "1234567890",
      "2026",
      "02",
      "15",
      "KSEF-INV-1",
    );
    const filePath = path.join(invoiceDir, "Faktura nr FV-1-2026-.xml");
    const xml = await fs.readFile(filePath, "utf-8");
    expect(xml).toContain("FV/1:2026?");
  });

  it("re-downloads already downloaded invoices when forceRedownloadAll is set", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const ksefNumber = "KSEF-REDO-1";
    const initialSyncFrom = new Date(now.getTime() - 86400000).toISOString();

    await store.withDb((db) =>
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: ksefNumber,
        file_path: "existing",
        hash: "hash",
        status: "downloaded",
        downloaded_at: now.toISOString(),
        received_at: null,
        error: null,
      }),
    );

    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      "<Faktura><P_2>REDO</P_2></Faktura>",
    );

    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          permanentStorageHwmDate: now.toISOString(),
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
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      security: {
        tls: { enablePinning: false, pins: [], pinningHosts: [] },
        allowedHosts: ["example.test"],
      },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
        initialSyncFrom,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService(client, auth, config, logger, store);
    const result = await service.runOnce(undefined, undefined, true);
    const request = exportInvoices.mock.calls[0]?.[1] as
      | { filters?: { dateRange?: { from?: string; to?: string } } }
      | undefined;

    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(exportInvoices).toHaveBeenCalledTimes(1);
    expect(request?.filters?.dateRange?.from).toBe(initialSyncFrom);
    expect(request?.filters?.dateRange?.to).toBe(now.toISOString());
  });

  it("sets continuation point to KSeF start date when forceRedownloadAll has no initialSyncFrom", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const ksefNumber = "KSEF-REDO-BASE";

    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      "<Faktura><P_2>REDO</P_2></Faktura>",
    );

    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          permanentStorageHwmDate: now.toISOString(),
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
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      security: {
        tls: { enablePinning: false, pins: [], pinningHosts: [] },
        allowedHosts: ["example.test"],
      },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService(client, auth, config, logger, store);
    await service.runOnce(undefined, undefined, true);
    const request = exportInvoices.mock.calls[0]?.[1] as
      | { filters?: { dateRange?: { from?: string; to?: string } } }
      | undefined;

    expect(request?.filters?.dateRange?.from).toBe(
      new Date("2026-02-01T00:00:00Z").toISOString(),
    );
    expect(request?.filters?.dateRange?.to).toBe(
      new Date("2026-05-01T00:00:00Z").toISOString(),
    );
  });

  it("re-downloads invoices when files are missing on disk", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const ksefNumber = "KSEF-MISSING-1";

    await store.withDb((db) =>
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: ksefNumber,
        file_path: path.join(tmpDir, "storage", "invoices", "missing"),
        hash: "hash",
        status: "downloaded",
        downloaded_at: now.toISOString(),
        received_at: null,
        error: null,
      }),
    );

    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      "<Faktura><P_2>MISSING</P_2></Faktura>",
    );

    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: encrypted.length,
          isTruncated: false,
          permanentStorageHwmDate: now.toISOString(),
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
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      security: {
        tls: { enablePinning: false, pins: [], pinningHosts: [] },
        allowedHosts: ["example.test"],
      },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
        initialSyncFrom: new Date(now.getTime() - 86400000).toISOString(),
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService(client, auth, config, logger, store);
    const result = await service.runOnce();

    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(exportInvoices).toHaveBeenCalledTimes(1);
  });
});
