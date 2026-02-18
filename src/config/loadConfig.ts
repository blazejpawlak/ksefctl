import YAML from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { AppConfigSchema, type AppConfig } from "./schema";
import {
  defaultConfigPath,
  defaultDataRoot,
  defaultLogPath,
  expandHome,
} from "../utils/paths";
import { ConfigError } from "../utils/errors";

export const resolveConfigPath = (overridePath?: string): string => {
  const envPath = process.env.KSEFCTL_CONFIG;
  const selected = overridePath || envPath || defaultConfigPath();
  return expandHome(selected);
};

export const loadConfig = async (configPath: string): Promise<AppConfig> => {
  const resolvedPath = resolveConfigPath(configPath);
  let rawText: string;
  try {
    rawText = await fs.readFile(resolvedPath, "utf-8");
  } catch (error) {
    throw new ConfigError(`Config not found at ${resolvedPath}`);
  }

  const parsed = YAML.parse(rawText) ?? {};
  if (process.env.KSEFCTL_SMTP_USER || process.env.KSEFCTL_SMTP_PASS) {
    parsed.notifications ??= {};
    parsed.notifications.email ??= {};
    parsed.notifications.email.smtp ??= {};
    if (process.env.KSEFCTL_SMTP_USER) {
      parsed.notifications.email.smtp.user = process.env.KSEFCTL_SMTP_USER;
    }
    if (process.env.KSEFCTL_SMTP_PASS) {
      parsed.notifications.email.smtp.pass = process.env.KSEFCTL_SMTP_PASS;
    }
  }
  if (parsed.auth?.mode) {
    parsed.auth.method = "ksefToken";
    delete parsed.auth.mode;
  }
  if (parsed.auth?.ksefToken?.contextIdentifier?.value) {
    parsed.organizations ??= [];
    if (
      !parsed.organizations.find(
        (org: { nip?: string }) =>
          org.nip === parsed.auth.ksefToken.contextIdentifier.value,
      )
    ) {
      parsed.organizations.push({
        nip: parsed.auth.ksefToken.contextIdentifier.value,
      });
    }
  }
  if (parsed.auth?.ksefToken) {
    delete parsed.auth.ksefToken;
  }
  if (parsed.auth?.xades) {
    delete parsed.auth.xades;
  }

  const storageRootRaw = parsed.storage?.root ?? defaultDataRoot();
  const loggingFileRaw =
    parsed.logging?.file ?? defaultLogPath(expandHome(storageRootRaw));
  const baseDir = path.dirname(resolvedPath);
  const resolveMaybeRelative = (value: string) => {
    const expanded = expandHome(value);
    return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
  };
  const storageRoot = resolveMaybeRelative(storageRootRaw);
  const loggingFile = resolveMaybeRelative(loggingFileRaw);

  if (typeof parsed.environment === "string") {
    const env = parsed.environment.toLowerCase();
    if (env === "integ" || env === "demo") parsed.environment = "test";
    if (env === "production") parsed.environment = "prod";
    if (env === "test" || env === "prod") parsed.environment = env;
  }

  const normalized = {
    ...parsed,
    environment: parsed.environment ?? "prod",
    storage: { root: storageRoot },
    logging: { ...parsed.logging, file: loggingFile },
  };

  return AppConfigSchema.parse(normalized);
};

export const sanitizeConfig = (config: AppConfig): Record<string, unknown> => {
  const redacted = JSON.parse(JSON.stringify(config)) as Record<
    string,
    unknown
  >;
  const redactValue = "***";

  const apply = (obj: Record<string, unknown> | undefined, key: string) => {
    if (!obj) return;
    if (key in obj) obj[key] = redactValue;
  };

  const auth = redacted.auth as Record<string, unknown> | undefined;
  if (auth) {
    apply(auth, "keychainServiceName");
  }

  const notifications = redacted.notifications as
    | Record<string, unknown>
    | undefined;
  const email = notifications?.email as Record<string, unknown> | undefined;
  const smtp = email?.smtp as Record<string, unknown> | undefined;
  if (smtp) {
    apply(smtp, "user");
    apply(smtp, "pass");
    apply(smtp, "from");
    apply(smtp, "to");
  }

  return redacted;
};

export const resolveConfigDir = (configPath: string): string => {
  return path.dirname(resolveConfigPath(configPath));
};
