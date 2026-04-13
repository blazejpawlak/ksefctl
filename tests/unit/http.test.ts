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

const createClient = () =>
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
  });

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
    expect(
      sanitizeErrorMessage("token=abc123 expired at 5pm"),
    ).toBe("token=[REDACTED] at 5pm");
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
