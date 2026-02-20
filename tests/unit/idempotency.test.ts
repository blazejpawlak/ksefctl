import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getInvoice, upsertInvoice } from "../../src/db/repository";
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
});
