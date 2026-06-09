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
  upsertInvoice,
} from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";
import { Notifier } from "../../src/notifications/notifier";

var notifyMock: ReturnType<typeof vi.fn>;

var sendMailMock: ReturnType<typeof vi.fn>;

var createTransportMock: ReturnType<typeof vi.fn>;

vi.mock("node-notifier", () => {
  notifyMock = vi.fn();
  return {
    default: {
      notify: notifyMock,
    },
  };
});

vi.mock("nodemailer", () => {
  sendMailMock = vi.fn();
  createTransportMock = vi.fn();
  return {
    default: {
      createTransport: createTransportMock,
    },
  };
});

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
    unpaidInvoiceCatchUp: false,
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
    flatSync: false,
    maxConcurrentNips: 1,
  },
});

const nullFields = {
  sellerName: null,
  buyerName: null,
  invoiceNumber: null,
  amount: null,
  currency: null,
  pdfPath: null,
};

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
      ...nullFields,
    },
  ],
});

const createPayableXml = (dueDate = "2026-03-24"): string => `
<Faktura>
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>5542936663</NIP>
      <Nazwa>Seller Sp. z o.o.</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>1234567890</NIP>
      <Nazwa>Buyer Sp. z o.o.</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot2>
  <Fa>
    <P_2>FVS/1/2026</P_2>
    <P_15>1033.20</P_15>
    <Waluta>PLN</Waluta>
    <Platnosc>
      <TerminPlatnosci>
        <Termin>${dueDate}</Termin>
      </TerminPlatnosci>
      <Rozliczenie>
        <DoZaplaty>1033.20</DoZaplaty>
      </Rozliczenie>
    </Platnosc>
  </Fa>
</Faktura>
`;

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
      subject: "KSeFctl: 1 invoice requires payment",
    });
    const sentMessage = sendMailMock.mock.calls[0]?.[0] as
      | { html?: string; text?: string }
      | undefined;
    expect(String(sentMessage?.text)).toContain(
      "The following invoice requires payment.",
    );
    expect(String(sentMessage?.html)).toContain("KSeFctl Invoice Alert");
    expect(String(sentMessage?.html)).toContain("Invoice details");
    expect(String(sentMessage?.text)).toContain("2026-03-24");
    expect(String(sentMessage?.text)).toContain("Folder: /tmp/invoice-1");

    const notified = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-1", "unpaid_due"),
    );
    expect(notified).toBe(true);
  });

  it("adds matching content IDs for PDF attachment links", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const pdfPath = path.join(tmpDir, "Faktura-1.pdf");
    await fs.writeFile(pdfPath, "pdf");
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const notifier = new Notifier(createConfig(), createLogger());
    const result: SyncResult = {
      ...createResult(),
      items: [
        {
          ...createResult().items[0]!,
          pdfPath,
        },
      ],
    };

    await notifier.notifyUnpaidInvoices(result, store);

    const sentMessage = sendMailMock.mock.calls[0]?.[0] as
      | {
          attachments?: { cid?: string; filename?: string; path?: string }[];
          html?: string;
        }
      | undefined;
    expect(sentMessage?.attachments).toEqual([
      {
        cid: "invoice-1@ksefctl.local",
        filename: "Faktura-1.pdf",
        path: pdfPath,
      },
    ]);
    expect(String(sentMessage?.html)).toContain("cid:invoice-1@ksefctl.local");
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
          ...nullFields,
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

  it("routes invoices to SMTP profiles by NIP", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const config: AppConfig = {
      ...createConfig(),
      notifications: {
        macosNotification: false,
        unpaidInvoiceCatchUp: false,
        email: {
          enabled: true,
          smtpProfiles: [
            {
              label: "profile-a",
              host: "smtp-a.example.com",
              port: 587,
              user: "a@example.com",
              pass: "secret-a",
              from: "from-a@example.com",
              to: ["to-a@example.com"],
              secure: false,
              tlsRejectUnauthorized: true,
              nips: ["1234567890"],
            },
            {
              label: "profile-b",
              host: "smtp-b.example.com",
              port: 587,
              user: "b@example.com",
              pass: "secret-b",
              from: "from-b@example.com",
              to: ["to-b@example.com"],
              secure: false,
              tlsRejectUnauthorized: true,
              nips: ["7393955632"],
            },
          ],
        },
      },
    };
    const notifier = new Notifier(config, createLogger());
    const result: SyncResult = {
      downloaded: 2,
      skipped: 0,
      failed: 0,
      items: [
        {
          nip: "1234567890",
          ksefNumber: "KSEF-1",
          path: "/tmp/invoice-1",
          dueDate: "2026-03-24",
          needsPaymentNotification: true,
          ...nullFields,
        },
        {
          nip: "7393955632",
          ksefNumber: "KSEF-2",
          path: "/tmp/invoice-2",
          dueDate: "2026-03-25",
          needsPaymentNotification: true,
          ...nullFields,
        },
      ],
    };

    await notifier.notifyUnpaidInvoices(result, store);

    // Two separate emails — one per profile
    expect(createTransportMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const hosts = (createTransportMock.mock.calls as [{ host: string }][]).map(
      (call) => call[0].host,
    );
    expect(hosts).toContain("smtp-a.example.com");
    expect(hosts).toContain("smtp-b.example.com");
  });

  it("uses a summary-style subject for multiple invoices", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const notifier = new Notifier(createConfig(), createLogger());
    const result: SyncResult = {
      downloaded: 2,
      skipped: 0,
      failed: 0,
      items: [
        ...createResult().items,
        {
          nip: "7393955632",
          ksefNumber: "KSEF-2",
          path: "/tmp/invoice-2",
          dueDate: "2026-03-25",
          needsPaymentNotification: true,
          ...nullFields,
        },
      ],
    };

    await notifier.notifyUnpaidInvoices(result, store);

    expect(sendMailMock.mock.calls[0]?.[0]).toMatchObject({
      subject: "KSeFctl: 2 invoices require payment",
    });
  });

  it("skips catch-up notification by default", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const invoiceDir = path.join(tmpDir, "invoices", "KSEF-CATCHUP-1");
    await fs.mkdir(invoiceDir, { recursive: true });
    await fs.writeFile(
      path.join(invoiceDir, "invoice.xml"),
      createPayableXml(),
    );

    await store.withDb((db) => {
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: "KSEF-CATCHUP-1",
        file_path: invoiceDir,
        hash: null,
        status: "downloaded",
        downloaded_at: "2026-04-15T20:27:55.637Z",
        received_at: "2026-04-15T20:27:55.637Z",
        error: null,
      });
    });

    const notifier = new Notifier(createConfig(), createLogger());
    const emptyResult: SyncResult = {
      downloaded: 0,
      skipped: 1,
      failed: 0,
      items: [],
    };

    await notifier.notifyUnpaidInvoices(emptyResult, store);

    expect(sendMailMock).not.toHaveBeenCalled();
    const notified = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-CATCHUP-1", "unpaid_due"),
    );
    expect(notified).toBe(false);
  });

  it("sends catch-up notification when unpaid invoice catch-up is enabled", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-notifier-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const invoiceDir = path.join(tmpDir, "invoices", "KSEF-CATCHUP-1");
    await fs.mkdir(invoiceDir, { recursive: true });
    await fs.writeFile(
      path.join(invoiceDir, "invoice.xml"),
      createPayableXml(),
    );

    await store.withDb((db) => {
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: "KSEF-CATCHUP-1",
        file_path: invoiceDir,
        hash: null,
        status: "downloaded",
        downloaded_at: "2026-04-15T20:27:55.637Z",
        received_at: "2026-04-15T20:27:55.637Z",
        error: null,
      });
    });

    const notifier = new Notifier(
      {
        ...createConfig(),
        notifications: {
          ...createConfig().notifications,
          unpaidInvoiceCatchUp: true,
        },
      },
      createLogger(),
    );
    const emptyResult: SyncResult = {
      downloaded: 0,
      skipped: 1,
      failed: 0,
      items: [],
    };

    await notifier.notifyUnpaidInvoices(emptyResult, store);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const notified = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-CATCHUP-1", "unpaid_due"),
    );
    expect(notified).toBe(true);
  });
});
