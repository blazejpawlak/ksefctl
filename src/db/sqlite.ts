import type { Database } from "sql.js";
import lockfile from "proper-lockfile";
import initSqlJs from "sql.js";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/paths";

const schemaSql = `
CREATE TABLE IF NOT EXISTS invoices (
  nip TEXT NOT NULL,
  ksef_number TEXT NOT NULL,
  file_path TEXT NOT NULL,
  hash TEXT,
  status TEXT NOT NULL,
  downloaded_at TEXT,
  received_at TEXT,
  error TEXT,
  PRIMARY KEY (nip, ksef_number)
);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_downloaded_count INTEGER,
  last_lifecycle_action TEXT,
  last_lifecycle_stage TEXT,
  last_lifecycle_origin TEXT,
  last_lifecycle_at TEXT,
  last_lifecycle_by TEXT,
  last_lifecycle_initiator_source TEXT,
  last_lifecycle_reason TEXT
);

CREATE TABLE IF NOT EXISTS continuation_points (
  nip TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  cursor TEXT,
  PRIMARY KEY (nip, subject_type)
);

CREATE TABLE IF NOT EXISTS invoice_notifications (
  nip TEXT NOT NULL,
  ksef_number TEXT NOT NULL,
  notification_kind TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (nip, ksef_number, notification_kind)
);
`;

const resolveSqlWasmPath = () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  return path.dirname(wasmPath);
};

const hasColumn = (db: Database, table: string, column: string): boolean => {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  let found = false;
  while (stmt.step()) {
    const row = stmt.getAsObject() as { name?: string };
    if (row.name === column) {
      found = true;
      break;
    }
  }
  stmt.free();
  return found;
};

const migrateLegacyTables = (db: Database): void => {
  if (!hasColumn(db, "invoices", "nip")) {
    db.exec("ALTER TABLE invoices RENAME TO invoices_legacy;");
    db.exec(
      `CREATE TABLE invoices (
        nip TEXT NOT NULL,
        ksef_number TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT,
        status TEXT NOT NULL,
        downloaded_at TEXT,
        received_at TEXT,
        error TEXT,
        PRIMARY KEY (nip, ksef_number)
      );`,
    );
    db.exec(
      `INSERT INTO invoices (nip, ksef_number, file_path, hash, status, downloaded_at, received_at, error)
       SELECT 'legacy', ksef_number, file_path, hash, status, downloaded_at, received_at, error
       FROM invoices_legacy;`,
    );
    db.exec("DROP TABLE invoices_legacy;");
  }

  if (!hasColumn(db, "continuation_points", "nip")) {
    db.exec(
      "ALTER TABLE continuation_points RENAME TO continuation_points_legacy;",
    );
    db.exec(
      `CREATE TABLE continuation_points (
        nip TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        cursor TEXT,
        PRIMARY KEY (nip, subject_type)
      );`,
    );
    db.exec(
      `INSERT INTO continuation_points (nip, subject_type, cursor)
       SELECT 'legacy', subject_type, cursor FROM continuation_points_legacy;`,
    );
    db.exec("DROP TABLE continuation_points_legacy;");
  }

  if (!hasColumn(db, "sync_state", "last_lifecycle_action")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_action TEXT;");
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_stage")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_stage TEXT;");
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_origin")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_origin TEXT;");
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_at")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_at TEXT;");
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_by")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_by TEXT;");
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_initiator_source")) {
    db.exec(
      "ALTER TABLE sync_state ADD COLUMN last_lifecycle_initiator_source TEXT;",
    );
  }
  if (!hasColumn(db, "sync_state", "last_lifecycle_reason")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_lifecycle_reason TEXT;");
  }
};

export class SqliteStore {
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async withDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    await ensureDir(path.dirname(this.dbPath));
    await fs.open(this.dbPath, "a").then((handle) => handle.close());
    const release = await lockfile.lock(this.dbPath, {
      retries: 3,
      realpath: false,
    });
    try {
      const SQL = await initSqlJs({
        locateFile: (file: string) => path.join(resolveSqlWasmPath(), file),
      });
      let db: Database;
      try {
        const fileBuffer = await fs.readFile(this.dbPath);
        db = new SQL.Database(fileBuffer);
      } catch {
        db = new SQL.Database();
      }
      db.exec(schemaSql);
      migrateLegacyTables(db);

      const result = await fn(db);
      const data = db.export();
      await fs.writeFile(this.dbPath, data, { mode: 0o600 });
      await fs.chmod(this.dbPath, 0o600);
      db.close();
      return result;
    } finally {
      await release();
    }
  }
}
