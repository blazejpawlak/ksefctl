import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getInvoice,
  hasInvoiceNotification,
  markInvoiceNotification,
  upsertInvoice,
} from "../../src/db/repository";
import { SqliteStore } from "../../src/db/sqlite";

describe("idempotency", () => {
  it("upserts invoice records", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-db-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));

    await store.withDb((db) =>
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: "KSEF-1",
        file_path: "/tmp/a",
        hash: "hash",
        status: "downloaded",
        downloaded_at: new Date().toISOString(),
        received_at: null,
        error: null,
      }),
    );

    await store.withDb((db) =>
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: "KSEF-1",
        file_path: "/tmp/b",
        hash: "hash2",
        status: "downloaded",
        downloaded_at: new Date().toISOString(),
        received_at: null,
        error: null,
      }),
    );

    const record = await store.withDb((db) =>
      getInvoice(db, "1234567890", "KSEF-1"),
    );
    expect(record?.file_path).toBe("/tmp/b");
  });

  it("stores invoice notifications idempotently", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-db-"));
    const store = new SqliteStore(path.join(tmpDir, "state.sqlite"));
    const notifiedAt = "2026-03-29T18:00:00.000Z";

    await store.withDb((db) => {
      markInvoiceNotification(db, {
        nip: "1234567890",
        ksef_number: "KSEF-1",
        notification_kind: "unpaid_due",
        notified_at: notifiedAt,
      });
      markInvoiceNotification(db, {
        nip: "1234567890",
        ksef_number: "KSEF-1",
        notification_kind: "unpaid_due",
        notified_at: notifiedAt,
      });
    });

    const notificationExists = await store.withDb((db) =>
      hasInvoiceNotification(db, "1234567890", "KSEF-1", "unpaid_due"),
    );

    expect(notificationExists).toBe(true);
  });

  it("writes state DB with 0600 permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-db-"));
    const dbPath = path.join(tmpDir, "state.sqlite");
    const store = new SqliteStore(dbPath);

    await store.withDb((db) =>
      upsertInvoice(db, {
        nip: "1234567890",
        ksef_number: "KSEF-PERM",
        file_path: "/tmp/perm",
        hash: "h",
        status: "downloaded",
        downloaded_at: new Date().toISOString(),
        received_at: null,
        error: null,
      }),
    );

    const stats = await fs.stat(dbPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
