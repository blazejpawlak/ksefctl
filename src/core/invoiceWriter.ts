import type { InvoiceFileMetadata } from "./invoiceExtractor";
import type { SyncItem } from "./invoiceExtractor";
import type { AppConfig } from "../config/schema";
import type { SqliteStore } from "../db/sqlite";
import type { PdfService } from "../services/pdfService";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import { upsertInvoice } from "../db/repository";
import { sha256Base64 } from "../utils/crypto";
import {
  createSyncItem,
  maxInvoicePdfXmlBytes,
  resolveFlatInvoiceFileBase,
  resolveInvoiceFileBase,
  sanitizeFileName,
} from "./invoiceExtractor";
import {
  atomicWriteFile,
  getFlatInvoiceDirForRoot,
  getInvoiceDirForRoot,
  resolveInvoiceOutputRoot,
} from "./storage";

export type { SyncItem };

export type StoredInvoiceMetadata = InvoiceFileMetadata & {
  ksefNumber?: string;
  permanentStorageDate?: string;
};

export type InvoiceStorageTarget = {
  invoiceDir: string;
  fileBaseName: string;
  metadataFileName: string;
};

export type InvoiceWriterDeps = {
  config: AppConfig;
  logger: Logger;
  store: SqliteStore;
  pdfService: PdfService;
  pdfCircuitBreaker?: PdfGenerationCircuitBreaker;
};

export type PdfGenerationCircuitBreaker = {
  consecutiveTimeouts: number;
  maxConsecutiveTimeouts: number;
  disabled: boolean;
};

// ---- private helpers ----

function resolveOrgOutputPath(
  config: AppConfig,
  nip: string,
): string | undefined {
  return config.organizations.find((org) => org.nip === nip)?.outputPath;
}

function resolveRoot(
  config: AppConfig,
  nip: string,
  outputPathOverride?: string,
): string {
  return resolveInvoiceOutputRoot(
    config.storage.root,
    nip,
    outputPathOverride ?? resolveOrgOutputPath(config, nip),
  );
}

export function getMetadataFileName(
  fileBaseName: string,
  flatSync: boolean,
): string {
  return flatSync ? `${fileBaseName}.metadata.json` : "metadata.json";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readStoredKsefNumber(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as { ksefNumber?: unknown };
    return typeof parsed.ksefNumber === "string" ? parsed.ksefNumber : null;
  } catch {
    return null;
  }
}

async function canUseFlatFileBase(
  invoiceDir: string,
  fileBaseName: string,
  ksefNumber: string,
): Promise<boolean> {
  const metadataPath = path.join(
    invoiceDir,
    getMetadataFileName(fileBaseName, true),
  );
  const storedKsefNumber = await readStoredKsefNumber(metadataPath);
  if (storedKsefNumber === ksefNumber) {
    return true;
  }
  const candidatePaths = [
    path.join(invoiceDir, `${fileBaseName}.xml`),
    path.join(invoiceDir, `${fileBaseName}.pdf`),
    metadataPath,
  ];
  const existingFlags = await Promise.all(
    candidatePaths.map((p) => pathExists(p)),
  );
  return existingFlags.every((exists) => !exists);
}

async function resolveFlatFileBase(
  invoiceDir: string,
  preferredBase: string,
  ksefNumber: string,
): Promise<string> {
  if (await canUseFlatFileBase(invoiceDir, preferredBase, ksefNumber)) {
    return preferredBase;
  }
  return sanitizeFileName(`${preferredBase} - ${ksefNumber}`) || ksefNumber;
}

// ---- exported functions ----

export async function resolveInvoiceStorageTarget(
  deps: Pick<InvoiceWriterDeps, "config">,
  nip: string,
  storageDate: Date,
  ksefNumber: string,
  xmlText: string,
  flatSync: boolean,
  metadata?: InvoiceFileMetadata,
  outputPathOverride?: string,
): Promise<InvoiceStorageTarget> {
  const { config } = deps;
  const invoiceRoot = resolveRoot(config, nip, outputPathOverride);
  if (!flatSync) {
    const fileBaseName = resolveInvoiceFileBase(xmlText, ksefNumber);
    return {
      invoiceDir: getInvoiceDirForRoot(invoiceRoot, storageDate, ksefNumber),
      fileBaseName,
      metadataFileName: getMetadataFileName(fileBaseName, false),
    };
  }
  const invoiceDir = getFlatInvoiceDirForRoot(invoiceRoot, storageDate);
  const preferredBase = resolveFlatInvoiceFileBase(
    xmlText,
    ksefNumber,
    metadata,
  );
  const fileBaseName = await resolveFlatFileBase(
    invoiceDir,
    preferredBase,
    ksefNumber,
  );
  return {
    invoiceDir,
    fileBaseName,
    metadataFileName: getMetadataFileName(fileBaseName, true),
  };
}

export async function maybeWritePdf(
  deps: Pick<
    InvoiceWriterDeps,
    "config" | "logger" | "pdfService" | "pdfCircuitBreaker"
  >,
  invoiceDir: string,
  xmlText: string,
  ksefNumber: string,
  nip: string,
  fileBaseName: string,
): Promise<string | null> {
  const { config, logger, pdfService, pdfCircuitBreaker } = deps;
  if (!config.sync.generatePdf) return null;
  if (pdfCircuitBreaker?.disabled) return null;
  if (Buffer.byteLength(xmlText, "utf-8") > maxInvoicePdfXmlBytes) {
    logger.warn(
      { nip, ksefNumber, maxBytes: maxInvoicePdfXmlBytes },
      "Invoice XML too large for PDF generation",
    );
    return null;
  }
  try {
    const pdfResult = await pdfService.generateInvoicePdf(xmlText, ksefNumber);
    if (pdfResult.status === "ok") {
      if (pdfCircuitBreaker) pdfCircuitBreaker.consecutiveTimeouts = 0;
      const pdfPath = path.join(invoiceDir, `${fileBaseName}.pdf`);
      await atomicWriteFile(pdfPath, pdfResult.buffer);
      return pdfPath;
    } else {
      if (pdfCircuitBreaker && pdfResult.reason === "timeout") {
        pdfCircuitBreaker.consecutiveTimeouts += 1;
        if (
          pdfCircuitBreaker.consecutiveTimeouts >=
          pdfCircuitBreaker.maxConsecutiveTimeouts
        ) {
          pdfCircuitBreaker.disabled = true;
          logger.warn(
            {
              err: pdfResult.message,
              reason: pdfResult.reason,
              nip,
              ksefNumber,
              consecutiveTimeouts: pdfCircuitBreaker.consecutiveTimeouts,
              maxConsecutiveTimeouts: pdfCircuitBreaker.maxConsecutiveTimeouts,
            },
            "PDF generation disabled after repeated timeouts",
          );
          return null;
        }
      } else if (pdfCircuitBreaker) {
        pdfCircuitBreaker.consecutiveTimeouts = 0;
      }
      logger.warn(
        { err: pdfResult.message, reason: pdfResult.reason, nip, ksefNumber },
        "Failed to generate invoice PDF",
      );
      return null;
    }
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, nip, ksefNumber },
      "Failed to generate invoice PDF",
    );
    return null;
  }
}

export type WriteInvoiceOptions = {
  nip: string;
  ksefNumber: string;
  xmlData: Buffer;
  xmlText: string;
  storageTarget: InvoiceStorageTarget;
  receivedDate: string | null;
  sourceEnvironment: string;
  metadataMeta: Record<string, unknown> | undefined;
};

export async function writeInvoice(
  deps: InvoiceWriterDeps,
  options: WriteInvoiceOptions,
): Promise<SyncItem> {
  const { config, logger, store, pdfService } = deps;
  const {
    nip,
    ksefNumber,
    xmlData,
    xmlText,
    storageTarget,
    receivedDate,
    sourceEnvironment,
    metadataMeta,
  } = options;
  const hash = sha256Base64(xmlData);

  await atomicWriteFile(
    path.join(storageTarget.invoiceDir, `${storageTarget.fileBaseName}.xml`),
    xmlData,
  );
  await atomicWriteFile(
    path.join(storageTarget.invoiceDir, storageTarget.metadataFileName),
    JSON.stringify(
      {
        ksefNumber,
        nip,
        downloadedAt: new Date().toISOString(),
        sourceEnvironment,
        hash,
        metadata: metadataMeta ?? {},
      },
      null,
      2,
    ),
  );

  const pdfPath = await maybeWritePdf(
    { config, logger, pdfService },
    storageTarget.invoiceDir,
    xmlText,
    ksefNumber,
    nip,
    storageTarget.fileBaseName,
  );

  await store.withDb((db) =>
    upsertInvoice(db, {
      nip,
      ksef_number: ksefNumber,
      file_path: storageTarget.invoiceDir,
      hash,
      status: "downloaded",
      downloaded_at: new Date().toISOString(),
      received_at: receivedDate,
      error: null,
    }),
  );

  return createSyncItem(
    nip,
    ksefNumber,
    storageTarget.invoiceDir,
    xmlText,
    pdfPath,
  );
}

export async function resolveAndWrite(
  deps: InvoiceWriterDeps,
  options: Omit<WriteInvoiceOptions, "storageTarget"> & {
    storageDate: Date;
    flatSync: boolean;
    outputPathOverride?: string;
    metadata?: InvoiceFileMetadata;
  },
): Promise<SyncItem> {
  const storageTarget = await resolveInvoiceStorageTarget(
    deps,
    options.nip,
    options.storageDate,
    options.ksefNumber,
    options.xmlText,
    options.flatSync,
    options.metadata,
    options.outputPathOverride,
  );
  return writeInvoice(deps, { ...options, storageTarget });
}
