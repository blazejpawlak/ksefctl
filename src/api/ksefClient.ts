import type { HttpClient, RequestOptions } from "../utils/http.js";
import { AuthError } from "../utils/errors.js";

/**
 * Supplies the KSeF access token for one NIP. get() returns a current token
 * (refreshing one that is about to expire); refresh() obtains a new one after
 * KSeF rejected the current token.
 */
export type AccessTokenProvider = {
  get: () => Promise<string>;
  refresh: () => Promise<string>;
};

/** A fixed access token, or a provider that keeps it current. */
export type AccessTokenSource = string | AccessTokenProvider;

const isUnauthorized = (error: unknown): boolean =>
  error instanceof AuthError && /^HTTP 401\b/.test(error.message);

export type AuthenticationChallengeResponse = {
  challenge: string;
  timestamp: string;
  timestampMs?: number;
};

export type AuthenticationInitResponse = {
  referenceNumber: string;
  authenticationToken: {
    token: string;
    validUntil: string;
  };
};

export type AuthenticationTokensResponse = {
  accessToken: { token: string; validUntil: string };
  refreshToken: { token: string; validUntil: string };
};

export type AuthenticationTokenRefreshResponse = {
  accessToken: { token: string; validUntil: string };
};

export type AuthenticationOperationStatusResponse = {
  status: { code: number; description: string; details?: string };
};

export type ExportInvoicesResponse = {
  referenceNumber: string;
};

export type InvoiceExportStatusResponse = {
  status: { code: number; description: string };
  completedDate?: string;
  package?: {
    invoiceCount?: number;
    size?: number;
    isTruncated?: boolean;
    lastPermanentStorageDate?: string | null;
    permanentStorageHwmDate?: string | null;
    parts?: {
      ordinalNumber: number;
      partName: string;
      method: string;
      url: string;
      partSize?: number;
      partHash?: string;
      encryptedPartSize?: number;
      encryptedPartHash?: string;
      expirationDate?: string;
    }[];
  };
};

export type PublicKeyCertificate = {
  certificate: string;
  validFrom: string;
  validTo: string;
  usage: string[];
};

export class KsefClient {
  private http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  // Sends a request authorized with the access token. With a provider, the
  // token is resolved on every attempt, so a request that outlives it (a long
  // 429 wait, a slow export) sends a current one. A 401 refreshes the token
  // and retries once; a second 401 is a real credentials problem and is
  // thrown.
  private async requestWithToken<T>(
    accessToken: AccessTokenSource,
    options: Omit<RequestOptions, "headers"> & {
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    if (typeof accessToken === "string") {
      return this.http.request<T>({
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
      });
    }
    const send = () =>
      this.http.request<T>({
        ...options,
        headers: async () => ({
          ...options.headers,
          Authorization: `Bearer ${await accessToken.get()}`,
        }),
      });
    try {
      return await send();
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await accessToken.refresh();
      return await send();
    }
  }

  getAuthChallenge(): Promise<AuthenticationChallengeResponse> {
    return this.http.request({ method: "POST", path: "/auth/challenge" });
  }

  submitKsefTokenAuth(
    body: Record<string, unknown>,
  ): Promise<AuthenticationInitResponse> {
    return this.http.request({
      method: "POST",
      path: "/auth/ksef-token",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  getAuthStatus(
    referenceNumber: string,
    authenticationToken: string,
  ): Promise<AuthenticationOperationStatusResponse> {
    return this.http.request({
      method: "GET",
      path: `/auth/${referenceNumber}`,
      headers: { Authorization: `Bearer ${authenticationToken}` },
    });
  }

  redeemToken(
    authenticationToken: string,
  ): Promise<AuthenticationTokensResponse> {
    return this.http.request({
      method: "POST",
      path: "/auth/token/redeem",
      headers: { Authorization: `Bearer ${authenticationToken}` },
    });
  }

  refreshToken(
    refreshToken: string,
  ): Promise<AuthenticationTokenRefreshResponse> {
    return this.http.request({
      method: "POST",
      path: "/auth/token/refresh",
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
  }

  getPublicKeyCertificates(): Promise<PublicKeyCertificate[]> {
    return this.http.request({
      method: "GET",
      path: "/security/public-key-certificates",
    });
  }

  exportInvoices(
    accessToken: AccessTokenSource,
    body: Record<string, unknown>,
    includeMetadataHeader: boolean,
  ): Promise<ExportInvoicesResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (includeMetadataHeader) {
      headers["X-KSeF-Feature"] = "include-metadata";
    }
    return this.requestWithToken(accessToken, {
      method: "POST",
      path: "/invoices/exports",
      headers,
      body: JSON.stringify(body),
    });
  }

  getExportStatus(
    accessToken: AccessTokenSource,
    referenceNumber: string,
  ): Promise<InvoiceExportStatusResponse> {
    return this.requestWithToken(accessToken, {
      method: "GET",
      path: `/invoices/exports/${referenceNumber}`,
    });
  }

  downloadInvoiceXml(
    accessToken: AccessTokenSource,
    ksefNumber: string,
  ): Promise<string> {
    return this.requestWithToken(accessToken, {
      method: "GET",
      path: `/invoices/ksef/${ksefNumber}`,
      parseAs: "text",
    });
  }

  downloadPackagePart(url: string, method = "GET"): Promise<Buffer> {
    return this.http.request({
      method,
      path: url,
      parseAs: "buffer",
    });
  }
}
