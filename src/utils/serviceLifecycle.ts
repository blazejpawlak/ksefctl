import type { Logger } from "pino";
import os from "node:os";

export type ServiceLifecycleAction = "start" | "stop" | "restart";
export type ServiceLifecycleStage =
  | "initiated"
  | "completed"
  | "signal_received";
export type ServiceLifecycleOrigin = "cli" | "service";
export type ServiceLifecycleContext = Record<
  string,
  boolean | number | string | null | undefined
>;

type ServiceLifecycleInitiatorSource =
  | "sudo_user"
  | "environment"
  | "effective_user"
  | "unknown";

type ServiceLifecycleLogOptions = {
  action: ServiceLifecycleAction;
  stage: ServiceLifecycleStage;
  origin: ServiceLifecycleOrigin;
  reason?: string;
  signal?: NodeJS.Signals;
  context?: ServiceLifecycleContext;
};

export type ServiceLifecycleInitiator = {
  initiatedBy: string;
  initiatorSource: ServiceLifecycleInitiatorSource;
  effectiveUser: string | null;
  effectiveUid: number | null;
};

export type ServiceLifecycleEvent = ServiceLifecycleInitiator & {
  lifecycleAction: ServiceLifecycleAction;
  lifecycleStage: ServiceLifecycleStage;
  lifecycleOrigin: ServiceLifecycleOrigin;
  lifecycleAt: string;
  reason?: string;
  signal?: NodeJS.Signals;
} & ServiceLifecycleContext;

const trackedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const normalizeValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }

  return trimmed;
};

const getEffectiveUser = (): string | null => {
  try {
    const username = os.userInfo().username.trim();
    return username || null;
  } catch {
    return null;
  }
};

const buildLifecycleMessage = ({
  action,
  stage,
}: Pick<ServiceLifecycleLogOptions, "action" | "stage">): string => {
  if (stage === "signal_received") {
    return "Service stop signal received";
  }

  const verb = stage === "initiated" ? "initiated" : "completed";
  return `Service ${action} ${verb}`;
};

export const resolveServiceInitiator = (): ServiceLifecycleInitiator => {
  const sudoUser = normalizeValue(process.env.SUDO_USER);
  const envUser =
    normalizeValue(process.env.LOGNAME) ?? normalizeValue(process.env.USER);
  const effectiveUser = getEffectiveUser() ?? envUser ?? sudoUser;
  const initiatedBy = sudoUser ?? envUser ?? effectiveUser ?? "unknown";

  const initiatorSource: ServiceLifecycleInitiatorSource = sudoUser
    ? "sudo_user"
    : envUser
      ? "environment"
      : effectiveUser
        ? "effective_user"
        : "unknown";

  return {
    initiatedBy,
    initiatorSource,
    effectiveUser,
    effectiveUid: process.getuid?.() ?? null,
  };
};

export const logServiceLifecycle = (
  logger: Logger,
  options: ServiceLifecycleLogOptions,
): ServiceLifecycleEvent => {
  const payload: ServiceLifecycleEvent = {
    lifecycleAction: options.action,
    lifecycleStage: options.stage,
    lifecycleOrigin: options.origin,
    lifecycleAt: new Date().toISOString(),
    ...resolveServiceInitiator(),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.context ?? {}),
  };

  logger.info(payload, buildLifecycleMessage(options));
  return payload;
};

export const installServiceStopSignalLogging = (
  logger: Logger,
): (() => void) => {
  const handlers = new Map<NodeJS.Signals, () => void>();

  const cleanup = (): void => {
    for (const [signal, handler] of handlers.entries()) {
      process.off(signal, handler);
    }
    handlers.clear();
  };

  for (const signal of trackedSignals) {
    const handler = (): void => {
      logServiceLifecycle(logger, {
        action: "stop",
        stage: "signal_received",
        origin: "service",
        reason: "process-signal",
        signal,
      });
      cleanup();
      logger.flush?.();
      process.kill(process.pid, signal);
    };

    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return cleanup;
};

export type ShutdownController = {
  /** True once SIGINT/SIGTERM has been observed. */
  readonly stopRequested: boolean;
  /** Resolves as soon as a stop is requested. */
  readonly whenStopRequested: Promise<NodeJS.Signals>;
  /** Re-raise the original signal after draining. Safe to call more than once. */
  finalize: () => void;
  /** Remove the installed handlers without exiting. */
  dispose: () => void;
};

/**
 * Install SIGINT/SIGTERM handlers that record the stop request and let the
 * caller drain in-flight work before the process dies. Unlike
 * installServiceStopSignalLogging, this does not re-raise the signal
 * immediately; the caller decides when by calling finalize().
 */
export const installShutdownController = (
  logger: Logger,
): ShutdownController => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  let stopRequested = false;
  let received: NodeJS.Signals | null = null;
  let resolveStop: ((signal: NodeJS.Signals) => void) | null = null;
  const whenStopRequested = new Promise<NodeJS.Signals>((resolve) => {
    resolveStop = resolve;
  });

  const dispose = (): void => {
    for (const [signal, handler] of handlers.entries()) {
      process.off(signal, handler);
    }
    handlers.clear();
  };

  const finalize = (): void => {
    const signal = received ?? "SIGTERM";
    dispose();
    logger.flush?.();
    process.kill(process.pid, signal);
  };

  for (const signal of trackedSignals) {
    const handler = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      received = signal;
      logServiceLifecycle(logger, {
        action: "stop",
        stage: "signal_received",
        origin: "service",
        reason: "process-signal",
        signal,
      });
      resolveStop?.(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return {
    get stopRequested() {
      return stopRequested;
    },
    whenStopRequested,
    finalize,
    dispose,
  };
};
