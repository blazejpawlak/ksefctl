import { Database } from "sql.js";

export type InvoiceRecord = {
  nip: string;
  ksef_number: string;
  file_path: string;
  hash: string | null;
  status: string;
  downloaded_at: string | null;
  received_at: string | null;
  error: string | null;
};

export type SyncState = {
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_downloaded_count: number | null;
};

export const getInvoice = (
  db: Database,
  nip: string,
  ksefNumber: string,
): InvoiceRecord | null => {
  const stmt = db.prepare(
    "SELECT * FROM invoices WHERE nip = ? AND ksef_number = ?",
  );
  stmt.bind([nip, ksefNumber]);
  const row = stmt.step() ? (stmt.getAsObject() as InvoiceRecord) : null;
  stmt.free();
  return row;
};

export const upsertInvoice = (db: Database, record: InvoiceRecord): void => {
  const stmt = db.prepare(
    `INSERT INTO invoices (nip, ksef_number, file_path, hash, status, downloaded_at, received_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(nip, ksef_number) DO UPDATE SET
       file_path=excluded.file_path,
       hash=excluded.hash,
       status=excluded.status,
       downloaded_at=excluded.downloaded_at,
       received_at=excluded.received_at,
       error=excluded.error`,
  );
  stmt.run([
    record.nip,
    record.ksef_number,
    record.file_path,
    record.hash,
    record.status,
    record.downloaded_at,
    record.received_at,
    record.error,
  ]);
  stmt.free();
};

export const getSyncState = (db: Database): SyncState => {
  const stmt = db.prepare(
    "SELECT last_sync_at, last_success_at, last_error, last_downloaded_count FROM sync_state WHERE id = 1",
  );
  const row = stmt.step()
    ? (stmt.getAsObject() as SyncState)
    : {
        last_sync_at: null,
        last_success_at: null,
        last_error: null,
        last_downloaded_count: null,
      };
  stmt.free();
  return row;
};

export const setSyncState = (db: Database, state: SyncState): void => {
  const stmt = db.prepare(
    `INSERT INTO sync_state (id, last_sync_at, last_success_at, last_error, last_downloaded_count)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_sync_at=excluded.last_sync_at,
       last_success_at=excluded.last_success_at,
       last_error=excluded.last_error,
       last_downloaded_count=excluded.last_downloaded_count`,
  );
  stmt.run([
    state.last_sync_at,
    state.last_success_at,
    state.last_error,
    state.last_downloaded_count,
  ]);
  stmt.free();
};

export const getContinuationPoint = (
  db: Database,
  nip: string,
  subjectType: string,
): string | null => {
  const stmt = db.prepare(
    "SELECT cursor FROM continuation_points WHERE nip = ? AND subject_type = ?",
  );
  stmt.bind([nip, subjectType]);
  const row = stmt.step()
    ? ((stmt.getAsObject() as { cursor?: string }).cursor ?? null)
    : null;
  stmt.free();
  return row ?? null;
};

export const setContinuationPoint = (
  db: Database,
  nip: string,
  subjectType: string,
  cursor: string | null,
): void => {
  if (!cursor) {
    const stmt = db.prepare(
      "DELETE FROM continuation_points WHERE nip = ? AND subject_type = ?",
    );
    stmt.run([nip, subjectType]);
    stmt.free();
    return;
  }
  const stmt = db.prepare(
    `INSERT INTO continuation_points (nip, subject_type, cursor)
     VALUES (?, ?, ?)
     ON CONFLICT(nip, subject_type) DO UPDATE SET cursor=excluded.cursor`,
  );
  stmt.run([nip, subjectType, cursor]);
  stmt.free();
};
