import type { SyncItem } from "./invoiceExtractor";
import type { SyncSubjectRunnerDeps } from "./syncSubjectRunner";
import type { KsefClient } from "../api/ksefClient";
import type { AuthService, AuthTokens } from "../auth/authService";
import type { AppConfig } from "../config/schema";
import type { SqliteStore } from "../db/sqlite";
import type { Logger } from "pino";
import {
  getSyncState,
  setSyncState,
} from "../db/repository";
import { PdfService } from "../services/pdfService";
import { pLimit } from "../utils/concurrency";
import { sanitizeErrorMessage } from "../utils/errors";
import { formatDuration, sleep, sleepWithCountdown } from "../utils/time";
import { selectCertificateByUsage } from "./encryption";
import {
  maxInvoiceNumberXmlBytes,
} from "./invoiceExtractor";
import { resolveInvoiceStorageTarget, writeInvoice } from "./invoiceWriter";
import { ensureStorageDirs } from "./storage";
import { syncSubjectType } from "./syncSubjectRunner";

export type { SyncItem };

export type SyncResult = {
  downloaded: number;
  skipped: number;
  failed: number;
  items: SyncItem[];
};

export type SyncServiceOptions = {
  client: KsefClient;
  auth: AuthService;
  config: AppConfig;
  logger: Logger;
  store: SqliteStore;
  progress?: (message: string) => void;
  countdownIntervalSeconds?: number;
  pdfService?: PdfService;
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

  constructor(options: SyncServiceOptions) {
    this.client = options.client;
    this.auth = options.auth;
    this.config = options.config;
    this.logger = options.logger;
    this.store = options.store;
    this.progress = options.progress;
    this.countdownIntervalSeconds = options.countdownIntervalSeconds ?? 60;
    this.pdfService = options.pdfService ?? new PdfService();
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

  private async getEncryptionCertificate(): Promise<string> {
    if (this.encryptionCertificate) return this.encryptionCertificate;
    const certs = await this.client.getPublicKeyCertificates();
    const cert = selectCertificateByUsage(certs, "SymmetricKeyEncryption");
    this.encryptionCertificate = cert;
    return cert;
  }

  private buildRunnerDeps(): SyncSubjectRunnerDeps {
    return {
      client: this.client,
      config: this.config,
      logger: this.logger,
      store: this.store,
      pdfService: this.pdfService,
      reportProgress: this.reportProgress.bind(this),
      sleepWithProgress: this.sleepWithProgress.bind(this),
      getEncryptionCertificate: this.getEncryptionCertificate.bind(this),
    };
  }

  private async downloadByKsefNumber(
    accessToken: string,
    nip: string,
    ksefNumber: string,
    flatSync = false,
    outputPath?: string,
  ): Promise<SyncItem> {
    const xml = await this.client.downloadInvoiceXml(accessToken, ksefNumber);
    if (Buffer.byteLength(xml, "utf-8") > maxInvoiceNumberXmlBytes) {
      throw new Error("Invoice XML too large for direct download");
    }
    const date = new Date();
    const xmlData = Buffer.from(xml, "utf-8");
    const writerDeps = {
      config: this.config,
      logger: this.logger,
      store: this.store,
      pdfService: this.pdfService,
    };
    const storageTarget = await resolveInvoiceStorageTarget(
      writerDeps,
      nip,
      date,
      ksefNumber,
      xml,
      flatSync,
      undefined,
      outputPath,
    );
    return writeInvoice(writerDeps, {
      nip,
      ksefNumber,
      xmlData,
      xmlText: xml,
      storageTarget,
      receivedDate: null,
      sourceEnvironment: this.config.environment,
      metadataMeta: { source: "direct" },
    });
  }

  async runOnce(
    forceRedownloadId?: string,
    nipFilter?: string,
    forceRedownloadAll = false,
    flatSync?: boolean,
    outputPath?: string,
  ): Promise<SyncResult> {
    await ensureStorageDirs(this.config.storage.root);
    const nips = nipFilter
      ? [nipFilter]
      : this.config.organizations.map((org) => org.nip);
    if (nips.length === 0) {
      throw new Error("No organizations configured");
    }
    if (outputPath && nips.length !== 1) {
      throw new Error(
        "Custom output path requires --nip or a single configured organization",
      );
    }
    const effectiveFlatSync = flatSync ?? this.config.sync.flatSync;
    const maxConcurrent = this.config.sync.maxConcurrentNips ?? 1;
    this.logger.debug(
      { nipCount: nips.length, maxConcurrent, flatSync: effectiveFlatSync },
      "Starting sync run",
    );

    const summary: SyncResult = {
      downloaded: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };

    const runnerDeps = this.buildRunnerDeps();

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
        forceRedownloadId && (!nipFilter || nipFilter === nip)
          ? await this.downloadByKsefNumber(
              accessToken,
              nip,
              forceRedownloadId,
              effectiveFlatSync,
              outputPath,
            )
          : null;
      if (forced) {
        nipResult.downloaded += 1;
        nipResult.items.push(forced);
      }

      const exportCooldownMs =
        Math.max(0, this.config.operational.exportCooldownSeconds ?? 0) * 1000;
      for (let i = 0; i < this.config.sync.subjectTypes.length; i++) {
        const subjectType = this.config.sync.subjectTypes[i]!;
        if (i > 0 && exportCooldownMs > 0) {
          await this.sleepWithProgress(
            `Progress: waiting ${formatDuration(exportCooldownMs)} before next subject type`,
            exportCooldownMs,
            (remaining) =>
              `Progress: waiting ${formatDuration(remaining)} before next subject type`,
          );
        }
        this.logger.debug(
          { nip, subjectType },
          "Requesting export for subject type",
        );
        const subjectResult = await syncSubjectType(
          runnerDeps,
          accessToken,
          nip,
          subjectType,
          forceRedownloadId,
          Boolean(forced),
          forceRedownloadAll,
          effectiveFlatSync,
          outputPath,
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
      const sanitizedMessage = sanitizeErrorMessage(message);
      this.logger.debug({ err: sanitizedMessage }, "Sync run failed");
      await this.store.withDb((db) => {
        const previous = getSyncState(db);
        setSyncState(db, {
          last_sync_at: new Date().toISOString(),
          last_success_at: previous.last_success_at,
          last_error: sanitizedMessage,
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
        const sanitizedMessage = sanitizeErrorMessage(message);
        this.logger.error({ err: sanitizedMessage }, "Sync cycle failed");
        await this.store.withDb((db) =>
          setSyncState(db, {
            last_sync_at: new Date().toISOString(),
            last_success_at: getSyncState(db).last_success_at,
            last_error: sanitizedMessage,
            last_downloaded_count: getSyncState(db).last_downloaded_count,
          }),
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.pollingIntervalSeconds * 1000),
      );
    }
  }
}
