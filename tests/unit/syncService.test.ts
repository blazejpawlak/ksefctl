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
import {
  getContinuationPoint,
  getInvoice,
  getSyncState,
  upsertInvoice,
} from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto";

const testKey = Buffer.alloc(32, 1);
const testIv = Buffer.alloc(16, 2);

vi.mock("../../src/core/encryption", () => ({
  createEncryptionData: vi.fn().mockResolvedValue({
    key: Buffer.alloc(32, 1),
    iv: Buffer.alloc(16, 2),
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

type ConfigOverrides = Omit<
  Partial<AppConfig>,
  | "auth"
  | "storage"
  | "notifications"
  | "logging"
  | "operational"
  | "security"
  | "sync"
> & {
  auth?: Partial<AppConfig["auth"]>;
  storage?: Partial<AppConfig["storage"]>;
  notifications?: Partial<AppConfig["notifications"]>;
  logging?: Partial<AppConfig["logging"]>;
  operational?: Partial<AppConfig["operational"]>;
  security?: Partial<AppConfig["security"]>;
  sync?: Partial<AppConfig["sync"]>;
};

const createConfig = (overrides: ConfigOverrides = {}): AppConfig => {
  const base: AppConfig = {
    environment: "test",
    apiBaseUrl: "http://localhost/v2",
    auth: { method: "ksefToken", keychainServiceName: "ksefctl-test" },
    organizations: [{ nip: "1234567890" }],
    pollingIntervalSeconds: 300,
    storage: { root: "/tmp/ksef" },
    notifications: { macosNotification: false, email: { enabled: false } },
    logging: {
      level: "info",
      file: "/tmp/ksef/logs/app.log",
      pretty: false,
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
      allowedHosts: [],
    },
    sync: {
      subjectTypes: ["Subject1"],
      includeMetadataHeader: true,
      generatePdf: false,
      flatSync: false,
      maxConcurrentNips: 1,
    },
  };

  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...overrides.auth },
    storage: { ...base.storage, ...overrides.storage },
    notifications: {
      ...base.notifications,
      ...overrides.notifications,
      email: {
        ...base.notifications.email,
        ...overrides.notifications?.email,
      },
    },
    logging: { ...base.logging, ...overrides.logging },
    operational: {
      ...base.operational,
      ...overrides.operational,
      retry: {
        ...base.operational.retry,
        ...overrides.operational?.retry,
      },
    },
    security: {
      ...base.security,
      ...overrides.security,
      tls: {
        ...base.security.tls,
        ...overrides.security?.tls,
      },
      allowedHosts:
        overrides.security?.allowedHosts ?? base.security.allowedHosts,
    },
    sync: { ...base.sync, ...overrides.sync },
  };
};

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

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

describe("SyncService", () => {
  it("serializes configured NIPs when maxConcurrentNips is one", async () => {
    const store = new SqliteStore(":memory:");
    const logger = createLogger();
    const deferredA = createDeferred<{
      accessToken: string;
      accessTokenValidUntil: string;
      refreshToken: string;
      refreshTokenValidUntil: string;
    }>();
    const deferredB = createDeferred<{
      accessToken: string;
      accessTokenValidUntil: string;
      refreshToken: string;
      refreshTokenValidUntil: string;
    }>();
    const getAccessToken = vi.fn((nip: string) => {
      if (nip === "1234567890") return deferredA.promise;
      if (nip === "9876543210") return deferredB.promise;
      throw new Error(`Unexpected NIP ${nip}`);
    });
    const auth = {
      getAccessToken,
    } as unknown as AuthService;
    const client = {} as KsefClient;
    const config = createConfig({
      organizations: [{ nip: "1234567890" }, { nip: "9876543210" }],
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        maxConcurrentNips: 1,
      },
    });

    const service = new SyncService({ client, auth, config, logger, store });
    const runPromise = service.runOnce();

    await vi.waitFor(() => {
      expect(getAccessToken).toHaveBeenCalledTimes(1);
    });

    deferredA.resolve({
      accessToken: "ACCESS-A",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    });

    await vi.waitFor(() => {
      expect(getAccessToken).toHaveBeenCalledTimes(2);
    });

    deferredB.resolve({
      accessToken: "ACCESS-B",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    });

    await expect(runPromise).resolves.toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    });
  });

  it("syncs configured NIPs in parallel when maxConcurrentNips is greater than one", async () => {
    const store = new SqliteStore(":memory:");
    const logger = createLogger();
    const deferredA = createDeferred<{
      accessToken: string;
      accessTokenValidUntil: string;
      refreshToken: string;
      refreshTokenValidUntil: string;
    }>();
    const deferredB = createDeferred<{
      accessToken: string;
      accessTokenValidUntil: string;
      refreshToken: string;
      refreshTokenValidUntil: string;
    }>();
    const getAccessToken = vi.fn((nip: string) => {
      if (nip === "1234567890") return deferredA.promise;
      if (nip === "9876543210") return deferredB.promise;
      throw new Error(`Unexpected NIP ${nip}`);
    });
    const auth = {
      getAccessToken,
    } as unknown as AuthService;
    const client = {} as KsefClient;
    const config = createConfig({
      organizations: [{ nip: "1234567890" }, { nip: "9876543210" }],
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        maxConcurrentNips: 2,
      },
    });

    const service = new SyncService({ client, auth, config, logger, store });
    const runPromise = service.runOnce();

    await vi.waitFor(() => {
      expect(getAccessToken).toHaveBeenCalledTimes(2);
    });

    deferredA.resolve({
      accessToken: "ACCESS-A",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    });
    deferredB.resolve({
      accessToken: "ACCESS-B",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    });

    await expect(runPromise).resolves.toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    });
  });

  it("redownload-all applies to all configured NIPs when nip is not provided", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const initialSyncFrom = "2026-02-01T00:00:00.000Z";
    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 0,
          size: 0,
          isTruncated: false,
          permanentStorageHwmDate: new Date().toISOString(),
          parts: [],
        },
      }),
    } as unknown as KsefClient;
    const getAccessToken = vi.fn().mockResolvedValue({
      accessToken: "ACCESS",
      accessTokenValidUntil: "",
      refreshToken: "",
      refreshTokenValidUntil: "",
    });
    const auth = {
      getAccessToken,
    } as unknown as AuthService;
    const config = createConfig({
      organizations: [{ nip: "1234567890" }, { nip: "9876543210" }],
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
        initialSyncFrom,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();

    const service = new SyncService({ client, auth, config, logger, store });
    await service.runOnce(undefined, undefined, true);

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenCalledWith("1234567890");
    expect(getAccessToken).toHaveBeenCalledWith("9876543210");
    expect(exportInvoices.mock.calls.length).toBeGreaterThanOrEqual(2);

    const requests = exportInvoices.mock.calls.map(
      ([, request]) =>
        request as { filters?: { dateRange?: { from?: string; to?: string } } },
    );
    const fromDates = requests.map(
      (request) => request.filters?.dateRange?.from,
    );
    const toDates = requests.map((request) => request.filters?.dateRange?.to);

    expect(
      fromDates.filter((value) => value === initialSyncFrom).length,
    ).toBeGreaterThanOrEqual(2);
    expect(toDates.length).toBe(exportInvoices.mock.calls.length);
    expect(toDates.every((value) => Boolean(value))).toBe(true);
  });

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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
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

  it("stores direct downloads in flat monthly folders when flat sync is enabled", async () => {
    const now = new Date("2026-02-15T08:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const client = {
      downloadInvoiceXml: vi.fn().mockResolvedValue(`
        <Faktura>
          <Podmiot1>
            <DaneIdentyfikacyjne>
              <Nazwa>ACME Sp. z o.o.</Nazwa>
            </DaneIdentyfikacyjne>
          </Podmiot1>
          <Fa><P_2>FV/1:2026?</P_2></Fa>
        </Faktura>
      `),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    await service.runOnce("KSEF-INV-1", undefined, false, true);

    const invoiceDir = path.join(
      config.storage.root,
      "invoices",
      "1234567890",
      "2026",
      "02",
    );
    const xmlPath = path.join(invoiceDir, "ACME Sp. z o.o - FV-1-2026-.xml");
    const metadataPath = path.join(
      invoiceDir,
      "ACME Sp. z o.o - FV-1-2026-.metadata.json",
    );

    await expect(fs.readFile(xmlPath, "utf-8")).resolves.toContain(
      "FV/1:2026?",
    );
    await expect(fs.readFile(metadataPath, "utf-8")).resolves.toMatch(
      /"ksefNumber": "KSEF-INV-1"/,
    );
  });

  it("uses config flat sync and per-nip output path by default", async () => {
    const now = new Date("2026-02-15T08:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const outputPath = path.join(tmpDir, "exports", "org-a");
    const client = {
      downloadInvoiceXml: vi.fn().mockResolvedValue(`
        <Faktura>
          <Podmiot1>
            <DaneIdentyfikacyjne>
              <Nazwa>Config Seller</Nazwa>
            </DaneIdentyfikacyjne>
          </Podmiot1>
          <Fa><P_2>CFG/1</P_2></Fa>
        </Faktura>
      `),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      organizations: [{ nip: "1234567890", outputPath }],
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        flatSync: true,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce("KSEF-CONFIG-1");

    expect(result.items[0]?.path).toBe(path.join(outputPath, "2026", "02"));
    await expect(
      fs.readFile(
        path.join(outputPath, "2026", "02", "Config Seller - CFG-1.xml"),
        "utf-8",
      ),
    ).resolves.toContain("CFG/1");
  });

  it("prefers cli output path override over per-nip config output path", async () => {
    const now = new Date("2026-02-15T08:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const configOutputPath = path.join(tmpDir, "exports", "config");
    const cliOutputPath = path.join(tmpDir, "exports", "cli");
    const client = {
      downloadInvoiceXml: vi.fn().mockResolvedValue(`
        <Faktura>
          <Podmiot1>
            <DaneIdentyfikacyjne>
              <Nazwa>CLI Seller</Nazwa>
            </DaneIdentyfikacyjne>
          </Podmiot1>
          <Fa><P_2>CLI/1</P_2></Fa>
        </Faktura>
      `),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      organizations: [{ nip: "1234567890", outputPath: configOutputPath }],
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        flatSync: true,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce(
      "KSEF-CLI-1",
      "1234567890",
      false,
      undefined,
      cliOutputPath,
    );

    expect(result.items[0]?.path).toBe(path.join(cliOutputPath, "2026", "02"));
    await expect(
      fs.readFile(
        path.join(cliOutputPath, "2026", "02", "CLI Seller - CLI-1.xml"),
        "utf-8",
      ),
    ).resolves.toContain("CLI/1");
    await expect(
      fs.stat(
        path.join(configOutputPath, "2026", "02", "CLI Seller - CLI-1.xml"),
      ),
    ).rejects.toThrow();
  });

  it("suffixes KSeF number only when flat sync file names collide", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const zip = new AdmZip();
    zip.addFile(
      "KSEF-COLLIDE-1.xml",
      Buffer.from(
        "<Faktura><Podmiot1><DaneIdentyfikacyjne><Nazwa>XML Seller</Nazwa></DaneIdentyfikacyjne></Podmiot1><Fa><P_2>XML/1</P_2></Fa></Faktura>",
      ),
    );
    zip.addFile(
      "KSEF-COLLIDE-2.xml",
      Buffer.from(
        "<Faktura><Podmiot1><DaneIdentyfikacyjne><Nazwa>XML Seller</Nazwa></DaneIdentyfikacyjne></Podmiot1><Fa><P_2>XML/1</P_2></Fa></Faktura>",
      ),
    );
    zip.addFile(
      "_metadata.json",
      Buffer.from(
        JSON.stringify({
          invoices: [
            {
              ksefNumber: "KSEF-COLLIDE-1",
              invoiceNumber: "FV/1",
              permanentStorageDate: now.toISOString(),
              seller: { name: "ACME Seller" },
            },
            {
              ksefNumber: "KSEF-COLLIDE-2",
              invoiceNumber: "FV/1",
              permanentStorageDate: now.toISOString(),
              seller: { name: "ACME Seller" },
            },
          ],
        }),
      ),
    );
    const zipBuffer = zip.toBuffer();
    const encrypted = encryptAes256Cbc(testKey, testIv, zipBuffer);
    const partHash = sha256Base64(zipBuffer);
    const encryptedPartHash = sha256Base64(encrypted);
    const client = {
      exportInvoices: vi
        .fn()
        .mockResolvedValue({ referenceNumber: "EXPORT-1" }),
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 2,
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    await service.runOnce(undefined, undefined, false, true);

    const invoiceDir = path.join(
      config.storage.root,
      "invoices",
      "1234567890",
      "2026",
      "05",
    );

    await expect(
      fs.readFile(path.join(invoiceDir, "ACME Seller - FV-1.xml"), "utf-8"),
    ).resolves.toContain("XML/1");
    await expect(
      fs.readFile(
        path.join(invoiceDir, "ACME Seller - FV-1 - KSEF-COLLIDE-2.xml"),
        "utf-8",
      ),
    ).resolves.toContain("XML/1");
  });

  it("directly downloads redownload invoices when a nip filter is set", async () => {
    const now = new Date("2026-02-15T08:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const downloadInvoiceXml = vi
      .fn()
      .mockResolvedValue("<Faktura><P_2>FV/1</P_2></Faktura>");
    const client = {
      downloadInvoiceXml,
    } as unknown as KsefClient;
    const config = createConfig({
      organizations: [{ nip: "1234567890" }, { nip: "9876543210" }],
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce("KSEF-INV-1", "1234567890");

    expect(downloadInvoiceXml).toHaveBeenCalledTimes(1);
    expect(downloadInvoiceXml).toHaveBeenCalledWith("ACCESS", "KSEF-INV-1");
    expect(result.items).toEqual([
      expect.objectContaining({
        nip: "1234567890",
        ksefNumber: "KSEF-INV-1",
      }),
    ]);
  });

  it("returns payment-notification metadata for direct downloads", async () => {
    const now = new Date("2026-03-24T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne><NIP>5261040337</NIP></DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne><NIP>1234567890</NIP></DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <P_2>FV/1</P_2>
          <Platnosc>
            <TerminPlatnosci><Termin>2026-03-24</Termin></TerminPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;
    const client = {
      downloadInvoiceXml: vi.fn().mockResolvedValue(xml),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: [],
        includeMetadataHeader: true,
        generatePdf: false,
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce("KSEF-INV-1");

    expect(result.items).toEqual([
      expect.objectContaining({
        nip: "1234567890",
        ksefNumber: "KSEF-INV-1",
        dueDate: "2026-03-24",
        needsPaymentNotification: true,
      }),
    ]);
  });

  it("returns payment-notification metadata for exported invoices", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const ksefNumber = "KSEF-PAYABLE-1";
    const xml = `
      <Faktura>
        <Podmiot1>
          <DaneIdentyfikacyjne><NIP>5261040337</NIP></DaneIdentyfikacyjne>
        </Podmiot1>
        <Podmiot2>
          <DaneIdentyfikacyjne><NIP>1234567890</NIP></DaneIdentyfikacyjne>
        </Podmiot2>
        <Fa>
          <P_2>FV/EXPORT/1</P_2>
          <Platnosc>
            <TerminPlatnosci><Termin>2026-03-24</Termin></TerminPlatnosci>
          </Platnosc>
        </Fa>
      </Faktura>
    `;
    const { encrypted, partHash, encryptedPartHash } = buildEncryptedPackage(
      ksefNumber,
      xml,
    );

    const client = {
      exportInvoices: vi
        .fn()
        .mockResolvedValue({ referenceNumber: "EXPORT-1" }),
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce();

    expect(result.items).toEqual([
      expect.objectContaining({
        nip: "1234567890",
        ksefNumber,
        dueDate: "2026-03-24",
        needsPaymentNotification: true,
      }),
    ]);
  });

  it("advances continuation point after partial export failures", async () => {
    const now = new Date("2026-05-10T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const zip = new AdmZip();
    zip.addFile(
      "KSEF-GOOD.xml",
      Buffer.from("<Faktura><P_2>GOOD</P_2></Faktura>"),
    );
    zip.addFile(
      "KSEF-BAD.xml",
      Buffer.from("<Faktura><P_2>BAD</P_2></Faktura>"),
    );
    const zipBuffer = zip.toBuffer();
    const encrypted = encryptAes256Cbc(testKey, testIv, zipBuffer);
    const partHash = sha256Base64(zipBuffer);
    const encryptedPartHash = sha256Base64(encrypted);
    const exportInvoices = vi
      .fn()
      .mockResolvedValue({ referenceNumber: "EXPORT-1" });
    const client = {
      exportInvoices,
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
      getExportStatus: vi.fn().mockResolvedValue({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 2,
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();
    const originalWriteFile = fs.writeFile.bind(fs);
    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args) => {
        const filePath = args[0];
        if (
          typeof filePath === "string" &&
          filePath.includes("KSEF-BAD") &&
          filePath.endsWith(".tmp")
        ) {
          throw new Error(
            "HTTP 500 GET /download: token=secret response body (requestId=req-1)",
          );
        }
        return originalWriteFile(...args);
      });

    const service = new SyncService({ client, auth, config, logger, store });
    const firstRun = await service.runOnce();
    const failedInvoice = await store.withDb((db) =>
      getInvoice(db, "1234567890", "KSEF-BAD"),
    );
    const continuation = await store.withDb((db) =>
      getContinuationPoint(db, "1234567890", "Subject1" as SubjectType),
    );
    const secondRun = await service.runOnce();
    writeFileSpy.mockRestore();

    expect(firstRun.downloaded).toBe(1);
    expect(firstRun.failed).toBe(1);
    expect(failedInvoice?.error).toBe(
      "HTTP 500 GET /download (requestId=req-1)",
    );
    expect(continuation).toBe(now.toISOString());
    expect(exportInvoices).toHaveBeenCalledTimes(1);
    expect(secondRun).toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    });
  });

  it("stores sanitized sync errors when a run fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const client = {
      exportInvoices: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "HTTP 500 POST /invoices/exports: raw upstream response (requestId=req-2)",
          ),
        ),
      getPublicKeyCertificates: vi.fn().mockResolvedValue([]),
    } as unknown as KsefClient;
    const config = createConfig({
      storage: { root: path.join(tmpDir, "storage") },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
        initialSyncFrom: "2026-02-01T00:00:00Z",
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });

    await expect(service.runOnce()).rejects.toThrow(
      "HTTP 500 POST /invoices/exports: raw upstream response (requestId=req-2)",
    );

    const syncState = await store.withDb((db) => getSyncState(db));
    expect(syncState.last_error).toBe(
      "HTTP 500 POST /invoices/exports (requestId=req-2)",
    );
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
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
        maxConcurrentNips: 1,
      },
    });
    const logger = createLogger();
    const auth = createAuth();

    const service = new SyncService({ client, auth, config, logger, store });
    const result = await service.runOnce();

    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(exportInvoices).toHaveBeenCalledTimes(1);
  });
});
