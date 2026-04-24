import { describe, expect, it } from "vitest";
import {
  getLifecycleEventEntries,
  getLifecycleStatusEntries,
} from "../../src/cli/lifecycleStatus";

describe("lifecycleStatus", () => {
  it("returns empty status entries when no lifecycle event exists", () => {
    expect(
      getLifecycleStatusEntries({
        lastLifecycleAction: null,
        lastLifecycleStage: null,
        lastLifecycleAt: null,
        lastLifecycleBy: null,
        lastLifecycleOrigin: null,
        lastLifecycleInitiatorSource: null,
        lastLifecycleReason: null,
      }),
    ).toEqual([]);
  });

  it("formats persisted lifecycle fields for reporting output", () => {
    expect(
      getLifecycleStatusEntries({
        lastLifecycleAction: "restart",
        lastLifecycleStage: "completed",
        lastLifecycleAt: "2026-04-21T12:00:00.000Z",
        lastLifecycleBy: "alice",
        lastLifecycleOrigin: "cli",
        lastLifecycleInitiatorSource: "sudo_user",
        lastLifecycleReason: "service-restart",
      }),
    ).toEqual([
      ["lastLifecycleAction", "restart"],
      ["lastLifecycleStage", "completed"],
      ["lastLifecycleAt", "2026-04-21T12:00:00.000Z"],
      ["lastLifecycleBy", "alice"],
      ["lastLifecycleOrigin", "cli"],
      ["lastLifecycleInitiatorSource", "sudo_user"],
      ["lastLifecycleReason", "service-restart"],
    ]);
  });

  it("formats immediate lifecycle event output", () => {
    expect(
      getLifecycleEventEntries({
        lifecycleAction: "start",
        lifecycleStage: "completed",
        lifecycleOrigin: "service",
        lifecycleAt: "2026-04-21T12:00:00.000Z",
        initiatedBy: "service-user",
        initiatorSource: "environment",
        effectiveUser: "service-user",
        effectiveUid: 1000,
        reason: "watch-mode-entered",
      }),
    ).toEqual([
      ["lifecycleAction", "start"],
      ["lifecycleStage", "completed"],
      ["lifecycleAt", "2026-04-21T12:00:00.000Z"],
      ["lifecycleBy", "service-user"],
      ["lifecycleOrigin", "service"],
      ["lifecycleInitiatorSource", "environment"],
      ["lifecycleReason", "watch-mode-entered"],
    ]);
  });
});
