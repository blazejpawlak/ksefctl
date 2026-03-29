import type { AppConfig } from "../config/schema";
import type { SyncItem, SyncResult } from "../core/syncService";
import type { SqliteStore } from "../db/sqlite";
import type { Logger } from "pino";
import type { Database } from "sql.js";
import notifier from "node-notifier";
import nodemailer from "nodemailer";
import {
  hasInvoiceNotification,
  markInvoiceNotification,
} from "../db/repository";

const unpaidDueNotificationKind = "unpaid_due";

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
      const pendingItems = this.getPendingUnpaidItems(result.items, db);
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

  private getPendingUnpaidItems(items: SyncItem[], db: Database): SyncItem[] {
    const unpaidItems = items.filter((item) => item.needsPaymentNotification);
    if (unpaidItems.length === 0) return [];

    return unpaidItems.filter(
      (item) =>
        !hasInvoiceNotification(
          db,
          item.nip,
          item.ksefNumber,
          unpaidDueNotificationKind,
        ),
    );
  }

  private notifyMac(summary: UnpaidNotificationSummary): boolean {
    if (!this.config.notifications.macosNotification) return false;
    if (process.platform !== "darwin") return false;

    const firstItem = summary.items[0];
    const subtitle = firstItem
      ? `${firstItem.nip} | ${firstItem.ksefNumber} | due ${firstItem.dueDate ?? "-"}`
      : "";
    try {
      notifier.notify({
        title: "KSeFctl",
        message: `Invoices to pay: ${summary.items.length}`,
        subtitle,
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

  private async notifyEmail(
    summary: UnpaidNotificationSummary,
  ): Promise<boolean> {
    if (!this.config.notifications.email.enabled) return false;
    const smtp = this.config.notifications.email.smtp;
    if (!smtp) {
      this.logger.warn("Email notification enabled but SMTP config missing");
      return false;
    }

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

    const lines = summary.items.map(
      (item) =>
        `- ${item.nip} | ${item.ksefNumber} | due ${item.dueDate ?? "-"}: ${item.path}`,
    );
    const body = [
      `Invoices to pay: ${summary.items.length}`,
      "",
      "Unpaid payable invoices:",
      ...lines,
      "",
      `Generated at: ${new Date().toISOString()}`,
    ].join("\n");

    try {
      await transporter.sendMail({
        from: smtp.from,
        to: smtp.to.join(","),
        subject: `KSeFctl: ${summary.items.length} invoice(s) to pay`,
        text: body,
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
}
