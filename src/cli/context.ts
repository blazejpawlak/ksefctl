import path from "node:path";
import { KsefClient } from "../api/ksefClient";
import { AuthService } from "../auth/authService";
import { KeychainStore } from "../auth/keychainStore";
import { resolveBaseUrl } from "../config/environment";
import { loadConfig, resolveConfigPath } from "../config/loadConfig";
import { SqliteStore } from "../db/sqlite";
import { ConfigError } from "../utils/errors";
import { HttpClient, validateTlsOptions } from "../utils/http";
import { createLogger } from "../utils/logger";
import { RateLimitTracker } from "../utils/rateLimit";
import { isManagedServiceMode } from "./serviceMode";

type ContextOptions = {
  verbose?: boolean;
  prettyConsole?: boolean;
  progress?: (message: string) => void;
  countdownIntervalSeconds?: number;
};

export const createContext = async (
  configPathOverride?: string,
  options?: ContextOptions,
) => {
  const configPath = resolveConfigPath(configPathOverride);
  const config = await loadConfig(configPath);
  const verbose = Boolean(options?.verbose);
  const level = verbose
    ? config.logging.level === "trace"
      ? "trace"
      : "debug"
    : config.logging.level;
  const hasProgress = Boolean(options?.progress);
  const suppressConsole = (hasProgress && !verbose) || isManagedServiceMode();
  const logger = await createLogger({
    level,
    file: config.logging.file,
    prettyConsole:
      options?.prettyConsole ?? (verbose ? true : config.logging.pretty),
    suppressConsole,
    rotation: config.logging.rotation,
  });
  const countdownIntervalSeconds =
    options?.countdownIntervalSeconds ?? (verbose ? 10 : 60);

  const normalizeBaseUrl = (input: string): string => {
    const trimmed = input.replace(/\/$/, "");
    if (trimmed.includes("/docs")) {
      throw new ConfigError("apiBaseUrl must point to the API base, not /docs");
    }
    if (trimmed.endsWith("/v2")) return trimmed;
    return `${trimmed}/v2`;
  };

  const baseUrl = normalizeBaseUrl(
    config.apiBaseUrl ?? resolveBaseUrl(config.environment),
  );
  if (baseUrl.startsWith("http://") && !config.operational.allowInsecureHttp) {
    throw new ConfigError(
      "Insecure apiBaseUrl requires operational.allowInsecureHttp=true",
    );
  }

  const tlsSecurity = {
    enablePinning: config.security.tls.enablePinning,
    pins: config.security.tls.pins,
    pinningHosts: config.security.tls.pinningHosts,
    caPath: config.security.tls.caPath,
  };
  await validateTlsOptions(tlsSecurity);

  const rateLimitTracker = new RateLimitTracker();
  const http = new HttpClient({
    baseUrl,
    timeoutMs: config.operational.timeoutSeconds * 1000,
    retry: config.operational.retry,
    security: tlsSecurity,
    logger,
    progress: options?.progress,
    countdownIntervalSeconds,
    onRateLimit: (info) => rateLimitTracker.recordRateLimit(info),
    onSuccess: () => rateLimitTracker.recordSuccess(),
  });

  const client = new KsefClient(http);
  const store = new SqliteStore(
    path.join(config.storage.root, "db", "state.sqlite"),
  );
  const keychain = KeychainStore.fromConfig(config, logger);
  const auth = new AuthService(
    client,
    config,
    logger,
    keychain,
    options?.progress,
    countdownIntervalSeconds,
  );

  return {
    configPath,
    config,
    logger,
    http,
    client,
    auth,
    store,
    keychain,
    countdownIntervalSeconds,
    rateLimitTracker,
  };
};
