import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/utils/http";
import { NetworkError } from "../../src/utils/errors";

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
