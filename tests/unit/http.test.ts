import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatErrorMessage,
  NetworkError,
  sanitizeErrorMessage,
  ConfigError,
} from "../../src/utils/errors";
import { HttpClient, validateTlsOptions } from "../../src/utils/http";

const createClient = (
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
) =>
  new HttpClient({
    baseUrl: "https://api.example.com/v2",
    timeoutMs: 1000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: 0,
    },
    security: {
      enablePinning: false,
      pins: [],
      pinningHosts: [],
    },
    ...overrides,
  });

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

let _savedFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (_savedFetch !== undefined) {
    (globalThis as Record<string, unknown>).fetch = _savedFetch;
    _savedFetch = undefined;
  }
});

describe("HttpClient", () => {
  it("sanitizes HTTP error messages while preserving request IDs", () => {
    expect(
      sanitizeErrorMessage(
        "HTTP 500 GET /invoices/exports: token=secret request failed (requestId=req-1)",
      ),
    ).toBe("HTTP 500 GET /invoices/exports (requestId=req-1)");
  });

  it("sanitizes wrapped network failure messages", () => {
    expect(
      sanitizeErrorMessage(
        "Network failure: HTTP 502 POST /invoices/exports: raw upstream body",
      ),
    ).toBe("Network failure: HTTP 502 POST /invoices/exports");
  });

  it("sanitizes non-HTTP secret-bearing messages", () => {
    expect(
      sanitizeErrorMessage(
        "SMTP failure: Authorization=Bearer abc123 url=https://user:pass@example.com/callback?token=secret&signature=sig",
      ),
    ).toBe(
      "SMTP failure: Authorization=[REDACTED] url=https://[REDACTED]@example.com/callback?token=[REDACTED]&signature=[REDACTED]",
    );
  });

  it("redacts two-word bearer-style values without leaving a floating [REDACTED]", () => {
    // bearerTokenPattern runs first: "Bearer abc123" → "Bearer [REDACTED]"
    // secretKeyPattern then sees "Authorization=Bearer [REDACTED]"; without the
    // trailing-word clause it would match only "Bearer" and leave " [REDACTED]"
    // floating. The trailing clause consumes both words as the two-word value.
    expect(
      sanitizeErrorMessage("Authorization=Bearer abc123 url=example.com"),
    ).toBe("Authorization=[REDACTED] url=example.com");
  });

  it("trailing-word clause consumes at most one word after the primary token", () => {
    // "token=abc expired at 5pm": the regex eats "abc expired" (two words)
    // leaving " at 5pm" intact.
    expect(sanitizeErrorMessage("token=abc123 expired at 5pm")).toBe(
      "token=[REDACTED] at 5pm",
    );
  });

  it("formats unknown errors through the shared sanitizer", () => {
    expect(
      formatErrorMessage(
        new Error(
          "HTTP 500 GET /invoices/exports: token=secret request failed (requestId=req-1)",
        ),
      ),
    ).toBe("HTTP 500 GET /invoices/exports (requestId=req-1)");
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("bad request", {
        status: 400,
      }),
    );
    _savedFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const client = createClient();

    await expect(
      client.request({ method: "POST", path: "/invoices/exports" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("logs rate-limit retries as state changes without duplicating progress ticks", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("retry later", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    _savedFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const logger = createLogger();
    const progress = vi.fn();
    const client = createClient({ logger, progress });

    await expect(
      client.request({ method: "POST", path: "/invoices/exports" }),
    ).resolves.toEqual({ ok: true });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        retryReason: "rate_limit",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 0,
      }),
      "KSeF rate limit reached; retry scheduled",
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(
      "Progress: rate limited, waiting 0ms",
    );
  });

  it("logs transient fetch failures with retry delay context", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    _savedFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const logger = createLogger();
    const client = createClient({ logger });

    await expect(
      client.request({ method: "GET", path: "/invoices/exports/ref" }),
    ).resolves.toEqual({ ok: true });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        method: "GET",
        path: "/invoices/exports/ref",
        retryReason: "network_failure",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 1,
        err: "fetch failed",
      }),
      "Temporary network failure; retry scheduled",
    );
  });

  it("falls back to backoff for negative Retry-After values", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("retry later", {
          status: 429,
          headers: { "Retry-After": "-5" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    _savedFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const logger = createLogger();
    const client = createClient({
      logger,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 7,
        maxDelayMs: 7,
        jitter: 0,
      },
    });

    await expect(
      client.request({ method: "POST", path: "/invoices/exports" }),
    ).resolves.toEqual({ ok: true });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        retryReason: "rate_limit",
        delayMs: 7,
      }),
      "KSeF rate limit reached; retry scheduled",
    );
  });
});

describe("validateTlsOptions", () => {
  it("accepts valid 44-char base64 pins", async () => {
    // n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg= is sha256("test") in base64
    await expect(
      validateTlsOptions({
        enablePinning: true,
        pins: ["n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="],
        pinningHosts: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a pin that is too short", async () => {
    await expect(
      validateTlsOptions({
        enablePinning: true,
        pins: ["tooshort"],
        pinningHosts: [],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects a pin with invalid base64 characters", async () => {
    await expect(
      validateTlsOptions({
        enablePinning: true,
        pins: ["!nvalid+pin=that/has=bad_chars==========="],
        pinningHosts: [],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("accepts no pins when pinning is disabled", async () => {
    await expect(
      validateTlsOptions({
        enablePinning: false,
        pins: [],
        pinningHosts: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a caPath that does not exist", async () => {
    await expect(
      validateTlsOptions({
        enablePinning: false,
        pins: [],
        pinningHosts: [],
        caPath: "/nonexistent/ca.pem",
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("accepts a caPath that exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-ca-"));
    const caPath = path.join(tmpDir, "ca.pem");
    await fs.writeFile(caPath, "dummy", "utf-8");

    await expect(
      validateTlsOptions({
        enablePinning: false,
        pins: [],
        pinningHosts: [],
        caPath,
      }),
    ).resolves.toBeUndefined();
  });
});
