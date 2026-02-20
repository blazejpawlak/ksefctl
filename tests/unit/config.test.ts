import { describe, expect, it } from "vitest";
import YAML from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, sanitizeConfig } from "../../src/config/loadConfig";
import { AppConfigSchema } from "../../src/config/schema";

describe("config schema", () => {
  it("validates a minimal config", () => {
    const config = AppConfigSchema.parse({
      environment: "test",
      auth: {
        method: "ksefToken",
        keychainServiceName: "ksefctl",
      },
      organizations: [{ nip: "1234567890" }],
      pollingIntervalSeconds: 300,
      storage: { root: "/tmp/ksef" },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: { level: "info", file: "/tmp/ksef/logs/app.log", pretty: false },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });

    expect(config.environment).toBe("test");
  });

  it("fails when organization NIP invalid", () => {
    expect(() =>
      AppConfigSchema.parse({
        environment: "test",
        auth: { method: "ksefToken" },
        organizations: [{ nip: "ABC" }],
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
          pollIntervalSeconds: 10,
        },
        security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
        sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
      }),
    ).toThrow();
  });

  it("maps integ to test via loader", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const yaml = YAML.stringify({
      environment: "integ",
      auth: {
        method: "ksefToken",
        keychainServiceName: "ksefctl",
      },
      organizations: [{ nip: "1234567890" }],
      pollingIntervalSeconds: 300,
      storage: { root: "/tmp/ksef" },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: { level: "info", file: "/tmp/ksef/logs/app.log", pretty: false },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });
    await fs.writeFile(configPath, yaml, "utf-8");
    const loaded = await loadConfig(configPath);
    expect(loaded.environment).toBe("test");
  });

  it("redacts sensitive fields", () => {
    const sanitized = sanitizeConfig(
      AppConfigSchema.parse({
        environment: "test",
        auth: {
          method: "ksefToken",
          keychainServiceName: "ksefctl",
        },
        organizations: [{ nip: "1234567890" }],
        pollingIntervalSeconds: 300,
        storage: { root: "/tmp/ksef" },
        notifications: {
          macosNotification: false,
          email: {
            enabled: false,
            smtp: {
              host: "smtp",
              port: 587,
              user: "user",
              pass: "pass",
              from: "from@example.com",
              to: ["to@example.com"],
              secure: false,
              tlsRejectUnauthorized: true,
            },
          },
        },
        logging: {
          level: "info",
          file: "/tmp/ksef/logs/app.log",
          pretty: false,
        },
        operational: {
          maxConcurrency: 2,
          timeoutSeconds: 60,
          pollIntervalSeconds: 10,
        },
        security: {
          tls: { enablePinning: false, pins: [], pinningHosts: [] },
          allowedHosts: [],
        },
        sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
      }),
    );

    const auth = sanitized.auth as Record<string, unknown>;
    expect(auth.keychainServiceName).toBe("***");
  });
});
