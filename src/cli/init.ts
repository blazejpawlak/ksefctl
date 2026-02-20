import YAML from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureStorageDirs } from "../core/storage";
import {
  defaultConfigPath,
  defaultDataRoot,
  defaultLogPath,
  ensureDir,
  expandHome,
} from "../utils/paths";

export const initConfig = async (
  configPathOverride?: string,
  force = false,
): Promise<string> => {
  const configPath = expandHome(configPathOverride ?? defaultConfigPath());
  const configDir = path.dirname(configPath);

  await ensureDir(configDir);
  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  const resolveMaybeRelative = (value: string) => {
    const expanded = expandHome(value);
    return path.isAbsolute(expanded)
      ? expanded
      : path.join(configDir, expanded);
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  let storageRoot = defaultDataRoot();
  if (exists) {
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
      const storage = isRecord(parsed.storage) ? parsed.storage : null;
      const root = storage?.root;
      if (typeof root === "string" && root.length > 0) {
        storageRoot = resolveMaybeRelative(root);
      }
    } catch {
      storageRoot = defaultDataRoot();
    }
  }

  await ensureStorageDirs(storageRoot);

  const ksefStartDate = new Date("2026-02-01T00:00:00Z");
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
  const initialSyncFrom =
    threeMonthsAgo.getTime() > ksefStartDate.getTime()
      ? threeMonthsAgo
      : ksefStartDate;

  if (exists && !force) {
    return configPath;
  }

  const template = {
    environment: "prod",
    auth: {
      method: "ksefToken",
      authorizationPolicy: undefined,
      keychainServiceName: "ksefctl",
    },
    organizations: [],
    pollingIntervalSeconds: 300,
    storage: {
      root: storageRoot,
    },
    notifications: {
      macosNotification: true,
      email: {
        enabled: false,
        smtp: {
          host: "smtp.example.com",
          port: 587,
          user: "user@example.com",
          pass: "CHANGE_ME",
          from: "ksefctl@example.com",
          to: ["you@example.com"],
          secure: false,
          tlsRejectUnauthorized: true,
        },
      },
    },
    logging: {
      level: "info",
      file: defaultLogPath(storageRoot),
      pretty: false,
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
        maxDelayMs: 10000,
        jitter: 0.2,
      },
    },
    security: {
      tls: {
        enablePinning: false,
        pins: [],
        pinningHosts: [],
      },
      allowedHosts: [],
    },
    sync: {
      subjectTypes: ["Subject1", "Subject2", "Subject3", "SubjectAuthorized"],
      includeMetadataHeader: true,
      generatePdf: true,
      initialSyncFrom: initialSyncFrom.toISOString(),
    },
  };

  const yaml = YAML.stringify(template);
  await fs.writeFile(configPath, yaml, { encoding: "utf-8", mode: 0o600 });
  return configPath;
};
