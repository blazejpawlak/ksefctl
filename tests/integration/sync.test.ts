import AdmZip from "adm-zip";
import keytar from "keytar";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContext } from "../../src/cli/context";
import { SyncService } from "../../src/core/syncService";
import { encryptAes256Cbc, sha256Base64 } from "../../src/utils/crypto";

const baseUrl = "http://localhost/v2";
const serviceName = "ksefctl-test";
const nip = "1234567890";

type ExportState = {
  encryptedPart?: Buffer;
  decryptedPartHash?: string;
  encryptedPartHash?: string;
  referenceNumber?: string;
};

describe("integration sync", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyDer = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const exportState: ExportState = {};

  const server = setupServer(
    http.post(`${baseUrl}/auth/challenge`, () => {
      return HttpResponse.json({
        challenge: "abc",
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
      });
    }),
    http.get(`${baseUrl}/security/public-key-certificates`, () => {
      return HttpResponse.json([
        {
          certificate: publicKeyDer,
          validFrom: new Date().toISOString(),
          validTo: new Date(Date.now() + 86400000).toISOString(),
          usage: ["KsefTokenEncryption", "SymmetricKeyEncryption"],
        },
      ]);
    }),
    http.post(`${baseUrl}/auth/ksef-token`, () => {
      return HttpResponse.json({
        referenceNumber: "REF-1",
        authenticationToken: {
          token: "AUTH-TOKEN",
          validUntil: new Date().toISOString(),
        },
      });
    }),
    http.get(`${baseUrl}/auth/REF-1`, () => {
      return HttpResponse.json({ status: { code: 200, description: "OK" } });
    }),
    http.post(`${baseUrl}/auth/token/redeem`, () => {
      return HttpResponse.json({
        accessToken: {
          token: "ACCESS",
          validUntil: new Date(Date.now() + 3600000).toISOString(),
        },
        refreshToken: {
          token: "REFRESH",
          validUntil: new Date(Date.now() + 86400000).toISOString(),
        },
      });
    }),
    http.post(`${baseUrl}/invoices/exports`, async ({ request }) => {
      const body = (await request.json()) as {
        encryption: {
          encryptedSymmetricKey: string;
          initializationVector: string;
        };
      };
      const encryptedKey = Buffer.from(
        body.encryption.encryptedSymmetricKey,
        "base64",
      );
      const key = crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        encryptedKey,
      );
      const iv = Buffer.from(body.encryption.initializationVector, "base64");

      const zip = new AdmZip();
      const ksefNumber = "KSEF-TEST-1";
      zip.addFile(
        `${ksefNumber}.xml`,
        Buffer.from(
          "<Faktura><Podmiot1><DaneIdentyfikacyjne><Nazwa>ACME Sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1><Fa><P_2>FV/1/2026</P_2></Fa></Faktura>",
          "utf-8",
        ),
      );
      zip.addFile(
        "_metadata.json",
        Buffer.from(
          JSON.stringify({
            invoices: [
              {
                ksefNumber,
                permanentStorageDate: new Date().toISOString(),
                invoiceNumber: "FV/1/2026",
                seller: { name: "ACME Sp. z o.o." },
              },
            ],
          }),
        ),
      );
      const zipBuffer = zip.toBuffer();
      const encrypted = encryptAes256Cbc(key, iv, zipBuffer);
      exportState.encryptedPart = encrypted;
      exportState.decryptedPartHash = sha256Base64(zipBuffer);
      exportState.encryptedPartHash = sha256Base64(encrypted);
      exportState.referenceNumber = "EXPORT-1";
      return HttpResponse.json(
        { referenceNumber: "EXPORT-1" },
        { status: 201 },
      );
    }),
    http.get(`${baseUrl}/invoices/exports/EXPORT-1`, () => {
      return HttpResponse.json({
        status: { code: 200, description: "OK" },
        package: {
          invoiceCount: 1,
          size: exportState.encryptedPart?.length ?? 0,
          isTruncated: false,
          permanentStorageHwmDate: new Date().toISOString(),
          parts: [
            {
              ordinalNumber: 1,
              partName: "part1.zip.aes",
              method: "GET",
              url: `${baseUrl}/storage/part1`,
              partHash: exportState.decryptedPartHash,
              encryptedPartHash: exportState.encryptedPartHash,
            },
          ],
        },
      });
    }),
    http.get(`${baseUrl}/storage/part1`, () => {
      return new HttpResponse(exportState.encryptedPart ?? new Uint8Array(), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("runs a happy path sync and writes files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const configYaml = YAML.stringify({
      environment: "test",
      apiBaseUrl: baseUrl,
      auth: {
        method: "ksefToken",
        keychainServiceName: serviceName,
      },
      organizations: [{ nip }],
      pollingIntervalSeconds: 300,
      storage: { root: path.join(tmpDir, "storage") },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: {
        level: "info",
        file: path.join(tmpDir, "storage", "logs", "app.log"),
        pretty: false,
      },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 5,
        allowInsecureHttp: true,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
      },
    });
    await fs.writeFile(configPath, configYaml, "utf-8");

    await keytar.setPassword(
      serviceName,
      `test:nip:${nip}`,
      JSON.stringify({ ksefToken: "TOKEN" }),
    );

    try {
      const ctx = await createContext(configPath);
      const sync = new SyncService(
        ctx.client,
        ctx.auth,
        ctx.config,
        ctx.logger,
        ctx.store,
      );
      const result = await sync.runOnce();

      expect(result.downloaded).toBe(1);
      expect(result.items[0]?.ksefNumber).toBe("KSEF-TEST-1");
      expect(result.items[0]?.nip).toBe(nip);

      const invoicePath = result.items[0]?.path ?? "";
      const xmlPath = path.join(invoicePath, "Faktura nr FV-1-2026.xml");
      const xml = await fs.readFile(xmlPath, "utf-8");
      expect(xml).toContain("P_2");
    } finally {
      await keytar.deletePassword(serviceName, `test:nip:${nip}`);
    }
  });

  it("runs a flat sync and writes files into monthly folders", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-sync-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const configYaml = YAML.stringify({
      environment: "test",
      apiBaseUrl: baseUrl,
      auth: {
        method: "ksefToken",
        keychainServiceName: serviceName,
      },
      organizations: [{ nip }],
      pollingIntervalSeconds: 300,
      storage: { root: path.join(tmpDir, "storage") },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: {
        level: "info",
        file: path.join(tmpDir, "storage", "logs", "app.log"),
        pretty: false,
      },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 5,
        allowInsecureHttp: true,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        generatePdf: false,
      },
    });
    await fs.writeFile(configPath, configYaml, "utf-8");

    await keytar.setPassword(
      serviceName,
      `test:nip:${nip}`,
      JSON.stringify({ ksefToken: "TOKEN" }),
    );

    try {
      const ctx = await createContext(configPath);
      const sync = new SyncService(
        ctx.client,
        ctx.auth,
        ctx.config,
        ctx.logger,
        ctx.store,
      );
      const result = await sync.runOnce(undefined, undefined, false, true);

      expect(result.downloaded).toBe(1);
      expect(result.items[0]?.path).toMatch(
        /invoices\/1234567890\/\d{4}\/\d{2}$/,
      );

      const invoicePath = result.items[0]?.path ?? "";
      const xmlPath = path.join(invoicePath, "ACME Sp. z o.o - FV-1-2026.xml");
      const metadataPath = path.join(
        invoicePath,
        "ACME Sp. z o.o - FV-1-2026.metadata.json",
      );
      const xml = await fs.readFile(xmlPath, "utf-8");
      const metadata = await fs.readFile(metadataPath, "utf-8");

      expect(xml).toContain("P_2");
      expect(metadata).toContain("\"ksefNumber\": \"KSEF-TEST-1\"");
    } finally {
      await keytar.deletePassword(serviceName, `test:nip:${nip}`);
    }
  });
});
