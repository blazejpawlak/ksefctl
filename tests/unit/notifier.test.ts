import type { AppConfig } from "../../src/config/schema";
import type { SyncResult } from "../../src/core/syncService";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasInvoiceNotification,
  markInvoiceNotification,
} from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";
import { Notifier } from "../../src/notifications/notifier";

const { notifyMock, sendMailMock, createTransportMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  sendMailMock: vi.fn(),
  createTransportMock: vi.fn(),
}));

vi.mock("node-notifier", () => ({
  default: {
    notify: notifyMock,
  },
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createConfig = (): AppConfig => ({
  environment: "test",
  apiBaseUrl: "http://localhost/v2",
  auth: { method: "ksefToken", keychainServiceName: "ksefctl-test" },
  organizations: [{ nip: "1234567890" }],
  pollingIntervalSeconds: 300,
  storage: { root: "/tmp/ksef" },
  notifications: {
    macosNotification: false,
    email: {
      enabled: true,
      smtp: {
        host: "smtp.example.com",
        port: 587,
        user: "user@example.com",
        pass: "secret",
        from: "ksefctl@example.com",
        to: ["you@example.com"],
        secure: false,
        tlsRejectUnauthorized: true,
      },
    },
  },
  logging: { level: "info", file: "/tmp/ksef/logs/app.log", pretty: false },
  operational: {
    maxConcurrency: 2,
    timeoutSeconds: 60,
    pollIntervalSeconds: 5,
    authPollMaxAttempts: 1,
    exportPollMaxAttempts: 2,
    exportCooldownSeconds: 0,
    allowInsecureHttp: true,
    retry: {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: 0,
    },
  },
  security: {
    tls: { enablePinning: false, pins: [], pinningHosts: [] },
    allowedHosts: [],
  },
  sync: {
    subjectTypes: ["Subject1"],
    includeMetadataHeader: true,
    generatePdf: false,
    maxConcurrentNips: 1,
  },
});

const createResult = (): SyncResult => ({
  downloaded: 1,
  skipped: 0,
  failed: 0,
  items: [
    {
      nip: "1234567890",
      ksefNumber: "KSEF-1",
      path: "/tmp/invoice-1",
      dueDate: "2026-03-24",
      needsPaymentNotification: true,
    },
  ],
});

describe("Notifier", () => {
  beforeEach(() => {
    createTransportMock.mockReturnValue({ sendMail: sendMailMock });
    sendMailMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends email for pending unpaid invoices and marks them as notified", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const notifier = new Notifier(createConfig(), createLogger());

    await notifier.notifyUnpaidInvoices(createResult(), store);

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0]?.[0]).toMatchObject({
      subject: "KSeFctl: 1 invoice(s) to pay",
    });
    const sentMessage = sendMailMock.mock.calls[0]?.[0] as
      | { text?: string }
      | undefined;
    expect(String(sentMessage?.text)).toContain("2026-03-24");

    const notified = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-1", "unpaid_due"),
    );
    expect(notified).toBe(true);
  });

  it("skips invoices that were already notified", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    await store.withDb((db) => {
      markInvoiceNotification(db, {
        nip: "1234567890",
        ksef_number: "KSEF-1",
        notification_kind: "unpaid_due",
        notified_at: "2026-03-29T12:00:00.000Z",
      });
    });
    const notifier = new Notifier(createConfig(), createLogger());

    await notifier.notifyUnpaidInvoices(createResult(), store);

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("skips items that are not eligible for payment notification", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const notifier = new Notifier(createConfig(), createLogger());
    const result: SyncResult = {
      downloaded: 1,
      skipped: 0,
      failed: 0,
      items: [
        {
          nip: "1234567890",
          ksefNumber: "KSEF-1",
          path: "/tmp/invoice-1",
          dueDate: "2026-03-24",
          needsPaymentNotification: false,
        },
      ],
    };

    await notifier.notifyUnpaidInvoices(result, store);

    expect(sendMailMock).not.toHaveBeenCalled();
    const notified = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-1", "unpaid_due"),
    );
    expect(notified).toBe(false);
  });
});
