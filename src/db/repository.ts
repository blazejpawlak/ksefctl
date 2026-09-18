import type { Database } from "sql.js";

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

export type ServiceLifecycleState = {
  last_lifecycle_action: string | null;
  last_lifecycle_stage: string | null;
  last_lifecycle_origin: string | null;
  last_lifecycle_at: string | null;
  last_lifecycle_by: string | null;
  last_lifecycle_initiator_source: string | null;
  last_lifecycle_reason: string | null;
};

export type InvoiceNotificationKind = "unpaid_due";

export type InvoiceNotificationRecord = {
  nip: string;
  ksef_number: string;
  notification_kind: InvoiceNotificationKind;
  notified_at: string;
};

export type InvoiceNotificationCandidate = {
  nip: string;
  ksef_number: string;
  file_path: string;
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

export const getServiceLifecycleState = (
  db: Database,
): ServiceLifecycleState => {
  const stmt = db.prepare(
    `SELECT
       last_lifecycle_action,
       last_lifecycle_stage,
       last_lifecycle_origin,
       last_lifecycle_at,
       last_lifecycle_by,
       last_lifecycle_initiator_source,
       last_lifecycle_reason
     FROM sync_state
     WHERE id = 1`,
  );
  const row = stmt.step()
    ? (stmt.getAsObject() as ServiceLifecycleState)
    : {
        last_lifecycle_action: null,
        last_lifecycle_stage: null,
        last_lifecycle_origin: null,
        last_lifecycle_at: null,
        last_lifecycle_by: null,
        last_lifecycle_initiator_source: null,
        last_lifecycle_reason: null,
      };
  stmt.free();
  return row;
};

export const setServiceLifecycleState = (
  db: Database,
  state: ServiceLifecycleState,
): void => {
  const stmt = db.prepare(
    `INSERT INTO sync_state (
       id,
       last_lifecycle_action,
       last_lifecycle_stage,
       last_lifecycle_origin,
       last_lifecycle_at,
       last_lifecycle_by,
       last_lifecycle_initiator_source,
       last_lifecycle_reason
     )
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_lifecycle_action=excluded.last_lifecycle_action,
       last_lifecycle_stage=excluded.last_lifecycle_stage,
       last_lifecycle_origin=excluded.last_lifecycle_origin,
       last_lifecycle_at=excluded.last_lifecycle_at,
       last_lifecycle_by=excluded.last_lifecycle_by,
       last_lifecycle_initiator_source=excluded.last_lifecycle_initiator_source,
       last_lifecycle_reason=excluded.last_lifecycle_reason`,
  );
  stmt.run([
    state.last_lifecycle_action,
    state.last_lifecycle_stage,
    state.last_lifecycle_origin,
    state.last_lifecycle_at,
    state.last_lifecycle_by,
    state.last_lifecycle_initiator_source,
    state.last_lifecycle_reason,
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

export const hasInvoiceNotification = (
  db: Database,
  nip: string,
  ksefNumber: string,
  notificationKind: InvoiceNotificationKind,
): boolean => {
  const stmt = db.prepare(
    "SELECT 1 FROM invoice_notifications WHERE nip = ? AND ksef_number = ? AND notification_kind = ?",
  );
  stmt.bind([nip, ksefNumber, notificationKind]);
  const exists = stmt.step();
  stmt.free();
  return exists;
};

export const markInvoiceNotification = (
  db: Database,
  record: InvoiceNotificationRecord,
): void => {
  const stmt = db.prepare(
    `INSERT INTO invoice_notifications (nip, ksef_number, notification_kind, notified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(nip, ksef_number, notification_kind) DO NOTHING`,
  );
  stmt.run([
    record.nip,
    record.ksef_number,
    record.notification_kind,
    record.notified_at,
  ]);
  stmt.free();
};

export const listInvoicesMissingNotification = (
  db: Database,
  notificationKind: InvoiceNotificationKind,
  lookbackDays: number,
  now = new Date(),
): InvoiceNotificationCandidate[] => {
  const downloadedSince = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const stmt = db.prepare(
    `SELECT i.nip, i.ksef_number, i.file_path
     FROM invoices i
     LEFT JOIN invoice_notifications n
       ON n.nip = i.nip
      AND n.ksef_number = i.ksef_number
      AND n.notification_kind = ?
     WHERE i.status = 'downloaded'
       AND i.file_path <> ''
       AND i.downloaded_at >= ?
       AND n.nip IS NULL`,
  );
  stmt.bind([notificationKind, downloadedSince]);

  const records: InvoiceNotificationCandidate[] = [];
  while (stmt.step()) {
    records.push(stmt.getAsObject() as InvoiceNotificationCandidate);
  }
  stmt.free();
  return records;
};

export const countInvoicesMissingNotification = (
  db: Database,
  notificationKind: InvoiceNotificationKind,
): number => {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS count
     FROM invoices i
     LEFT JOIN invoice_notifications n
       ON n.nip = i.nip
      AND n.ksef_number = i.ksef_number
      AND n.notification_kind = ?
     WHERE i.status = 'downloaded'
       AND i.file_path <> ''
       AND n.nip IS NULL`,
  );
  stmt.bind([notificationKind]);
  const row = stmt.step()
    ? (stmt.getAsObject() as { count?: number })
    : { count: 0 };
  stmt.free();
  return row.count ?? 0;
};

export const markInvoicesMissingNotification = (
  db: Database,
  notificationKind: InvoiceNotificationKind,
  notifiedAt: string,
): number => {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO invoice_notifications (
       nip,
       ksef_number,
       notification_kind,
       notified_at
     )
     SELECT i.nip, i.ksef_number, ?, ?
     FROM invoices i
     LEFT JOIN invoice_notifications n
       ON n.nip = i.nip
      AND n.ksef_number = i.ksef_number
      AND n.notification_kind = ?
     WHERE i.status = 'downloaded'
       AND i.file_path <> ''
       AND n.nip IS NULL`,
  );
  stmt.run([notificationKind, notifiedAt, notificationKind]);
  stmt.free();
  return db.getRowsModified();
};
