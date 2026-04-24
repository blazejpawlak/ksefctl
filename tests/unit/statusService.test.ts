import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StatusService } from "../../src/core/statusService";
import { SqliteStore } from "../../src/db/sqlite";

const tempDirs: string[] = [];

const createStore = async (): Promise<SqliteStore> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-status-"));
  tempDirs.push(tempDir);
  return new SqliteStore(path.join(tempDir, "state.sqlite"));
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("StatusService", () => {
  it("persists and returns the latest lifecycle event", async () => {
    const store = await createStore();
    const statusService = new StatusService(store);

    await statusService.recordLifecycle({
      lifecycleAction: "restart",
      lifecycleStage: "completed",
      lifecycleOrigin: "cli",
      lifecycleAt: "2026-04-21T12:00:00.000Z",
      initiatedBy: "alice",
      initiatorSource: "sudo_user",
      effectiveUser: "root",
      effectiveUid: 0,
      reason: "service-restart",
    });

    await expect(statusService.getStatus()).resolves.toMatchObject({
      lastLifecycleAction: "restart",
      lastLifecycleStage: "completed",
      lastLifecycleOrigin: "cli",
      lastLifecycleAt: "2026-04-21T12:00:00.000Z",
      lastLifecycleBy: "alice",
      lastLifecycleInitiatorSource: "sudo_user",
      lastLifecycleReason: "service-restart",
    });
  });
});
