import { HttpClient } from "../utils/http";

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
    lastPermanentStorageDate?: string;
    permanentStorageHwmDate?: string;
    parts?: Array<{
      ordinalNumber: number;
      partName: string;
      method: string;
      url: string;
      partSize?: number;
      partHash?: string;
      encryptedPartSize?: number;
      encryptedPartHash?: string;
      expirationDate?: string;
    }>;
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
    accessToken: string,
    body: Record<string, unknown>,
    includeMetadataHeader: boolean,
  ): Promise<ExportInvoicesResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (includeMetadataHeader) {
      headers["X-KSeF-Feature"] = "include-metadata";
    }
    return this.http.request({
      method: "POST",
      path: "/invoices/exports",
      headers,
      body: JSON.stringify(body),
    });
  }

  getExportStatus(
    accessToken: string,
    referenceNumber: string,
  ): Promise<InvoiceExportStatusResponse> {
    return this.http.request({
      method: "GET",
      path: `/invoices/exports/${referenceNumber}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  downloadInvoiceXml(accessToken: string, ksefNumber: string): Promise<string> {
    return this.http.request({
      method: "GET",
      path: `/invoices/ksef/${ksefNumber}`,
      headers: { Authorization: `Bearer ${accessToken}` },
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
