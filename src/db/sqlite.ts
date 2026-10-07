import type { Database, SqlJsStatic } from "sql.js";
import lockfile from "proper-lockfile";
import initSqlJs from "sql.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "../utils/paths.js";

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
  const wasmPath = fileURLToPath(
    import.meta.resolve("sql.js/dist/sql-wasm.wasm"),
  );
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

const loadSqlJs = () =>
  initSqlJs({
    locateFile: (file: string) => path.join(resolveSqlWasmPath(), file),
  });

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * Loads the database at `filePath`. A missing file is an empty database; any
 * other read error propagates so callers never mistake a failed read for "no
 * data".
 */
const openExisting = async (
  SQL: SqlJsStatic,
  filePath: string,
): Promise<Database> => {
  try {
    return new SQL.Database(await fs.readFile(filePath));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return new SQL.Database();
  }
};

/**
 * Replaces `filePath` with `data` atomically: the bytes go to a temp file in
 * the same directory (same filesystem, so `rename` is atomic), are fsynced,
 * and only then renamed over the target. A crash at any point leaves either
 * the previous file or the complete new one, never a truncated database.
 */
const replaceFileAtomically = async (
  filePath: string,
  data: Uint8Array,
): Promise<void> => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

export class SqliteStore {
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Opens the database for reading and writing, then persists it atomically.
   * Serialized across processes by a lockfile.
   */
  async withDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    await ensureDir(path.dirname(this.dbPath));
    await fs.open(this.dbPath, "a").then((handle) => handle.close());
    const release = await lockfile.lock(this.dbPath, {
      retries: 3,
      realpath: false,
    });
    try {
      const SQL = await loadSqlJs();
      // The file exists (touched above), so any read error is real: starting
      // from an empty DB would atomically replace the stored state with it.
      const db = await openExisting(SQL, this.dbPath);
      try {
        db.exec(schemaSql);
        migrateLegacyTables(db);

        const result = await fn(db);
        await replaceFileAtomically(this.dbPath, db.export());
        return result;
      } finally {
        db.close();
      }
    } finally {
      await release();
    }
  }

  /**
   * Opens the database strictly for reading. Never creates the file or its
   * directory, never takes the lock, and never writes anything back, so it
   * works on read-only storage and leaves the canonical state byte-for-byte
   * untouched. A missing database behaves like an empty one. Schema creation
   * and legacy migrations run in memory only, so older databases stay
   * queryable.
   *
   * No lock is needed: `withDb` replaces the file atomically via `rename`, so
   * a lock-free read always sees one complete snapshot, and skipping the lock
   * keeps reads from contending with a running watch service.
   */
  async readDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    const SQL = await loadSqlJs();
    const db = await openExisting(SQL, this.dbPath);
    try {
      db.exec(schemaSql);
      migrateLegacyTables(db);
      return await fn(db);
    } finally {
      db.close();
    }
  }
}
