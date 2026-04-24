import type { StatusInfo } from "../core/statusService";
import type { ServiceLifecycleEvent } from "../utils/serviceLifecycle";

type StatusEntry = [string, string | number | null];

type LifecycleStatusFields = Pick<
  StatusInfo,
  | "lastLifecycleAction"
  | "lastLifecycleStage"
  | "lastLifecycleAt"
  | "lastLifecycleBy"
  | "lastLifecycleOrigin"
  | "lastLifecycleInitiatorSource"
  | "lastLifecycleReason"
>;

export const getLifecycleStatusEntries = (
  status: LifecycleStatusFields,
): StatusEntry[] => {
  if (!status.lastLifecycleAction) {
    return [];
  }

  const entries: StatusEntry[] = [
    ["lastLifecycleAction", status.lastLifecycleAction],
    ["lastLifecycleStage", status.lastLifecycleStage],
    ["lastLifecycleAt", status.lastLifecycleAt],
    ["lastLifecycleBy", status.lastLifecycleBy],
    ["lastLifecycleOrigin", status.lastLifecycleOrigin],
  ];

  if (status.lastLifecycleInitiatorSource) {
    entries.push([
      "lastLifecycleInitiatorSource",
      status.lastLifecycleInitiatorSource,
    ]);
  }

  if (status.lastLifecycleReason) {
    entries.push(["lastLifecycleReason", status.lastLifecycleReason]);
  }

  return entries;
};

export const getLifecycleEventEntries = (
  event: ServiceLifecycleEvent,
): StatusEntry[] => {
  const entries: StatusEntry[] = [
    ["lifecycleAction", event.lifecycleAction],
    ["lifecycleStage", event.lifecycleStage],
    ["lifecycleAt", event.lifecycleAt],
    ["lifecycleBy", event.initiatedBy],
    ["lifecycleOrigin", event.lifecycleOrigin],
    ["lifecycleInitiatorSource", event.initiatorSource],
  ];

  if (event.reason) {
    entries.push(["lifecycleReason", event.reason]);
  }

  return entries;
};
