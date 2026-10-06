import { describe, expect, it } from "vitest";
import YAML from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, sanitizeConfig } from "../../src/config/loadConfig.js";
import { AppConfigSchema } from "../../src/config/schema.js";
import { ConfigError } from "../../src/utils/errors.js";

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
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        flatSync: true,
      },
    });

    expect(config.environment).toBe("test");
    expect(config.sync.flatSync).toBe(true);
    expect(config.notifications.unpaidInvoiceCatchUp).toBe(false);
  });

  it("accepts unpaid invoice catch-up opt-in", () => {
    const config = AppConfigSchema.parse({
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
        unpaidInvoiceCatchUp: true,
        email: { enabled: false },
      },
      logging: { level: "info", file: "/tmp/ksef/logs/app.log", pretty: false },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });

    expect(config.notifications.unpaidInvoiceCatchUp).toBe(true);
  });

  it("defaults console logging to pretty output", () => {
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
      logging: { level: "info", file: "/tmp/ksef/logs/app.log" },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });

    expect(config.logging.pretty).toBe(true);
  });

  it("accepts per-organization output paths", () => {
    const config = AppConfigSchema.parse({
      environment: "test",
      auth: {
        method: "ksefToken",
        keychainServiceName: "ksefctl",
      },
      organizations: [{ nip: "1234567890", outputPath: "/tmp/custom-output" }],
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

    expect(config.organizations[0]?.outputPath).toBe("/tmp/custom-output");
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

  it("resolves relative per-nip output paths via loader", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const yaml = YAML.stringify({
      environment: "test",
      auth: {
        method: "ksefToken",
        keychainServiceName: "ksefctl",
      },
      organizations: [{ nip: "1234567890", outputPath: "exports/org-a" }],
      pollingIntervalSeconds: 300,
      storage: { root: "storage" },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: { level: "info", file: "storage/logs/app.log", pretty: false },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
      },
      security: { tls: { enablePinning: false, pins: [], pinningHosts: [] } },
      sync: {
        subjectTypes: ["Subject1"],
        includeMetadataHeader: true,
        flatSync: true,
      },
    });
    await fs.writeFile(configPath, yaml, "utf-8");

    const loaded = await loadConfig(configPath);

    expect(loaded.sync.flatSync).toBe(true);
    expect(loaded.organizations[0]?.outputPath).toBe(
      path.join(tmpDir, "exports", "org-a"),
    );
    expect(loaded.storage.root).toBe(path.join(tmpDir, "storage"));
  });

  it("throws ConfigError when TLS pin is invalid", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const yaml = YAML.stringify({
      environment: "test",
      auth: { method: "ksefToken", keychainServiceName: "ksefctl" },
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
      security: {
        tls: { enablePinning: true, pins: ["invalidpin123"], pinningHosts: [] },
      },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });
    await fs.writeFile(configPath, yaml, "utf-8");
    await expect(loadConfig(configPath)).rejects.toBeInstanceOf(ConfigError);
  });

  it("fills every default for a config with only required fields", () => {
    const config = AppConfigSchema.parse({
      auth: {},
      storage: { root: "/tmp/ksef" },
      logging: { file: "/tmp/ksef/logs/app.log" },
    });

    expect(config).toEqual({
      environment: "prod",
      auth: { method: "ksefToken" },
      organizations: [],
      pollingIntervalSeconds: 300,
      storage: { root: "/tmp/ksef" },
      notifications: {
        macosNotification: true,
        unpaidInvoiceCatchUp: false,
        unpaidCatchUpLookbackDays: 30,
        email: { enabled: false },
      },
      logging: {
        level: "info",
        file: "/tmp/ksef/logs/app.log",
        pretty: true,
        rotation: {
          enabled: true,
          maxFileMegabytes: 16,
          maxFiles: 5,
          maxAgeDays: 30,
        },
      },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
        authPollMaxAttempts: 60,
        exportPollMaxAttempts: 120,
        exportCooldownSeconds: 2,
        allowInsecureHttp: false,
        retry: {
          maxAttempts: 5,
          baseDelayMs: 500,
          maxDelayMs: 10_000,
          jitter: 0.2,
        },
      },
      security: {
        tls: { enablePinning: false, pins: [], pinningHosts: [] },
        allowedHosts: [],
      },
      sync: {
        subjectTypes: ["Subject1", "Subject2", "Subject3", "SubjectAuthorized"],
        includeMetadataHeader: true,
        generatePdf: true,
        pdfGenerationTimeoutMs: 30_000,
        pdfMaxConsecutiveTimeouts: 3,
        flatSync: false,
        maxConcurrentNips: 1,
        minExportWindowSeconds: 300,
        adaptivePolling: {
          enabled: true,
          minIntervalSeconds: 300,
          maxIntervalSeconds: 3600,
          growthFactor: 2,
          decayFactor: 0.8,
          respectRetryAfter: true,
        },
      },
    });
  });

  it("fills nested defaults inside partially specified sections", () => {
    const config = AppConfigSchema.parse({
      auth: {},
      storage: { root: "/tmp/ksef" },
      logging: { file: "/tmp/ksef/logs/app.log", rotation: { maxFiles: 9 } },
      notifications: {
        email: {
          smtpProfiles: [
            {
              label: "billing",
              host: "smtp",
              port: 587,
              user: "user",
              pass: "pass",
              from: "from@example.com",
              to: ["to@example.com"],
            },
          ],
        },
      },
      operational: { retry: { maxAttempts: 2 } },
      security: { tls: {} },
      sync: { adaptivePolling: { enabled: false } },
    });

    expect(config.logging.rotation).toEqual({
      enabled: true,
      maxFileMegabytes: 16,
      maxFiles: 9,
      maxAgeDays: 30,
    });
    expect(config.notifications.email.enabled).toBe(false);
    expect(config.notifications.email.smtpProfiles?.[0]).toMatchObject({
      secure: false,
      tlsRejectUnauthorized: true,
      nips: [],
    });
    expect(config.operational.retry).toEqual({
      maxAttempts: 2,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitter: 0.2,
    });
    expect(config.security.tls).toEqual({
      enablePinning: false,
      pins: [],
      pinningHosts: [],
    });
    expect(config.sync.adaptivePolling.minIntervalSeconds).toBe(300);
    expect(config.sync.adaptivePolling.enabled).toBe(false);
  });

  it("reports every schema violation with its path as a ConfigError", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    const yaml = YAML.stringify({
      environment: "test",
      auth: { method: "ksefToken" },
      organizations: [{ nip: "ABC" }],
      pollingIntervalSeconds: "often",
      storage: { root: "/tmp/ksef" },
      logging: { level: "loud", file: "/tmp/ksef/logs/app.log" },
      sync: { initialSyncFrom: "2024-01-01" },
    });
    await fs.writeFile(configPath, yaml, "utf-8");

    const error: unknown = await loadConfig(configPath).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain(`Invalid config at ${configPath}`);
    expect(message).toContain("NIP must be exactly 10 digits");
    expect(message).toContain("organizations[0].nip");
    expect(message).toContain("expected number, received string");
    expect(message).toContain("pollingIntervalSeconds");
    expect(message).toContain("logging.level");
    expect(message).toContain("sync.initialSyncFrom");
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

    // keychainServiceName is a label, not a secret — must be shown as-is
    const auth = sanitized.auth as Record<string, unknown>;
    expect(auth.keychainServiceName).toBe("ksefctl");
    // SMTP credentials must still be redacted
    const smtp = (
      (sanitized.notifications as Record<string, unknown>).email as Record<
        string,
        unknown
      >
    ).smtp as Record<string, unknown>;
    expect(smtp.user).toBe("***");
    expect(smtp.pass).toBe("***");
  });
});
