import type { InvoiceExportStatusResponse, KsefClient } from "../api/ksefClient";
import type { AppConfig } from "../config/schema";
import type { Logger } from "pino";
import { sanitizeForTerminal } from "../cli/commandTree";
import { resolveBaseUrl } from "../config/environment";
import { decryptAes256Cbc, sha256Base64 } from "../utils/crypto";
import { formatDuration } from "../utils/time";
import { maxDecryptedPackageBytes } from "./invoiceExtractor";

export type PackageClientDeps = {
  client: KsefClient;
  config: AppConfig;
  logger: Logger;
  reportProgress: (msg: string) => void;
  sleepWithProgress: (
    baseMsg: string,
    durationMs: number,
    buildCountdown: (remaining: number) => string,
  ) => Promise<void>;
};

export async function waitForExport(
  deps: PackageClientDeps,
  accessToken: string,
  referenceNumber: string,
): Promise<InvoiceExportStatusResponse> {
  const { client, config, logger, reportProgress, sleepWithProgress } = deps;
  const maxAttempts = config.operational.exportPollMaxAttempts;
  const intervalMs = config.operational.pollIntervalSeconds * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await client.getExportStatus(accessToken, referenceNumber);
    if (status.status.code >= 200 && status.status.code < 300) {
      reportProgress("Progress: export ready");
      return status;
    }
    if (status.status.code >= 400) {
      throw new Error(`Export failed: ${status.status.description}`);
    }
    const description = sanitizeForTerminal(status.status.description);
    logger.info({ attempt, status: description }, "Export in progress");
    const baseMessage = `Progress: export in progress (${description})`;
    await sleepWithProgress(
      baseMessage,
      intervalMs,
      (remaining) =>
        `${baseMessage}, next check in ${formatDuration(remaining)}`,
    );
  }
  throw new Error("Export status polling timed out");
}

export async function downloadAndDecryptParts(
  deps: Pick<PackageClientDeps, "client" | "config">,
  parts: NonNullable<InvoiceExportStatusResponse["package"]>["parts"],
  key: Buffer,
  iv: Buffer,
): Promise<Buffer> {
  const { client, config } = deps;
  const ordered = [...(parts ?? [])].sort(
    (a, b) => a.ordinalNumber - b.ordinalNumber,
  );
  const decryptedParts: Buffer[] = [];
  let decryptedTotalBytes = 0;
  const baseUrl = config.apiBaseUrl ?? resolveBaseUrl(config.environment);
  const normalizeHost = (host: string) =>
    host.trim().toLowerCase().replace(/\.$/, "");
  const baseHost = normalizeHost(new URL(baseUrl).hostname);
  const allowedHosts = (
    config.security.allowedHosts.length > 0
      ? config.security.allowedHosts
      : [baseHost]
  ).map(normalizeHost);

  for (const part of ordered) {
    const resolvedUrl = new URL(part.url, baseUrl);
    const safeUrl = `${resolvedUrl.hostname}${resolvedUrl.pathname}`;
    const normalizedHost = normalizeHost(resolvedUrl.hostname);
    if (!allowedHosts.includes(normalizedHost)) {
      throw new Error(`Disallowed download host: ${normalizedHost}`);
    }
    if (
      config.security.tls.enablePinning &&
      config.security.tls.pinningHosts.length > 0 &&
      !config.security.tls.pinningHosts
        .map(normalizeHost)
        .includes(normalizedHost)
    ) {
      throw new Error(`Download host not pinned: ${normalizedHost}`);
    }
    if (
      resolvedUrl.protocol !== "https:" &&
      !config.operational.allowInsecureHttp
    ) {
      throw new Error(`Insecure download URL blocked: ${safeUrl}`);
    }
    const encrypted = await client.downloadPackagePart(
      resolvedUrl.toString(),
      part.method ?? "GET",
    );
    if (part.encryptedPartHash) {
      const encryptedHash = sha256Base64(encrypted);
      if (encryptedHash !== part.encryptedPartHash) {
        throw new Error(`Encrypted part hash mismatch for ${part.partName}`);
      }
    }
    const decrypted = decryptAes256Cbc(key, iv, encrypted);
    decryptedTotalBytes += decrypted.length;
    if (decryptedTotalBytes > maxDecryptedPackageBytes) {
      throw new Error("Decrypted package is too large");
    }
    if (part.partHash) {
      const decryptedHash = sha256Base64(decrypted);
      if (decryptedHash !== part.partHash) {
        throw new Error(`Decrypted part hash mismatch for ${part.partName}`);
      }
    }
    decryptedParts.push(decrypted);
  }

  return Buffer.concat(decryptedParts);
}
