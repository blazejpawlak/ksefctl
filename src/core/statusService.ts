import { SqliteStore } from "../db/sqlite";
import { getSyncState } from "../db/repository";

export type StatusInfo = {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDownloadedCount: number | null;
};

export class StatusService {
  private store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async getStatus(): Promise<StatusInfo> {
    return this.store.withDb((db) => {
      const state = getSyncState(db);
      return {
        lastSyncAt: state.last_sync_at,
        lastSuccessAt: state.last_success_at,
        lastError: state.last_error,
        lastDownloadedCount: state.last_downloaded_count,
      };
    });
  }
}
