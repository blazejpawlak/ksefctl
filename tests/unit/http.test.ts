import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatErrorMessage,
  NetworkError,
  sanitizeErrorMessage,
} from "../../src/utils/errors";
import { HttpClient } from "../../src/utils/http";

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

afterEach(() => {
  vi.unstubAllGlobals();
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
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const client = createClient();

    await expect(
      client.request({ method: "POST", path: "/invoices/exports" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
