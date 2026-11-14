import type { AccessTokenProvider } from "../../src/api/ksefClient.js";
import type { KeychainStore } from "../../src/auth/keychainStore.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KsefClient } from "../../src/api/ksefClient.js";
import {
  AuthService,
  createAccessTokenProvider,
  type AuthTokens,
} from "../../src/auth/authService.js";
import { AuthError } from "../../src/utils/errors.js";
import { HttpClient } from "../../src/utils/http.js";

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createKsefClient = () =>
  new KsefClient(
    new HttpClient({
      baseUrl: "https://api.example.com/v2",
      timeoutMs: 1000,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      security: { enablePinning: false, pins: [], pinningHosts: [] },
    }),
  );

const jsonResponse = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const authorizationOf = (call: unknown[]): string | undefined =>
  ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

const tokensValidFor = (accessToken: string, ms: number): AuthTokens => ({
  accessToken,
  accessTokenValidUntil: new Date(Date.now() + ms).toISOString(),
  refreshToken: "REFRESH",
  refreshTokenValidUntil: new Date(Date.now() + 86_400_000).toISOString(),
});

let savedFetch: typeof globalThis.fetch | undefined;

const mockFetch = (fetchSpy: ReturnType<typeof vi.fn>) => {
  savedFetch ??= globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = fetchSpy;
};

afterEach(() => {
  if (savedFetch !== undefined) {
    (globalThis as Record<string, unknown>).fetch = savedFetch;
    savedFetch = undefined;
  }
});

describe("KsefClient with an access token provider", () => {
  it("sends a current token on the retry after a 429 wait that outlasts it", async () => {
    let current = "OLD";
    const provider: AccessTokenProvider = {
      get: vi.fn(() => Promise.resolve(current)),
      refresh: vi.fn(() => Promise.resolve(current)),
    };
    const fetchSpy = vi.fn().mockImplementationOnce(() => {
      // The token expires while the client waits out the rate limit.
      current = "NEW";
      return Promise.resolve(jsonResponse({}, 429, { "Retry-After": "0" }));
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ referenceNumber: "ref" }));
    mockFetch(fetchSpy);

    await expect(
      createKsefClient().exportInvoices(provider, { filters: {} }, false),
    ).resolves.toEqual({ referenceNumber: "ref" });

    expect(fetchSpy.mock.calls.map(authorizationOf)).toEqual([
      "Bearer OLD",
      "Bearer NEW",
    ]);
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the token and retries once after a 401", async () => {
    let current = "REJECTED";
    const provider: AccessTokenProvider = {
      get: vi.fn(() => Promise.resolve(current)),
      refresh: vi.fn(() => {
        current = "FRESH";
        return Promise.resolve(current);
      }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse({ status: { code: 200, description: "OK" } }),
      );
    mockFetch(fetchSpy);

    await expect(
      createKsefClient().getExportStatus(provider, "ref"),
    ).resolves.toEqual({ status: { code: 200, description: "OK" } });

    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.map(authorizationOf)).toEqual([
      "Bearer REJECTED",
      "Bearer FRESH",
    ]);
  });

  it("fails with AuthError when the refreshed token is rejected too", async () => {
    const provider: AccessTokenProvider = {
      get: vi.fn(() => Promise.resolve("BAD")),
      refresh: vi.fn(() => Promise.resolve("BAD")),
    };
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({}, 401)));
    mockFetch(fetchSpy);

    await expect(
      createKsefClient().downloadInvoiceXml(provider, "KSEF-1"),
    ).rejects.toBeInstanceOf(AuthError);

    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not refresh on 403", async () => {
    const provider: AccessTokenProvider = {
      get: vi.fn(() => Promise.resolve("TOKEN")),
      refresh: vi.fn(() => Promise.resolve("TOKEN")),
    };
    mockFetch(vi.fn(() => Promise.resolve(jsonResponse({}, 403))));

    await expect(
      createKsefClient().getExportStatus(provider, "ref"),
    ).rejects.toBeInstanceOf(AuthError);

    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("still accepts a fixed token string", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ referenceNumber: "r" })));
    mockFetch(fetchSpy);

    await createKsefClient().exportInvoices("FIXED", {}, true);

    const headers = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(headers.headers).toEqual({
      Authorization: "Bearer FIXED",
      "Content-Type": "application/json",
      "X-KSeF-Feature": "include-metadata",
    });
  });
});

describe("createAccessTokenProvider", () => {
  it("uses the initial tokens while they are valid", async () => {
    const getAccessToken = vi.fn();
    const provider = createAccessTokenProvider(
      { getAccessToken },
      "1234567890",
      tokensValidFor("INITIAL", 600_000),
    );

    await expect(provider.get()).resolves.toBe("INITIAL");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("loads a new token when the current one is about to expire", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue(tokensValidFor("RENEWED", 600_000));
    const provider = createAccessTokenProvider(
      { getAccessToken },
      "1234567890",
      tokensValidFor("EXPIRING", 30_000),
    );

    await expect(provider.get()).resolves.toBe("RENEWED");
    await expect(provider.get()).resolves.toBe("RENEWED");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith("1234567890", {
      forceRefresh: false,
    });
  });

  it("shares one load between concurrent callers", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue(tokensValidFor("SHARED", 600_000));
    const provider = createAccessTokenProvider({ getAccessToken }, "1");

    await expect(
      Promise.all([provider.get(), provider.get(), provider.get()]),
    ).resolves.toEqual(["SHARED", "SHARED", "SHARED"]);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh even while an unforced load is in flight", async () => {
    let releaseUnforced: ((tokens: AuthTokens) => void) | undefined;
    const getAccessToken = vi.fn(
      (_nip: string, options?: { forceRefresh?: boolean }) =>
        options?.forceRefresh
          ? Promise.resolve(tokensValidFor("FORCED", 600_000))
          : new Promise<AuthTokens>((resolve) => {
              releaseUnforced = resolve;
            }),
    );
    const provider = createAccessTokenProvider({ getAccessToken }, "1");

    const unforced = provider.get();
    await expect(provider.refresh()).resolves.toBe("FORCED");
    releaseUnforced?.(tokensValidFor("STALE", 600_000));
    await expect(unforced).resolves.toBe("STALE");
    expect(getAccessToken).toHaveBeenCalledWith("1", { forceRefresh: true });
  });
});

describe("AuthService.getAccessToken", () => {
  const createService = () => {
    const keychain = {
      getEntry: vi.fn().mockResolvedValue({
        ksefToken: "KSEF",
        ...tokensValidFor("CACHED", 600_000),
      }),
      setTokens: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: {
          token: "REFRESHED",
          validUntil: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    };
    const service = new AuthService(
      client as unknown as KsefClient,
      { environment: "test" } as AppConfig,
      createLogger(),
      keychain as unknown as KeychainStore,
    );
    return { service, client, keychain };
  };

  it("returns the cached access token while it is valid", async () => {
    const { service, client } = createService();

    await expect(service.getAccessToken("1")).resolves.toMatchObject({
      accessToken: "CACHED",
    });
    expect(client.refreshToken).not.toHaveBeenCalled();
  });

  it("skips a still-valid cached token when forced to refresh", async () => {
    const { service, client, keychain } = createService();

    await expect(
      service.getAccessToken("1", { forceRefresh: true }),
    ).resolves.toMatchObject({ accessToken: "REFRESHED" });
    expect(client.refreshToken).toHaveBeenCalledWith("REFRESH");
    expect(keychain.setTokens).toHaveBeenCalledWith(
      "test",
      "1",
      expect.objectContaining({ accessToken: "REFRESHED" }),
    );
  });
});
