import type { KsefClient } from "../../src/api/ksefClient";
import type { AppConfig } from "../../src/config/schema";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  downloadAndDecryptParts,
  waitForExport,
} from "../../src/core/invoicePackageClient";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto";

const makeLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const baseConfig = (): AppConfig =>
  ({
    environment: "test",
    apiBaseUrl: "http://localhost/v2",
    organizations: [],
    operational: {
      exportPollMaxAttempts: 3,
      pollIntervalSeconds: 1,
      allowInsecureHttp: true,
    },
    security: {
      allowedHosts: [],
      tls: { enablePinning: false, pins: [], pinningHosts: [] },
    },
    sync: { flatSync: false },
  }) as unknown as AppConfig;

const makeClient = (overrides: Partial<KsefClient> = {}): KsefClient =>
  overrides as unknown as KsefClient;

const testKey = Buffer.alloc(32, 1);
const testIv = Buffer.alloc(16, 2);

describe("waitForExport", () => {
  it("returns status on first 2xx response", async () => {
    const statusOk = {
      status: { code: 200, description: "Ready" },
      package: { parts: [] },
    };
    const getExportStatus = vi.fn().mockResolvedValue(statusOk);
    const client = makeClient({
      getExportStatus,
    });
    const deps = {
      client,
      config: baseConfig(),
      logger: makeLogger(),
      reportProgress: vi.fn(),
      sleepWithProgress: vi.fn().mockResolvedValue(undefined),
    };
    const result = await waitForExport(deps, "token", "ref-1");
    expect(result).toBe(statusOk);
    expect(getExportStatus).toHaveBeenCalledOnce();
  });

  it("polls until 2xx after initial pending responses", async () => {
    const pending = { status: { code: 100, description: "Pending" } };
    const ready = {
      status: { code: 200, description: "Ready" },
      package: { parts: [] },
    };
    const getExportStatus = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(ready);
    const client = makeClient({
      getExportStatus,
    });
    const deps = {
      client,
      config: baseConfig(),
      logger: makeLogger(),
      reportProgress: vi.fn(),
      sleepWithProgress: vi.fn().mockResolvedValue(undefined),
    };
    const result = await waitForExport(deps, "token", "ref-1");
    expect(result).toBe(ready);
    expect(getExportStatus).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on 4xx response", async () => {
    const getExportStatus = vi.fn().mockResolvedValue({
      status: { code: 400, description: "Bad request" },
    });
    const client = makeClient({ getExportStatus });
    const deps = {
      client,
      config: baseConfig(),
      logger: makeLogger(),
      reportProgress: vi.fn(),
      sleepWithProgress: vi.fn().mockResolvedValue(undefined),
    };
    await expect(waitForExport(deps, "token", "ref-1")).rejects.toThrow(
      "Export failed: Bad request",
    );
  });

  it("throws after exhausting max attempts", async () => {
    const getExportStatus = vi.fn().mockResolvedValue({
      status: { code: 102, description: "Still waiting" },
    });
    const client = makeClient({ getExportStatus });
    const config = baseConfig();
    config.operational.exportPollMaxAttempts = 2;
    const deps = {
      client,
      config,
      logger: makeLogger(),
      reportProgress: vi.fn(),
      sleepWithProgress: vi.fn().mockResolvedValue(undefined),
    };
    await expect(waitForExport(deps, "token", "ref-1")).rejects.toThrow(
      "Export status polling timed out",
    );
    expect(getExportStatus).toHaveBeenCalledTimes(2);
  });
});

describe("downloadAndDecryptParts", () => {
  const makePart = (data: Buffer) => {
    const encrypted = encryptAes256Cbc(testKey, testIv, data);
    return {
      ordinalNumber: 1,
      url: "http://localhost/part1",
      method: "GET",
      partName: "part1",
      encryptedPartHash: sha256Base64(encrypted),
      partHash: sha256Base64(data),
      encrypted,
    };
  };

  it("decrypts and returns concatenated part", async () => {
    const payload = Buffer.from("invoice-data");
    const part = makePart(payload);
    const client = makeClient({
      downloadPackagePart: vi.fn().mockResolvedValue(part.encrypted),
    });
    const parts = [
      {
        ordinalNumber: part.ordinalNumber,
        url: part.url,
        method: part.method,
        partName: part.partName,
        encryptedPartHash: part.encryptedPartHash,
        partHash: part.partHash,
      },
    ];
    const result = await downloadAndDecryptParts(
      { client, config: baseConfig() },
      parts,
      testKey,
      testIv,
    );
    expect(result).toEqual(payload);
  });

  it("throws on disallowed host", async () => {
    const config = baseConfig();
    config.security.allowedHosts = ["trusted.host"];
    const parts = [
      {
        ordinalNumber: 1,
        url: "http://evil.host/part1",
        method: "GET",
        partName: "part1",
      },
    ];
    await expect(
      downloadAndDecryptParts(
        { client: makeClient(), config },
        parts,
        testKey,
        testIv,
      ),
    ).rejects.toThrow("Disallowed download host");
  });

  it("throws on encrypted hash mismatch", async () => {
    const payload = Buffer.from("data");
    const encrypted = encryptAes256Cbc(testKey, testIv, payload);
    const client = makeClient({
      downloadPackagePart: vi.fn().mockResolvedValue(encrypted),
    });
    const parts = [
      {
        ordinalNumber: 1,
        url: "http://localhost/part1",
        method: "GET",
        partName: "part1",
        encryptedPartHash: "wrong-hash",
      },
    ];
    await expect(
      downloadAndDecryptParts(
        { client, config: baseConfig() },
        parts,
        testKey,
        testIv,
      ),
    ).rejects.toThrow("Encrypted part hash mismatch");
  });

  it("throws on decrypted hash mismatch", async () => {
    const payload = Buffer.from("data");
    const encrypted = encryptAes256Cbc(testKey, testIv, payload);
    const client = makeClient({
      downloadPackagePart: vi.fn().mockResolvedValue(encrypted),
    });
    const parts = [
      {
        ordinalNumber: 1,
        url: "http://localhost/part1",
        method: "GET",
        partName: "part1",
        encryptedPartHash: sha256Base64(encrypted),
        partHash: "wrong-decrypted-hash",
      },
    ];
    await expect(
      downloadAndDecryptParts(
        { client, config: baseConfig() },
        parts,
        testKey,
        testIv,
      ),
    ).rejects.toThrow("Decrypted part hash mismatch");
  });
});
