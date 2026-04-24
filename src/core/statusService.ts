import type { SqliteStore } from "../db/sqlite";
import type { ServiceLifecycleEvent } from "../utils/serviceLifecycle";
import {
  getServiceLifecycleState,
  getSyncState,
  setServiceLifecycleState,
} from "../db/repository";

export type StatusInfo = {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDownloadedCount: number | null;
  lastLifecycleAction: string | null;
  lastLifecycleStage: string | null;
  lastLifecycleOrigin: string | null;
  lastLifecycleAt: string | null;
  lastLifecycleBy: string | null;
  lastLifecycleInitiatorSource: string | null;
  lastLifecycleReason: string | null;
};

export class StatusService {
  private store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async getStatus(): Promise<StatusInfo> {
    return this.store.withDb((db) => {
      const state = getSyncState(db);
      const lifecycle = getServiceLifecycleState(db);
      return {
        lastSyncAt: state.last_sync_at,
        lastSuccessAt: state.last_success_at,
        lastError: state.last_error,
        lastDownloadedCount: state.last_downloaded_count,
        lastLifecycleAction: lifecycle.last_lifecycle_action,
        lastLifecycleStage: lifecycle.last_lifecycle_stage,
        lastLifecycleOrigin: lifecycle.last_lifecycle_origin,
        lastLifecycleAt: lifecycle.last_lifecycle_at,
        lastLifecycleBy: lifecycle.last_lifecycle_by,
        lastLifecycleInitiatorSource: lifecycle.last_lifecycle_initiator_source,
        lastLifecycleReason: lifecycle.last_lifecycle_reason,
      };
    });
  }

  async recordLifecycle(event: ServiceLifecycleEvent): Promise<void> {
    await this.store.withDb((db) => {
      setServiceLifecycleState(db, {
        last_lifecycle_action: event.lifecycleAction,
        last_lifecycle_stage: event.lifecycleStage,
        last_lifecycle_origin: event.lifecycleOrigin,
        last_lifecycle_at: event.lifecycleAt,
        last_lifecycle_by: event.initiatedBy,
        last_lifecycle_initiator_source: event.initiatorSource,
        last_lifecycle_reason: event.reason ?? null,
      });
    });
  }
}
