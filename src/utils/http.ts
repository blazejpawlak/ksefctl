import type { Logger } from "pino";
import { Agent } from "undici";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import tls from "node:tls";
import { calculateBackoff } from "./backoff";
import { AuthError, NetworkError } from "./errors";
import { formatDuration, sleep, sleepWithCountdown } from "./time";

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
};

export type SecurityOptions = {
  enablePinning: boolean;
  pins: string[];
  pinningHosts: string[];
  caPath?: string;
};

export type HttpClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  retry: RetryOptions;
  security: SecurityOptions;
  logger?: Logger;
  progress?: (message: string) => void;
  countdownIntervalSeconds?: number;
};

export type RequestOptions = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  parseAs?: "json" | "text" | "buffer";
};

const maxErrorBodyLength = 500;

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const isAbsoluteUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const toSafePath = (path: string): string => {
  if (isAbsoluteUrl(path)) {
    const url = new URL(path);
    return `${url.origin}${url.pathname}`;
  }
  return path.startsWith("/") ? path : `/${path}`;
};

const formatErrorBody = (raw: string | null): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized.length <= maxErrorBodyLength) return normalized;
  return `${normalized.slice(0, maxErrorBodyLength)}…`;
};

const extractHttpStatus = (message: string): number | null => {
  const match = /^HTTP (\d{3})\b/.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
};

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

const createDispatcher = async (security: SecurityOptions): Promise<Agent> => {
  const ca = security.caPath
    ? await fs.readFile(security.caPath, "utf-8")
    : undefined;
  const pins = security.pins;
  const normalizeHost = (value: string) =>
    value.trim().toLowerCase().replace(/\.$/, "");
  const pinningHosts = security.pinningHosts.map(normalizeHost);

  return new Agent({
    connect: {
      rejectUnauthorized: true,
      ca,
      checkServerIdentity: (host, cert) => {
        const defaultError = tls.checkServerIdentity(host, cert);
        if (defaultError) return defaultError;
        const normalizedHost = normalizeHost(host);
        const shouldPin =
          security.enablePinning &&
          pins.length > 0 &&
          (pinningHosts.length === 0 || pinningHosts.includes(normalizedHost));
        if (!shouldPin) return undefined;

        if (!cert.pubkey) {
          return new Error(
            "TLS pinning failed: missing certificate public key",
          );
        }
        const hash = crypto
          .createHash("sha256")
          .update(cert.pubkey)
          .digest("base64");
        if (!pins.includes(hash)) {
          return new Error("TLS pin mismatch");
        }
        return undefined;
      },
    },
  });
};

export class HttpClient {
  private dispatcherPromise: Promise<Agent>;
  private options: HttpClientOptions;
  private logger?: Logger;
  private progress?: (message: string) => void;

  constructor(options: HttpClientOptions) {
    this.options = options;
    this.dispatcherPromise = createDispatcher(options.security);
    this.logger = options.logger;
    this.progress = options.progress;
  }

  private emitProgress(message: string): void {
    this.logger?.info(message);
    if (this.progress) {
      this.progress(message);
    }
  }

  private async waitWithCountdown(delayMs: number, isRateLimit: boolean) {
    if (!isRateLimit || delayMs <= 0) {
      await sleep(delayMs);
      return;
    }
    const intervalSeconds = this.options.countdownIntervalSeconds ?? 60;
    await sleepWithCountdown(delayMs, intervalSeconds, (remaining) => {
      this.emitProgress(
        `Progress: rate limited, waiting ${formatDuration(remaining)}`,
      );
    });
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const dispatcher = await this.dispatcherPromise;
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const relativePath = options.path.replace(/^\/+/, "");
    const url = isAbsoluteUrl(options.path)
      ? options.path
      : new URL(relativePath, baseUrl).toString();
    const safePath = toSafePath(options.path);
    const method = options.method.toUpperCase();
    const headers = options.headers ?? {};

    for (
      let attempt = 1;
      attempt <= this.options.retry.maxAttempts;
      attempt += 1
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs,
      );

      try {
        this.logger?.debug({ attempt, method, path: safePath }, "HTTP request");
        const body = options.body;
        const response = await fetch(url, {
          method: options.method,
          headers,
          body,
          dispatcher,
          signal: controller.signal,
        } as RequestInit & { dispatcher: Agent });

        if (response.status === 429 || response.status >= 500) {
          if (attempt < this.options.retry.maxAttempts) {
            const retryAfter = response.headers.get("Retry-After");
            const retrySeconds = retryAfter ? Number(retryAfter) : NaN;
            const retryDelay = Number.isFinite(retrySeconds)
              ? retrySeconds * 1000
              : null;
            const delay =
              retryDelay ??
              calculateBackoff({
                attempt,
                baseDelayMs: this.options.retry.baseDelayMs,
                maxDelayMs: this.options.retry.maxDelayMs,
                jitter: this.options.retry.jitter,
              });
            this.logger?.warn(
              {
                attempt,
                method,
                path: safePath,
                status: response.status,
                delay: formatDuration(delay),
                delayMs: delay,
              },
              "HTTP retry scheduled",
            );
            if (response.status === 429) {
              this.emitProgress(
                `Progress: rate limited, waiting ${formatDuration(delay)}`,
              );
            }
            await this.waitWithCountdown(delay, response.status === 429);
            continue;
          }
        }

        if (!response.ok) {
          const errorBody = formatErrorBody(await response.text());
          const requestId =
            response.headers.get("x-correlation-id") ??
            response.headers.get("x-request-id");
          const suffix = requestId ? ` (requestId=${requestId})` : "";
          const bodySuffix = errorBody ? `: ${errorBody}` : "";
          const message = `HTTP ${response.status} ${method} ${safePath}${bodySuffix}${suffix}`;
          if (response.status === 401 || response.status === 403) {
            throw new AuthError(message);
          }
          throw new NetworkError(message);
        }

        this.logger?.debug(
          { attempt, method, path: safePath, status: response.status },
          "HTTP response",
        );

        if (options.parseAs === "text") {
          return (await response.text()) as T;
        }
        if (options.parseAs === "buffer") {
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer) as T;
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        const message = (error as Error).message;
        const status = extractHttpStatus(message);
        if (status !== null && !isRetryableStatus(status)) {
          throw error;
        }
        if (attempt >= this.options.retry.maxAttempts) {
          if (error instanceof NetworkError) throw error;
          throw new NetworkError(`Network failure: ${message}`);
        }

        this.logger?.warn(
          { attempt, method, path: safePath, err: message },
          "HTTP request failed, retrying",
        );
        const delay = calculateBackoff({
          attempt,
          baseDelayMs: this.options.retry.baseDelayMs,
          maxDelayMs: this.options.retry.maxDelayMs,
          jitter: this.options.retry.jitter,
        });
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new NetworkError("Request failed after retries");
  }
}
