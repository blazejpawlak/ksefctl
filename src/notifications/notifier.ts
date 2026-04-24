import type { AppConfig } from "../config/schema";
import type { SyncItem, SyncResult } from "../core/syncService";
import type { InvoiceNotificationCandidate } from "../db/repository";
import type { SqliteStore } from "../db/sqlite";
import type { Logger } from "pino";
import type { Database } from "sql.js";
import notifier from "node-notifier";
import nodemailer from "nodemailer";
import fs from "node:fs/promises";
import path from "node:path";
import { createSyncItem } from "../core/invoiceExtractor";
import {
  hasInvoiceNotification,
  listInvoicesMissingNotification,
  markInvoiceNotification,
} from "../db/repository";
import {
  formatEmailNotificationContent,
  formatMacNotificationContent,
  type OrgLabels,
} from "./unpaidNotificationContent";

const unpaidDueNotificationKind = "unpaid_due";

type SmtpConfig = NonNullable<AppConfig["notifications"]["email"]["smtp"]>;

type UnpaidNotificationSummary = {
  items: SyncItem[];
};

export class Notifier {
  private config: AppConfig;
  private logger: Logger;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async notifyUnpaidInvoices(
    result: SyncResult,
    store: SqliteStore,
  ): Promise<void> {
    await store.withDb(async (db) => {
      const pendingItems = await this.getPendingUnpaidItems(result.items, db);
      if (pendingItems.length === 0) return;

      const summary: UnpaidNotificationSummary = { items: pendingItems };
      const macSent = this.notifyMac(summary);
      const emailSent = await this.notifyEmail(summary);
      if (!macSent && !emailSent) return;

      const notifiedAt = new Date().toISOString();
      for (const item of pendingItems) {
        markInvoiceNotification(db, {
          nip: item.nip,
          ksef_number: item.ksefNumber,
          notification_kind: unpaidDueNotificationKind,
          notified_at: notifiedAt,
        });
      }
    });
  }

  private getItemKey(item: Pick<SyncItem, "nip" | "ksefNumber">): string {
    return `${item.nip}:${item.ksefNumber}`;
  }

  private async getCatchUpUnpaidItems(db: Database): Promise<SyncItem[]> {
    const candidates = listInvoicesMissingNotification(db, unpaidDueNotificationKind);
    if (candidates.length === 0) return [];

    const items = await Promise.all(
      candidates.map((candidate) => this.readCatchUpItem(candidate)),
    );
    return items.filter((item): item is SyncItem => item !== null);
  }

  private async readCatchUpItem(
    candidate: InvoiceNotificationCandidate,
  ): Promise<SyncItem | null> {
    try {
      const names = await fs.readdir(candidate.file_path);
      const xmlName = names.find((name) => name.endsWith(".xml"));
      if (!xmlName) return null;

      const xmlPath = path.join(candidate.file_path, xmlName);
      const xmlText = await fs.readFile(xmlPath, "utf-8");
      const pdfName = names.find((name) => name.endsWith(".pdf"));
      const pdfPath = pdfName ? path.join(candidate.file_path, pdfName) : null;

      const item = createSyncItem(
        candidate.nip,
        candidate.ksef_number,
        candidate.file_path,
        xmlText,
        pdfPath,
      );
      return item.needsPaymentNotification ? item : null;
    } catch (error) {
      this.logger.debug(
        {
          nip: candidate.nip,
          ksefNumber: candidate.ksef_number,
          err: (error as Error).message,
        },
        "Skipping unreadable invoice during notification catch-up",
      );
      return null;
    }
  }

  private async getPendingUnpaidItems(
    items: SyncItem[],
    db: Database,
  ): Promise<SyncItem[]> {
    const pendingFromResult = items
      .filter((item) => item.needsPaymentNotification)
      .filter(
        (item) =>
          !hasInvoiceNotification(
            db,
            item.nip,
            item.ksefNumber,
            unpaidDueNotificationKind,
          ),
      );

    const catchUpItems = await this.getCatchUpUnpaidItems(db);
    if (pendingFromResult.length === 0 && catchUpItems.length === 0) return [];

    const combined = new Map<string, SyncItem>();
    for (const item of pendingFromResult) {
      combined.set(this.getItemKey(item), item);
    }
    for (const item of catchUpItems) {
      combined.set(this.getItemKey(item), item);
    }
    return [...combined.values()];
  }

  private notifyMac(summary: UnpaidNotificationSummary): boolean {
    if (!this.config.notifications.macosNotification) return false;
    if (process.platform !== "darwin") return false;

    const content = formatMacNotificationContent(summary.items);
    try {
      notifier.notify({
        title: content.title,
        message: content.message,
        subtitle: content.subtitle,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message },
        "Failed to send macOS unpaid invoice notification",
      );
      return false;
    }
  }

  private resolveSmtpForNip(nip: string): SmtpConfig | null {
    const profiles = this.config.notifications.email.smtpProfiles ?? [];
    const match = profiles.find((p) => p.nips.includes(nip));
    if (match) return match;
    return this.config.notifications.email.smtp ?? null;
  }

  private buildOrgLabels(): OrgLabels {
    return new Map(
      this.config.organizations.map((org) => [org.nip, org.label]),
    );
  }

  private async buildPdfAttachments(
    items: SyncItem[],
  ): Promise<{ filename: string; path: string }[]> {
    const results = await Promise.all(
      items.map(async (item) => {
        if (!item.pdfPath) return null;
        try {
          await fs.access(item.pdfPath);
          return { filename: path.basename(item.pdfPath), path: item.pdfPath };
        } catch {
          return null;
        }
      }),
    );
    return results.filter((a): a is NonNullable<typeof a> => a !== null);
  }

  private async sendEmailViaSmtp(
    smtp: SmtpConfig,
    items: SyncItem[],
    orgLabels: OrgLabels,
  ): Promise<boolean> {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
      tls: {
        rejectUnauthorized: smtp.tlsRejectUnauthorized,
      },
    });

    const content = formatEmailNotificationContent(
      items,
      new Date().toISOString(),
      orgLabels,
    );

    const attachments = await this.buildPdfAttachments(items);

    try {
      await transporter.sendMail({
        from: smtp.from,
        to: smtp.to.join(","),
        subject: content.subject,
        text: content.body,
        attachments,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message },
        "Failed to send unpaid invoice email notification",
      );
      return false;
    }
  }

  private async notifyEmail(
    summary: UnpaidNotificationSummary,
  ): Promise<boolean> {
    if (!this.config.notifications.email.enabled) return false;

    const orgLabels = this.buildOrgLabels();

    // Group items by resolved SMTP config (keyed by identity for deduplication)
    const profileMap = new Map<SmtpConfig, SyncItem[]>();
    const unrouted: SyncItem[] = [];

    for (const item of summary.items) {
      const smtp = this.resolveSmtpForNip(item.nip);
      if (!smtp) {
        unrouted.push(item);
        continue;
      }
      const existing = profileMap.get(smtp);
      if (existing) {
        existing.push(item);
      } else {
        profileMap.set(smtp, [item]);
      }
    }

    if (unrouted.length > 0) {
      this.logger.warn(
        { nips: unrouted.map((i) => i.nip) },
        "Email notification enabled but no SMTP config found for some NIPs",
      );
    }

    if (profileMap.size === 0) {
      this.logger.warn("Email notification enabled but SMTP config missing");
      return false;
    }

    let anySent = false;
    for (const [smtp, items] of profileMap) {
      const sent = await this.sendEmailViaSmtp(smtp, items, orgLabels);
      if (sent) anySent = true;
    }
    return anySent;
  }
}
