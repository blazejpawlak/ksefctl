import YAML from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../utils/errors";
import {
  defaultConfigPath,
  defaultDataRoot,
  defaultLogPath,
  expandHome,
} from "../utils/paths";
import { AppConfigSchema, type AppConfig } from "./schema";

export const resolveConfigPath = (overridePath?: string): string => {
  const envPath = process.env.KSEFCTL_CONFIG;
  const selected = overridePath ?? envPath ?? defaultConfigPath();
  return expandHome(selected);
};

export const loadConfig = async (configPath: string): Promise<AppConfig> => {
  const resolvedPath = resolveConfigPath(configPath);
  let rawText: string;
  try {
    rawText = await fs.readFile(resolvedPath, "utf-8");
  } catch {
    throw new ConfigError(`Config not found at ${resolvedPath}`);
  }

  const parsed = (YAML.parse(rawText) ?? {}) as Record<string, unknown>;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const ensureRecord = (
    container: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> => {
    const current = container[key];
    if (isRecord(current)) return current;
    const created: Record<string, unknown> = {};
    container[key] = created;
    return created;
  };

  if (process.env.KSEFCTL_SMTP_USER || process.env.KSEFCTL_SMTP_PASS) {
    const notifications = ensureRecord(parsed, "notifications");
    const email = ensureRecord(notifications, "email");
    const smtp = ensureRecord(email, "smtp");
    if (process.env.KSEFCTL_SMTP_USER) {
      smtp.user = process.env.KSEFCTL_SMTP_USER;
    }
    if (process.env.KSEFCTL_SMTP_PASS) {
      smtp.pass = process.env.KSEFCTL_SMTP_PASS;
    }
  }

  const auth = isRecord(parsed.auth) ? parsed.auth : null;
  if (auth) {
    const mode = auth.mode;
    if (typeof mode === "string" && mode.length > 0) {
      auth.method = "ksefToken";
      delete auth.mode;
    }
  }

  const ksefToken = auth && isRecord(auth.ksefToken) ? auth.ksefToken : null;
  const contextIdentifier =
    ksefToken && isRecord(ksefToken.contextIdentifier)
      ? ksefToken.contextIdentifier
      : null;
  const nipValue = contextIdentifier?.value;
  if (typeof nipValue === "string" && nipValue.length > 0) {
    const organizationsValue = parsed.organizations;
    const organizations = Array.isArray(organizationsValue)
      ? (organizationsValue as { nip?: string }[])
      : [];
    if (!organizations.find((org) => org.nip === nipValue)) {
      organizations.push({ nip: nipValue });
    }
    parsed.organizations = organizations;
  }

  if (auth && "ksefToken" in auth) {
    delete auth.ksefToken;
  }
  if (auth && "xades" in auth) {
    delete auth.xades;
  }

  const storageRootRaw = (() => {
    const storage = isRecord(parsed.storage) ? parsed.storage : null;
    const root = storage?.root;
    return typeof root === "string" && root.length > 0
      ? root
      : defaultDataRoot();
  })();
  const loggingFileRaw = (() => {
    const logging = isRecord(parsed.logging) ? parsed.logging : null;
    const file = logging?.file;
    return typeof file === "string" && file.length > 0
      ? file
      : defaultLogPath(expandHome(storageRootRaw));
  })();
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

  const logging = isRecord(parsed.logging) ? parsed.logging : {};
  const normalized = {
    ...parsed,
    environment: parsed.environment ?? "prod",
    storage: { root: storageRoot },
    logging: { ...logging, file: loggingFile },
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
