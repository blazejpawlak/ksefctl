import type { Logger } from "pino";
import type { AppConfig } from "../config/schema";
import notifier from "node-notifier";
import nodemailer from "nodemailer";

export type NotificationSummary = {
  downloaded: number;
  items: Array<{ nip: string; ksefNumber: string; path: string }>;
};

export class Notifier {
  private config: AppConfig;
  private logger: Logger;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async notify(summary: NotificationSummary): Promise<void> {
    if (summary.downloaded <= 0) return;
    await this.notifyMac(summary);
    await this.notifyEmail(summary);
  }

  private async notifyMac(summary: NotificationSummary): Promise<void> {
    if (!this.config.notifications.macosNotification) return;
    if (process.platform !== "darwin") return;

    const message = `New KSeF invoice(s): ${summary.downloaded}`;
    notifier.notify({
      title: "KSeFctl",
      message,
      subtitle: summary.items[0]?.path ?? "",
    });
  }

  private async notifyEmail(summary: NotificationSummary): Promise<void> {
    if (!this.config.notifications.email.enabled) return;
    const smtp = this.config.notifications.email.smtp;
    if (!smtp) {
      this.logger.warn("Email notification enabled but SMTP config missing");
      return;
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

    const lines = summary.items.flatMap((item) => [
      `- ${item.nip} | ${item.ksefNumber}: ${item.path}`,
    ]);
    const body = [
      `New invoices downloaded: ${summary.downloaded}`,
      "",
      "Invoice list:",
      ...lines,
      "",
      `Generated at: ${new Date().toISOString()}`,
    ].join("\n");

    await transporter.sendMail({
      from: smtp.from,
      to: smtp.to.join(","),
      subject: `KSeFctl: ${summary.downloaded} new invoice(s)`,
      text: body,
    });
  }
}
