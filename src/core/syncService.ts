import type { InvoiceExportStatusResponse } from "../api/ksefClient";
import type { KsefClient } from "../api/ksefClient";
import type { AuthService, AuthTokens } from "../auth/authService";
import type { AppConfig, SubjectType } from "../config/schema";
import type { SqliteStore } from "../db/sqlite";
import type { Logger } from "pino";
import AdmZip from "adm-zip";
import { xml2js } from "xml-js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveBaseUrl } from "../config/environment";
import {
  getContinuationPoint,
  getInvoice,
  getSyncState,
  setContinuationPoint,
  setSyncState,
  upsertInvoice,
} from "../db/repository";
import { PdfService } from "../services/pdfService";
import { decryptAes256Cbc, sha256Base64 } from "../utils/crypto";
import { ConfigError } from "../utils/errors";
import { formatDuration, sleep, sleepWithCountdown } from "../utils/time";
import { createEncryptionData, selectCertificateByUsage } from "./encryption";
import {
  analyzeInvoicePayment,
  isEligibleForNotification,
} from "./invoicePaymentAnalyzer";
import { atomicWriteFile, ensureStorageDirs, getInvoiceDir } from "./storage";

export type SyncItem = {
  nip: string;
  ksefNumber: string;
  path: string;
  dueDate: string | null;
  needsPaymentNotification: boolean;
};

export type SyncResult = {
  downloaded: number;
  skipped: number;
  failed: number;
  items: SyncItem[];
};

type MetadataFile = {
  invoices?: (Record<string, unknown> & {
    ksefNumber?: string;
    permanentStorageDate?: string;
  })[];
};

const maxDateRangeMonths = 3;
const ksefStartDateIso = "2026-02-01T00:00:00Z";

const pLimit = <T, R>(concurrency: number) => {
  if (concurrency === 1) {
    return (_fn: (item: T) => Promise<R>) =>
      (items: T[]): Promise<R[]> =>
        Promise.all(items.map(_fn));
  }
  return (fn: (item: T) => Promise<R>) =>
    (items: T[]): Promise<R[]> =>
      new Promise((resolve, reject) => {
        if (items.length === 0) {
          resolve([]);
          return;
        }

        const results = new Array<R>(items.length);
        let currentIndex = 0;
        let activeCount = 0;
        let completedCount = 0;
        let isSettled = false;

        const resolveIfComplete = () => {
          if (completedCount !== items.length || isSettled) return;
          isSettled = true;
          resolve(results);
        };

        const rejectOnce = (error: unknown) => {
          if (isSettled) return;
          isSettled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        const processNext = () => {
          if (isSettled) return;

          while (activeCount < concurrency && currentIndex < items.length) {
            const index = currentIndex++;
            const item = items[index] as T;
            activeCount++;
            fn(item)
              .then((result) => {
                results[index] = result;
                activeCount--;
                completedCount++;
                resolveIfComplete();
                processNext();
              })
              .catch((error: unknown) => {
                activeCount--;
                rejectOnce(error);
              });
          }
        };

        processNext();
      });
};

const addUtcMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const minDate = (first: Date, second: Date): Date =>
  first.getTime() <= second.getTime() ? first : second;

const maxDate = (first: Date, second: Date): Date =>
  first.getTime() >= second.getTime() ? first : second;

const outOfRangeErrorToken =
  "zakres filtrowania wykracza poza dostepny zakres danych";

const maxInvoiceNumberXmlBytes = 5_000_000;
const maxInvoiceFileBaseLength = 180;
const maxZipEntries = 2000;
const maxZipEntryBytes = 20_000_000;
const maxZipTotalBytes = 200_000_000;
const maxInvoicePdfXmlBytes = 5_000_000;
const maxDecryptedPackageBytes = 200_000_000;

const invoiceNumberKeys = new Set(["p_2", "nrfaktury", "numerfaktury"]);

const stripDoctype = (xml: string): string =>
  xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");

const isOutOfRangeError = (message: string): boolean => {
  const normalized = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized.includes(outOfRangeErrorToken);
};

const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const stripPrefixes = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripPrefixes);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const normalizedKey = key.includes(":") ? key.split(":")[1] : key;
        return [normalizedKey, stripPrefixes(entry)];
      }),
    );
  }
  return value;
};

const extractTextValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { _text?: unknown; _cdata?: unknown };
    if (typeof record._text === "string") return record._text;
    if (typeof record._cdata === "string") return record._cdata;
  }
  return null;
};

const findInvoiceNumber = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const match = findInvoiceNumber(entry);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (invoiceNumberKeys.has(key.toLowerCase())) {
      const direct = extractTextValue(value);
      if (direct) return direct;
    }
  }
  for (const value of Object.values(node)) {
    const nested = findInvoiceNumber(value);
    if (nested) return nested;
  }
  return null;
};

const extractInvoiceNumber = (xml: string): string | null => {
  if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
    return null;
  }
  try {
    const parsed = xml2js(stripDoctype(xml), { compact: true }) as unknown;
    return findInvoiceNumber(stripPrefixes(parsed));
  } catch {
    return null;
  }
};

const sanitizeFileName = (value: string): string => {
  const cleaned = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f]/g, "");
  const truncated =
    cleaned.length > maxInvoiceFileBaseLength
      ? cleaned.slice(0, maxInvoiceFileBaseLength)
      : cleaned;
  return truncated.trim().replace(/[. ]+$/g, "");
};

const hasValidInvoiceXml = async (
  invoiceDir: string,
  expectedHash: string | null,
): Promise<boolean> => {
  try {
    const entries = await fs.readdir(invoiceDir);
    const xmlNames = entries.filter((entry) => entry.endsWith(".xml"));
    if (xmlNames.length === 0) return false;
    if (!expectedHash) return false;
    for (const xmlName of xmlNames) {
      try {
        const xmlData = await fs.readFile(path.join(invoiceDir, xmlName));
        if (sha256Base64(xmlData) === expectedHash) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
};

const resolveInvoiceFileBase = (xml: string, ksefNumber: string): string => {
  const invoiceNumber = extractInvoiceNumber(xml);
  if (!invoiceNumber) return ksefNumber;
  const safeInvoiceNumber = sanitizeFileName(invoiceNumber);
  if (!safeInvoiceNumber) return ksefNumber;
  const baseName = sanitizeFileName(`Faktura nr ${safeInvoiceNumber}`);
  return baseName || ksefNumber;
};

const createSyncItem = (
  nip: string,
  ksefNumber: string,
  path: string,
  xmlText: string,
): SyncItem => {
  const paymentInfo = analyzeInvoicePayment(xmlText, nip);
  return {
    nip,
    ksefNumber,
    path,
    dueDate: paymentInfo.dueDate,
    needsPaymentNotification: isEligibleForNotification(paymentInfo),
  };
};

const parseIsoDate = (value: string, label: string): Date => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ConfigError(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const resolveNextCursor = (
  packageInfo: InvoiceExportStatusResponse["package"] | undefined,
  fallback: string,
): string => {
  if (packageInfo?.isTruncated && packageInfo.lastPermanentStorageDate) {
    return packageInfo.lastPermanentStorageDate;
  }
  if (packageInfo?.permanentStorageHwmDate) {
    return packageInfo.permanentStorageHwmDate;
  }
  return fallback;
};

export class SyncService {
  private client: KsefClient;
  private auth: AuthService;
  private config: AppConfig;
  private logger: Logger;
  private store: SqliteStore;
  private progress?: (message: string) => void;
  private encryptionCertificate?: string;
  private countdownIntervalSeconds: number;
  private pdfService: PdfService;

  constructor(
    client: KsefClient,
    auth: AuthService,
    config: AppConfig,
    logger: Logger,
    store: SqliteStore,
    progress?: (message: string) => void,
    countdownIntervalSeconds = 60,
    pdfService = new PdfService(),
  ) {
    this.client = client;
    this.auth = auth;
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.progress = progress;
    this.countdownIntervalSeconds = countdownIntervalSeconds;
    this.pdfService = pdfService;
  }

  private reportProgress(message: string): void {
    if (!this.progress) return;
    this.progress(message);
  }

  private async sleepWithProgress(
    baseMessage: string,
    durationMs: number,
    buildCountdownMessage: (remaining: number) => string,
  ): Promise<void> {
    if (this.progress) {
      this.reportProgress(baseMessage);
      await sleepWithCountdown(
        durationMs,
        this.countdownIntervalSeconds,
        (remaining: number) => {
          this.reportProgress(buildCountdownMessage(remaining));
        },
      );
      return;
    }
    await sleep(durationMs);
  }

  private async maybeWritePdf(
    invoiceDir: string,
    xmlText: string,
    ksefNumber: string,
    nip: string,
    fileBaseName: string,
  ): Promise<void> {
    if (!this.config.sync.generatePdf) return;
    if (Buffer.byteLength(xmlText, "utf-8") > maxInvoicePdfXmlBytes) {
      this.logger.warn(
        { nip, ksefNumber, maxBytes: maxInvoicePdfXmlBytes },
        "Invoice XML too large for PDF generation",
      );
      return;
    }
    try {
      const pdfResult = await this.pdfService.generateInvoicePdf(
        xmlText,
        ksefNumber,
      );
      if (pdfResult.status === "ok") {
        await atomicWriteFile(
          path.join(invoiceDir, `${fileBaseName}.pdf`),
          pdfResult.buffer,
        );
      } else {
        this.logger.warn(
          {
            err: pdfResult.message,
            reason: pdfResult.reason,
            nip,
            ksefNumber,
          },
          "Failed to generate invoice PDF",
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          err: (error as Error).message,
          nip,
          ksefNumber,
        },
        "Failed to generate invoice PDF",
      );
    }
  }

  private async getEncryptionCertificate(): Promise<string> {
    if (this.encryptionCertificate) return this.encryptionCertificate;
    const certs = await this.client.getPublicKeyCertificates();
    const cert = selectCertificateByUsage(certs, "SymmetricKeyEncryption");
    this.encryptionCertificate = cert;
    return cert;
  }

  async runOnce(
    forceRedownloadId?: string,
    nipFilter?: string,
    forceRedownloadAll = false,
  ): Promise<SyncResult> {
    await ensureStorageDirs(this.config.storage.root);
    const nips = nipFilter
      ? [nipFilter]
      : this.config.organizations.map((org) => org.nip);
    if (nips.length === 0) {
      throw new Error("No organizations configured");
    }
    const maxConcurrent = this.config.sync.maxConcurrentNips ?? 1;
    this.logger.debug(
      { nipCount: nips.length, maxConcurrent },
      "Starting sync run",
    );

    const summary: SyncResult = {
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };

    const syncSingleNip = async (
      nip: string,
      tokens: AuthTokens,
    ): Promise<SyncResult> => {
      const nipResult: SyncResult = {
        downloaded: 0,
        skipped: 0,
        failed: 0,
        items: [],
      };
      const accessToken = tokens.accessToken;
      const forced =
        forceRedownloadId && !nipFilter
          ? await this.downloadByKsefNumber(accessToken, nip, forceRedownloadId)
          : null;
      if (forced) {
        nipResult.downloaded += 1;
        nipResult.items.push(forced);
      }

      for (const subjectType of this.config.sync.subjectTypes) {
        this.logger.debug(
          { nip, subjectType },
          "Requesting export for subject type",
        );
        const subjectResult = await this.syncSubjectType(
          accessToken,
          nip,
          subjectType,
          forceRedownloadId,
          Boolean(forced),
          forceRedownloadAll,
        );
        nipResult.downloaded += subjectResult.downloaded;
        nipResult.skipped += subjectResult.skipped;
        nipResult.failed += subjectResult.failed;
        nipResult.items.push(...subjectResult.items);
      }
      return nipResult;
    };

    const syncNipWithAuth = async (nip: string): Promise<SyncResult> => {
      this.logger.debug({ nip }, "Syncing NIP");
      this.reportProgress(`Progress: syncing NIP ${nip}`);
      const tokens = await this.auth.getAccessToken(nip);
      return syncSingleNip(nip, tokens);
    };

    try {
      const limit = pLimit<string, SyncResult>(maxConcurrent);
      const results = await limit(syncNipWithAuth)(nips);

      for (const result of results) {
        summary.downloaded += result.downloaded;
        summary.skipped += result.skipped;
        summary.failed += result.failed;
        summary.items.push(...result.items);
      }

      await this.store.withDb((db) => {
        const previous = getSyncState(db);
        const lastSuccessAt =
          summary.failed === 0
            ? new Date().toISOString()
            : previous.last_success_at;
        const lastError =
          summary.failed === 0 ? null : `partial failures: ${summary.failed}`;
        setSyncState(db, {
          last_sync_at: new Date().toISOString(),
          last_success_at: lastSuccessAt,
          last_error: lastError,
          last_downloaded_count: summary.downloaded,
        });
        return previous;
      });

      return summary;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.debug({ err: message }, "Sync run failed");
      await this.store.withDb((db) => {
        const previous = getSyncState(db);
        setSyncState(db, {
          last_sync_at: new Date().toISOString(),
          last_success_at: previous.last_success_at,
          last_error: message,
          last_downloaded_count: summary.downloaded,
        });
        return previous;
      });
      throw error;
    }
  }

  async runDaemon(): Promise<void> {
    this.logger.info("Starting daemon mode");

    while (true) {
      try {
        const result = await this.runOnce();
        this.logger.info(result, "Sync cycle completed");
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error({ err: message }, "Sync cycle failed");
        await this.store.withDb((db) =>
          setSyncState(db, {
            last_sync_at: new Date().toISOString(),
            last_success_at: getSyncState(db).last_success_at,
            last_error: message,
            last_downloaded_count: getSyncState(db).last_downloaded_count,
          }),
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.pollingIntervalSeconds * 1000),
      );
    }
  }

  private async syncSubjectType(
    accessToken: string,
    nip: string,
    subjectType: SubjectType,
    forceRedownloadId?: string,
    skipForcedId = false,
    forceRedownloadAll = false,
  ): Promise<SyncResult> {
    const now = new Date();
    const ksefStartDate = parseIsoDate(ksefStartDateIso, "KSeF start date");
    const defaultFrom = maxDate(
      ksefStartDate,
      addUtcMonths(now, -maxDateRangeMonths),
    );
    const cursor = forceRedownloadAll
      ? null
      : await this.store.withDb((db) =>
          getContinuationPoint(db, nip, subjectType),
        );
    const configuredStart = forceRedownloadAll
      ? this.config.sync.initialSyncFrom
        ? maxDate(
            parseIsoDate(this.config.sync.initialSyncFrom, "initialSyncFrom"),
            ksefStartDate,
          )
        : ksefStartDate
      : this.config.sync.initialSyncFrom
        ? maxDate(
            parseIsoDate(this.config.sync.initialSyncFrom, "initialSyncFrom"),
            ksefStartDate,
          )
        : defaultFrom;
    let windowStart = configuredStart;
    if (cursor) {
      const cursorDate = parseIsoDate(cursor, "continuation point");
      if (cursorDate.getTime() < configuredStart.getTime()) {
        const floorIso = configuredStart.toISOString();
        await this.store.withDb((db) =>
          setContinuationPoint(db, nip, subjectType, floorIso),
        );
        windowStart = configuredStart;
      } else {
        windowStart = cursorDate;
      }
    }
    if (windowStart.getTime() > now.getTime()) {
      windowStart = now;
    }
    if (forceRedownloadAll) {
      await this.store.withDb((db) =>
        setContinuationPoint(db, nip, subjectType, windowStart.toISOString()),
      );
    }

    const summary: SyncResult = {
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
    const exportCooldownSeconds = Math.max(
      0,
      this.config.operational.exportCooldownSeconds ?? 0,
    );
    const exportCooldownMs = exportCooldownSeconds * 1000;
    let windowIndex = 0;

    while (windowStart.getTime() < now.getTime()) {
      if (windowIndex > 0 && exportCooldownMs > 0) {
        const baseMessage = `Progress: waiting ${formatDuration(exportCooldownMs)} before next export`;
        await this.sleepWithProgress(
          baseMessage,
          exportCooldownMs,
          (remaining: number) =>
            `Progress: waiting ${formatDuration(remaining)} before next export`,
        );
      }
      windowIndex += 1;
      const windowEnd = minDate(
        addUtcMonths(windowStart, maxDateRangeMonths),
        now,
      );
      const fromDate = windowStart.toISOString();
      const toDate = windowEnd.toISOString();
      this.logger.debug(
        { nip, subjectType, fromDate, toDate },
        "Resolved sync window",
      );
      this.reportProgress(
        `Progress: ${nip} ${subjectType} window ${fromDate.slice(0, 10)} -> ${toDate.slice(0, 10)}`,
      );

      const certificate = await this.getEncryptionCertificate();
      const encryption = await createEncryptionData(this.client, certificate);
      const request = {
        encryption: encryption.encryptionInfo,
        filters: {
          subjectType,
          dateRange: {
            dateType: "PermanentStorage",
            from: fromDate,
            to: toDate,
            restrictToPermanentStorageHwmDate: true,
          },
        },
      };

      let status: InvoiceExportStatusResponse;
      try {
        const exportResponse = await this.client.exportInvoices(
          accessToken,
          request,
          this.config.sync.includeMetadataHeader,
        );
        this.reportProgress("Progress: export requested");
        this.logger.debug(
          { nip, subjectType, referenceNumber: exportResponse.referenceNumber },
          "Export request accepted",
        );
        status = await this.waitForExport(
          accessToken,
          exportResponse.referenceNumber,
        );
      } catch (error) {
        const message = (error as Error).message;
        if (isOutOfRangeError(message)) {
          this.logger.warn(
            { nip, subjectType, fromDate, toDate, err: message },
            "Export window outside available data, skipping",
          );
          this.reportProgress(
            "Progress: export window outside available data, skipping",
          );
          await this.store.withDb((db) =>
            setContinuationPoint(db, nip, subjectType, toDate),
          );
          const nextFrom = parseIsoDate(toDate, "continuation point");
          if (nextFrom.getTime() <= windowStart.getTime()) {
            this.logger.warn(
              { nip, subjectType, nextCursor: toDate },
              "Continuation point did not advance",
            );
            break;
          }
          windowStart = nextFrom;
          continue;
        }
        throw error;
      }

      const packageInfo = status.package;
      const parts = packageInfo?.parts;
      if (!parts || parts.length === 0) {
        this.logger.debug({ nip, subjectType }, "No package parts available");
        this.reportProgress("Progress: no package parts");
        await this.store.withDb((db) =>
          setContinuationPoint(db, nip, subjectType, toDate),
        );
        const nextFrom = parseIsoDate(toDate, "continuation point");
        if (nextFrom.getTime() <= windowStart.getTime()) {
          this.logger.warn(
            { nip, subjectType, nextCursor: toDate },
            "Continuation point did not advance",
          );
          break;
        }
        windowStart = nextFrom;
        continue;
      }

      const nextCursor = resolveNextCursor(packageInfo, toDate);

      this.logger.debug(
        { nip, subjectType, partCount: parts.length },
        "Downloading package parts",
      );
      this.reportProgress(`Progress: downloading ${parts.length} part(s)`);
      const decrypted = await this.downloadAndDecryptParts(
        parts,
        encryption.key,
        encryption.iv,
      );
      const zip = new AdmZip(decrypted);
      const entries = zip.getEntries();
      if (entries.length > maxZipEntries) {
        throw new Error("Export package has too many entries");
      }
      let totalBytes = 0;
      for (const entry of entries) {
        const entrySize = entry.header?.size ?? 0;
        if (entrySize > maxZipEntryBytes) {
          throw new Error(`Export entry too large: ${entry.entryName}`);
        }
        totalBytes += entrySize;
        if (totalBytes > maxZipTotalBytes) {
          throw new Error("Export package is too large");
        }
      }

      let actualTotalBytes = 0;
      const metadataEntry = entries.find(
        (entry) => entry.entryName === "_metadata.json",
      );
      let metadata: MetadataFile | undefined;
      if (metadataEntry) {
        try {
          const metadataBuffer = metadataEntry.getData();
          actualTotalBytes += metadataBuffer.length;
          if (metadataBuffer.length > maxZipEntryBytes) {
            throw new Error("Metadata entry too large");
          }
          if (actualTotalBytes > maxZipTotalBytes) {
            throw new Error("Export package is too large");
          }
          metadata = JSON.parse(
            metadataBuffer.toString("utf-8"),
          ) as MetadataFile;
        } catch (error) {
          this.logger.warn(
            { err: (error as Error).message },
            "Failed to parse metadata JSON",
          );
        }
      }
      const metadataMap = new Map<string, Record<string, unknown>>();
      metadata?.invoices?.forEach((invoice) => {
        if (invoice.ksefNumber) metadataMap.set(invoice.ksefNumber, invoice);
      });

      let downloaded = 0;
      let skipped = 0;
      let failed = 0;
      const items: SyncItem[] = [];

      for (const entry of entries) {
        if (!entry.entryName.endsWith(".xml")) continue;
        const ksefNumber = path.basename(entry.entryName, ".xml");
        const isForce = forceRedownloadId && ksefNumber === forceRedownloadId;
        if (isForce && skipForcedId) {
          continue;
        }
        const existing = await this.store.withDb((db) =>
          getInvoice(db, nip, ksefNumber),
        );
        const hasFiles =
          existing?.status === "downloaded" && existing.file_path
            ? await hasValidInvoiceXml(existing.file_path, existing.hash)
            : false;

        if (
          existing?.status === "downloaded" &&
          !isForce &&
          !forceRedownloadAll &&
          hasFiles
        ) {
          skipped += 1;
          continue;
        }

        try {
          const xmlData = entry.getData();
          if (xmlData.length > maxZipEntryBytes) {
            throw new Error(`Export entry too large: ${entry.entryName}`);
          }
          actualTotalBytes += xmlData.length;
          if (actualTotalBytes > maxZipTotalBytes) {
            throw new Error("Export package is too large");
          }
          const xmlText = xmlData.toString("utf-8");
          const hash = sha256Base64(xmlData);
          const meta = metadataMap.get(ksefNumber) ?? {};
          const dateString = (meta as { permanentStorageDate?: string })
            .permanentStorageDate;
          let storageDate = new Date();
          if (dateString) {
            const parsedDate = new Date(dateString);
            if (Number.isFinite(parsedDate.getTime())) {
              storageDate = parsedDate;
            } else {
              this.logger.warn(
                { nip, ksefNumber, dateString },
                "Invalid permanentStorageDate, using current time",
              );
            }
          }
          const invoiceDir = getInvoiceDir(
            this.config.storage.root,
            storageDate,
            nip,
            ksefNumber,
          );
          const fileBaseName = resolveInvoiceFileBase(xmlText, ksefNumber);
          await atomicWriteFile(
            path.join(invoiceDir, `${fileBaseName}.xml`),
            xmlData,
          );
          await atomicWriteFile(
            path.join(invoiceDir, "metadata.json"),
            JSON.stringify(
              {
                ksefNumber,
                nip,
                downloadedAt: new Date().toISOString(),
                sourceEnvironment: this.config.environment,
                hash,
                metadata: meta,
              },
              null,
              2,
            ),
          );

          await this.maybeWritePdf(
            invoiceDir,
            xmlText,
            ksefNumber,
            nip,
            fileBaseName,
          );

          await this.store.withDb((db) =>
            upsertInvoice(db, {
              nip,
              ksef_number: ksefNumber,
              file_path: invoiceDir,
              hash,
              status: "downloaded",
              downloaded_at: new Date().toISOString(),
              received_at: dateString ?? null,
              error: null,
            }),
          );
          downloaded += 1;
          items.push(createSyncItem(nip, ksefNumber, invoiceDir, xmlText));
        } catch (error) {
          await this.store.withDb((db) =>
            upsertInvoice(db, {
              nip,
              ksef_number: ksefNumber,
              file_path: existing?.file_path ?? "",
              hash: existing?.hash ?? null,
              status: "failed",
              downloaded_at: existing?.downloaded_at ?? null,
              received_at: existing?.received_at ?? null,
              error: (error as Error).message,
            }),
          );
          failed += 1;
        }
      }

      summary.downloaded += downloaded;
      summary.skipped += skipped;
      summary.failed += failed;
      summary.items.push(...items);
      this.reportProgress(
        `Progress: window complete (downloaded=${downloaded}, skipped=${skipped}, failed=${failed})`,
      );

      if (failed > 0) {
        return summary;
      }

      await this.store.withDb((db) =>
        setContinuationPoint(db, nip, subjectType, nextCursor),
      );
      const nextFrom = parseIsoDate(nextCursor, "continuation point");
      if (nextFrom.getTime() <= windowStart.getTime()) {
        this.logger.warn(
          { nip, subjectType, nextCursor },
          "Continuation point did not advance",
        );
        break;
      }
      windowStart = nextFrom;
    }

    return summary;
  }

  private async waitForExport(
    accessToken: string,
    referenceNumber: string,
  ): Promise<InvoiceExportStatusResponse> {
    const maxAttempts = this.config.operational.exportPollMaxAttempts;
    const intervalMs = this.config.operational.pollIntervalSeconds * 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const status = await this.client.getExportStatus(
        accessToken,
        referenceNumber,
      );
      if (status.status.code >= 200 && status.status.code < 300) {
        this.reportProgress("Progress: export ready");
        return status;
      }
      if (status.status.code >= 400) {
        throw new Error(`Export failed: ${status.status.description}`);
      }
      const description = sanitizeForTerminal(status.status.description);
      this.logger.info({ attempt, status: description }, "Export in progress");
      const baseMessage = `Progress: export in progress (${description})`;
      await this.sleepWithProgress(
        baseMessage,
        intervalMs,
        (remaining: number) =>
          `${baseMessage}, next check in ${formatDuration(remaining)}`,
      );
    }
    throw new Error("Export status polling timed out");
  }

  private async downloadAndDecryptParts(
    parts: NonNullable<InvoiceExportStatusResponse["package"]>["parts"],
    key: Buffer,
    iv: Buffer,
  ): Promise<Buffer> {
    const ordered = [...(parts ?? [])].sort(
      (a, b) => a.ordinalNumber - b.ordinalNumber,
    );
    const decryptedParts: Buffer[] = [];
    let decryptedTotalBytes = 0;
    const baseUrl =
      this.config.apiBaseUrl ?? resolveBaseUrl(this.config.environment);
    const normalizeHost = (host: string) =>
      host.trim().toLowerCase().replace(/\.$/, "");
    const baseHost = normalizeHost(new URL(baseUrl).hostname);
    const allowedHosts = (
      this.config.security.allowedHosts.length > 0
        ? this.config.security.allowedHosts
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
        this.config.security.tls.enablePinning &&
        this.config.security.tls.pinningHosts.length > 0 &&
        !this.config.security.tls.pinningHosts
          .map(normalizeHost)
          .includes(normalizedHost)
      ) {
        throw new Error(`Download host not pinned: ${normalizedHost}`);
      }
      if (
        resolvedUrl.protocol !== "https:" &&
        !this.config.operational.allowInsecureHttp
      ) {
        throw new Error(`Insecure download URL blocked: ${safeUrl}`);
      }
      const encrypted = await this.client.downloadPackagePart(
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

  private async downloadByKsefNumber(
    accessToken: string,
    nip: string,
    ksefNumber: string,
  ): Promise<SyncItem | null> {
    const xml = await this.client.downloadInvoiceXml(accessToken, ksefNumber);
    if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
      throw new Error("Invoice XML too large for direct download");
    }
    const date = new Date();
    const invoiceDir = getInvoiceDir(
      this.config.storage.root,
      date,
      nip,
      ksefNumber,
    );
    const xmlBuffer = Buffer.from(xml, "utf-8");
    const hash = sha256Base64(xmlBuffer);
    const fileBaseName = resolveInvoiceFileBase(xml, ksefNumber);

    await atomicWriteFile(
      path.join(invoiceDir, `${fileBaseName}.xml`),
      xmlBuffer,
    );
    await atomicWriteFile(
      path.join(invoiceDir, "metadata.json"),
      JSON.stringify(
        {
          ksefNumber,
          nip,
          downloadedAt: new Date().toISOString(),
          sourceEnvironment: this.config.environment,
          hash,
          metadata: { source: "direct" },
        },
        null,
        2,
      ),
    );

    await this.maybeWritePdf(invoiceDir, xml, ksefNumber, nip, fileBaseName);

    await this.store.withDb((db) =>
      upsertInvoice(db, {
        nip,
        ksef_number: ksefNumber,
        file_path: invoiceDir,
        hash,
        status: "downloaded",
        downloaded_at: new Date().toISOString(),
        received_at: null,
        error: null,
      }),
    );

    return createSyncItem(nip, ksefNumber, invoiceDir, xml);
  }
}
