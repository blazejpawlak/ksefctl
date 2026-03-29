import type { KeychainStore } from "./keychainStore";
import type { AuthenticationTokensResponse } from "../api/ksefClient";
import type { KsefClient } from "../api/ksefClient";
import type { AppConfig } from "../config/schema";
import type { Logger } from "pino";
import {
  createPublicKeyFromCertificate,
  rsaOaepSha256Encrypt,
} from "../utils/crypto";
import { AuthError } from "../utils/errors";
import { formatDuration, sleep, sleepWithCountdown } from "../utils/time";
import { type KeychainEntry } from "./keychainStore";

export type AuthTokens = Required<
  Pick<
    KeychainEntry,
    | "accessToken"
    | "accessTokenValidUntil"
    | "refreshToken"
    | "refreshTokenValidUntil"
  >
>;

const isExpired = (validUntil: string | null, skewSeconds = 60): boolean => {
  if (!validUntil) return true;
  const expiry = new Date(validUntil).getTime();
  if (!Number.isFinite(expiry)) return true;
  return Date.now() + skewSeconds * 1000 >= expiry;
};

const selectCertificateByUsage = (
  certs: { certificate: string; usage: string[] }[],
  usage: string,
) => {
  const match = certs.find((cert) => cert.usage.includes(usage));
  if (!match) {
    throw new AuthError(`No public key certificate found for usage: ${usage}`);
  }
  return match.certificate;
};

const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export class AuthService {
  private client: KsefClient;
  private config: AppConfig;
  private logger: Logger;
  private keychain: KeychainStore;
  private progress?: (message: string) => void;
  private countdownIntervalSeconds: number;

  constructor(
    client: KsefClient,
    config: AppConfig,
    logger: Logger,
    keychain: KeychainStore,
    progress?: (message: string) => void,
    countdownIntervalSeconds = 60,
  ) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.keychain = keychain;
    this.progress = progress;
    this.countdownIntervalSeconds = countdownIntervalSeconds;
  }

  private reportProgress(message: string): void {
    if (!this.progress) return;
    this.progress(message);
  }

  async getAccessToken(nip: string): Promise<AuthTokens> {
    this.logger.debug({ nip }, "Resolving access token");
    const entry = await this.keychain.getEntry(this.config.environment, nip);
    if (!entry?.ksefToken) {
      throw new AuthError(`Missing KSeF token in keychain for NIP ${nip}`);
    }

    if (
      entry.accessToken &&
      entry.accessTokenValidUntil &&
      !isExpired(entry.accessTokenValidUntil)
    ) {
      this.logger.debug({ nip }, "Using cached access token");
      return {
        accessToken: entry.accessToken,
        accessTokenValidUntil: entry.accessTokenValidUntil,
        refreshToken: entry.refreshToken ?? "",
        refreshTokenValidUntil: entry.refreshTokenValidUntil ?? "",
      };
    }

    if (
      entry.refreshToken &&
      entry.refreshTokenValidUntil &&
      !isExpired(entry.refreshTokenValidUntil)
    ) {
      try {
        this.logger.debug({ nip }, "Refreshing access token");
        const refreshed = await this.client.refreshToken(entry.refreshToken);
        const tokens: AuthTokens = {
          accessToken: refreshed.accessToken.token,
          accessTokenValidUntil: refreshed.accessToken.validUntil,
          refreshToken: entry.refreshToken,
          refreshTokenValidUntil: entry.refreshTokenValidUntil,
        };
        await this.keychain.setTokens(this.config.environment, nip, tokens);
        return tokens;
      } catch (error) {
        this.logger.warn(
          { err: (error as Error).message },
          "Refresh token failed, re-authenticating",
        );
      }
    }

    const tokens = await this.authenticate(nip, entry.ksefToken);
    await this.keychain.setTokens(this.config.environment, nip, tokens);
    return tokens;
  }

  private async authenticate(
    nip: string,
    ksefToken: string,
  ): Promise<AuthTokens> {
    this.logger.debug({ nip }, "Starting token authentication");
    const challenge = await this.client.getAuthChallenge();
    this.logger.debug({ nip }, "Received authentication challenge");
    const certs = await this.client.getPublicKeyCertificates();
    const cert = selectCertificateByUsage(certs, "KsefTokenEncryption");
    const publicKey = createPublicKeyFromCertificate(cert);
    this.logger.debug({ nip }, "Selected public key certificate");
    const timestampMs =
      challenge.timestampMs ?? new Date(challenge.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) {
      throw new AuthError("Invalid authentication challenge timestamp");
    }
    const plaintext = Buffer.from(`${ksefToken}|${timestampMs}`, "utf-8");
    const encrypted = rsaOaepSha256Encrypt(publicKey, plaintext).toString(
      "base64",
    );
    this.logger.debug({ nip }, "Submitting token authentication");
    const init = await this.client.submitKsefTokenAuth({
      challenge: challenge.challenge,
      contextIdentifier: { type: "Nip", value: nip },
      encryptedToken: encrypted,
      authorizationPolicy: this.config.auth.authorizationPolicy ?? undefined,
    });

    const authenticationToken = init.authenticationToken.token;
    await this.waitForAuthCompletion(init.referenceNumber, authenticationToken);
    const tokens = await this.client.redeemToken(authenticationToken);
    this.logger.debug({ nip }, "Authentication completed");
    return this.toAuthTokens(tokens);
  }

  private async waitForAuthCompletion(
    referenceNumber: string,
    authenticationToken: string,
  ): Promise<void> {
    const maxAttempts = this.config.operational.authPollMaxAttempts;
    const intervalMs = this.config.operational.pollIntervalSeconds * 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const status = await this.client.getAuthStatus(
        referenceNumber,
        authenticationToken,
      );
      if (status.status.code >= 200 && status.status.code < 300) {
        return;
      }
      if (status.status.code >= 400) {
        throw new AuthError(
          `Authentication failed: ${status.status.description}`,
        );
      }
      const description = sanitizeForTerminal(status.status.description);
      this.logger.info(
        { attempt, status: description },
        "Authentication in progress",
      );
      const baseMessage = `Progress: authentication in progress (${description})`;
      if (this.progress) {
        this.reportProgress(baseMessage);
        await sleepWithCountdown(
          intervalMs,
          this.countdownIntervalSeconds,
          (remaining: number) => {
            this.reportProgress(
              `${baseMessage}, next check in ${formatDuration(remaining)}`,
            );
          },
        );
      } else {
        await sleep(intervalMs);
      }
    }
    throw new AuthError("Authentication timed out");
  }

  private toAuthTokens(response: AuthenticationTokensResponse): AuthTokens {
    return {
      accessToken: response.accessToken.token,
      accessTokenValidUntil: response.accessToken.validUntil,
      refreshToken: response.refreshToken.token,
      refreshTokenValidUntil: response.refreshToken.validUntil,
    };
  }
}
