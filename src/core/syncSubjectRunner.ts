import type { StoredInvoiceMetadata } from "./invoiceWriter";
import type { PdfGenerationCircuitBreaker } from "./invoiceWriter";
import type { SyncResult } from "./syncService";
import type { ExplicitSyncWindow, MetadataFile } from "./window";
import type { KsefClient } from "../api/ksefClient";
import type { AppConfig, SubjectType } from "../config/schema";
import type { SqliteStore } from "../db/sqlite";
import type { PdfService } from "../services/pdfService";
import type { Logger } from "pino";
import AdmZip from "adm-zip";
import path from "node:path";
import {
  getContinuationPoint,
  getInvoice,
  setContinuationPoint,
  upsertInvoice,
} from "../db/repository";
import { sanitizeErrorMessage } from "../utils/errors";
import { formatDuration } from "../utils/time";
import { createEncryptionData } from "./encryption";
import {
  hasValidInvoiceXml,
  maxZipEntries,
  maxZipEntryBytes,
  maxZipTotalBytes,
} from "./invoiceExtractor";
import { downloadAndDecryptParts, waitForExport } from "./invoicePackageClient";
import { resolveInvoiceStorageTarget, writeInvoice } from "./invoiceWriter";
import {
  addUtcMonths,
  advanceWindow,
  isBelowMinExportWindow,
  isOutOfRangeError,
  ksefStartDateIso,
  maxDateRangeMonths,
  minDate,
  parseIsoDate,
  resolveConfiguredStart,
  resolveDefaultStart,
  resolveNextCursor,
} from "./window";

export type SyncSubjectRunnerDeps = {
  client: KsefClient;
  config: AppConfig;
  logger: Logger;
  store: SqliteStore;
  pdfService: PdfService;
  pdfCircuitBreaker?: PdfGenerationCircuitBreaker;
  reportProgress: (msg: string) => void;
  sleepWithProgress: (
    baseMsg: string,
    durationMs: number,
    buildCountdown: (remaining: number) => string,
  ) => Promise<void>;
  getEncryptionCertificate: () => Promise<string>;
};

export async function syncSubjectType(
  deps: SyncSubjectRunnerDeps,
  accessToken: string,
  nip: string,
  subjectType: SubjectType,
  forceRedownloadId?: string,
  skipForcedId = false,
  forceRedownloadAll = false,
  flatSync = false,
  outputPath?: string,
  explicitWindow?: ExplicitSyncWindow,
): Promise<SyncResult> {
  const {
    client,
    config,
    logger,
    store,
    pdfService,
    pdfCircuitBreaker,
    reportProgress,
    sleepWithProgress,
    getEncryptionCertificate,
  } = deps;

  const now = new Date();
  const ksefStartDate = parseIsoDate(ksefStartDateIso, "KSeF start date");
  const defaultFrom = resolveDefaultStart(now);

  let windowStart: Date;
  let windowEndCap: Date | undefined;
  if (explicitWindow) {
    windowStart = explicitWindow.from;
    windowEndCap = explicitWindow.to;
  } else {
    const cursor = forceRedownloadAll
      ? null
      : await store.withDb((db) => getContinuationPoint(db, nip, subjectType));
    const configuredStart = config.sync.initialSyncFrom
      ? resolveConfiguredStart(config.sync.initialSyncFrom, ksefStartDate)
      : forceRedownloadAll
        ? ksefStartDate
        : defaultFrom;
    windowStart = configuredStart;
    if (cursor) {
      const cursorDate = parseIsoDate(cursor, "continuation point");
      if (cursorDate.getTime() < configuredStart.getTime()) {
        const floorIso = configuredStart.toISOString();
        await store.withDb((db) =>
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
      await store.withDb((db) =>
        setContinuationPoint(db, nip, subjectType, windowStart.toISOString()),
      );
    }
  }

  const summary: SyncResult = {
    downloaded: 0,
    skipped: 0,
    failed: 0,
    pdfFailed: 0,
    items: [],
  };
  const exportCooldownMs =
    Math.max(0, config.operational.exportCooldownSeconds ?? 0) * 1000;
  let windowIndex = 0;

  const packageClientDeps = {
    client,
    config,
    logger,
    reportProgress,
    sleepWithProgress,
  };
  const writerDeps = { config, logger, store, pdfService, pdfCircuitBreaker };

  const upperBound = windowEndCap ?? now;
  while (windowStart.getTime() < upperBound.getTime()) {
    const windowEnd = windowEndCap
      ? minDate(addUtcMonths(windowStart, maxDateRangeMonths), windowEndCap)
      : minDate(addUtcMonths(windowStart, maxDateRangeMonths), now);

    if (
      isBelowMinExportWindow(
        windowStart,
        windowEnd,
        config.sync.minExportWindowSeconds,
      )
    ) {
      logger.debug(
        {
          nip,
          subjectType,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          minExportWindowSeconds: config.sync.minExportWindowSeconds,
        },
        "Export window narrower than configured minimum, skipping until more time accumulates",
      );
      break;
    }

    if (windowIndex > 0 && exportCooldownMs > 0) {
      const baseMessage = `Progress: waiting ${formatDuration(exportCooldownMs)} before next export`;
      await sleepWithProgress(
        baseMessage,
        exportCooldownMs,
        (remaining) =>
          `Progress: waiting ${formatDuration(remaining)} before next export`,
      );
    }
    windowIndex += 1;
    const fromDate = windowStart.toISOString();
    const toDate = windowEnd.toISOString();
    logger.debug(
      { nip, subjectType, fromDate, toDate },
      "Resolved sync window",
    );
    reportProgress(
      `Progress: ${nip} ${subjectType} window ${fromDate.slice(0, 10)} -> ${toDate.slice(0, 10)}`,
    );

    const certificate = await getEncryptionCertificate();
    const encryption = await createEncryptionData(client, certificate);
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

    let status: Awaited<ReturnType<typeof waitForExport>>;
    try {
      const exportResponse = await client.exportInvoices(
        accessToken,
        request,
        config.sync.includeMetadataHeader,
      );
      reportProgress("Progress: export requested");
      logger.debug(
        { nip, subjectType, referenceNumber: exportResponse.referenceNumber },
        "Export request accepted",
      );
      status = await waitForExport(
        packageClientDeps,
        accessToken,
        exportResponse.referenceNumber,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (isOutOfRangeError(message)) {
        // KSeF rejected the query outright: no data was returned, so the
        // cursor must stay put. Advancing it to our locally-derived `toDate`
        // would skip past a range KSeF hasn't verified yet, and any invoice
        // later assigned a permanentStorageDate inside that range would be
        // missed. Stop this subject's loop for this cycle; the next cycle
        // retries with a later `now` once enough time has accumulated.
        logger.warn(
          { nip, subjectType, fromDate, toDate, err: message },
          "Export window outside available data, skipping",
        );
        reportProgress(
          "Progress: export window outside available data, skipping",
        );
        break;
      }
      throw error;
    }

    const packageInfo = status.package;
    const parts = packageInfo?.parts;
    if (!parts || parts.length === 0) {
      logger.debug({ nip, subjectType }, "No package parts available");
      reportProgress("Progress: no package parts");
      await store.withDb((db) =>
        setContinuationPoint(db, nip, subjectType, toDate),
      );
      const { nextStart, stalled } = advanceWindow(windowStart, toDate);
      if (stalled) {
        logger.warn(
          { nip, subjectType, nextCursor: toDate },
          "Continuation point did not advance",
        );
        break;
      }
      windowStart = nextStart;
      continue;
    }

    const nextCursor = resolveNextCursor(packageInfo, toDate);

    logger.debug(
      { nip, subjectType, partCount: parts.length },
      "Downloading package parts",
    );
    reportProgress(`Progress: downloading ${parts.length} part(s)`);
    const decrypted = await downloadAndDecryptParts(
      packageClientDeps,
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
        metadata = JSON.parse(metadataBuffer.toString("utf-8")) as MetadataFile;
      } catch (error) {
        logger.warn(
          { err: (error as Error).message },
          "Failed to parse metadata JSON",
        );
      }
    }
    const metadataMap = new Map<string, StoredInvoiceMetadata>();
    metadata?.invoices?.forEach((invoice) => {
      if (invoice.ksefNumber) metadataMap.set(invoice.ksefNumber, invoice);
    });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let pdfFailed = 0;
    const items: typeof summary.items = [];

    for (const entry of entries) {
      if (!entry.entryName.endsWith(".xml")) continue;
      const ksefNumber = path.basename(entry.entryName, ".xml");
      const isForce = forceRedownloadId && ksefNumber === forceRedownloadId;
      if (isForce && skipForcedId) {
        continue;
      }
      const existing = await store.withDb((db) =>
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
        const meta = metadataMap.get(ksefNumber);
        const dateString = meta?.permanentStorageDate;
        let storageDate = new Date();
        if (dateString) {
          const parsedDate = new Date(dateString);
          if (Number.isFinite(parsedDate.getTime())) {
            storageDate = parsedDate;
          } else {
            logger.warn(
              { nip, ksefNumber, dateString },
              "Invalid permanentStorageDate, using current time",
            );
          }
        }
        const storageTarget = await resolveInvoiceStorageTarget(
          writerDeps,
          nip,
          storageDate,
          ksefNumber,
          xmlText,
          flatSync,
          meta,
          outputPath,
        );
        const syncItem = await writeInvoice(writerDeps, {
          nip,
          ksefNumber,
          xmlData,
          xmlText,
          storageTarget,
          receivedDate: dateString ?? null,
          sourceEnvironment: config.environment,
          metadataMeta: meta,
        });
        downloaded += 1;
        if (config.sync.generatePdf && !syncItem.pdfPath) {
          pdfFailed += 1;
        }
        items.push(syncItem);
      } catch (error) {
        const sanitizedMessage = sanitizeErrorMessage((error as Error).message);
        await store.withDb((db) =>
          upsertInvoice(db, {
            nip,
            ksef_number: ksefNumber,
            file_path: existing?.file_path ?? "",
            hash: existing?.hash ?? null,
            status: "failed",
            downloaded_at: existing?.downloaded_at ?? null,
            received_at: existing?.received_at ?? null,
            error: sanitizedMessage,
          }),
        );
        failed += 1;
      }
    }

    summary.downloaded += downloaded;
    summary.skipped += skipped;
    summary.failed += failed;
    summary.pdfFailed += pdfFailed;
    summary.items.push(...items);
    reportProgress(
      `Progress: window complete (downloaded=${downloaded}, skipped=${skipped}, failed=${failed}, pdfFailed=${pdfFailed})`,
    );

    if (!explicitWindow) {
      await store.withDb((db) =>
        setContinuationPoint(db, nip, subjectType, nextCursor),
      );
    }

    if (failed > 0) {
      return summary;
    }
    const { nextStart, stalled } = advanceWindow(windowStart, nextCursor);
    if (stalled) {
      logger.warn(
        { nip, subjectType, nextCursor },
        "Continuation point did not advance",
      );
      break;
    }
    windowStart = nextStart;
  }

  return summary;
}
