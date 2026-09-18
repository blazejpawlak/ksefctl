import type { ShutdownController } from "../../utils/serviceLifecycle";
import type { Logger } from "pino";
import { Command } from "commander";
import { StatusService } from "../../core/statusService";
import { SyncService } from "../../core/syncService";
import { Notifier } from "../../notifications/notifier";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import {
  clampIntervalSeconds,
  computeNextIntervalSeconds,
  readRateLimitState,
  resolveRateLimitStatePath,
  writeRateLimitState,
} from "../../utils/rateLimit";
import {
  installShutdownController,
  logServiceLifecycle,
} from "../../utils/serviceLifecycle";
import { formatDuration, sleep, sleepWithCountdown } from "../../utils/time";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { getLifecycleEventEntries } from "../lifecycleStatus";
import { formatInvoicesToPay, getInvoicesToPay } from "../paymentSummary";
import { createProgressRenderer } from "../progress";
import { printHeader, printKeyValues, printList } from "../ui";
import {
  formatCliError,
  logUnexpectedError,
  type RootOptions,
} from "./runCommand";

// Bounds the drain of an in-flight cycle after a stop signal so a hung KSeF
// call cannot keep the service alive indefinitely.
const shutdownDrainMs = 10_000;

type SyncCycleOutcome = {
  result: Awaited<ReturnType<SyncService["runOnce"]>> | null;
  errorMessage: string | null;
};

export function registerDaemon(program: Command): void {
  const daemonCmd = new Command("daemon");
  daemonCmd
    .description("Deprecated: use sync --watch instead")
    .addHelpText(
      "before",
      "Deprecated: this command is an alias for sync --watch.\n",
    )
    .action(async () => {
      const rootOpts = program.opts<RootOptions>();
      const { config, verbose } = rootOpts;
      let daemonLogFile: string | null = null;
      let daemonLogger: Logger | null = null;
      let shutdown: ShutdownController | null = null;
      const renderer =
        !verbose && process.stderr.isTTY
          ? createProgressRenderer({ stream: process.stderr })
          : null;
      try {
        await ensureInitialized(config);
        const progress = renderer
          ? (message: string) => renderer.update(message)
          : undefined;
        const ctx = await createContext(config, {
          verbose,
          progress,
          countdownIntervalSeconds: verbose ? 10 : 60,
        });
        daemonLogFile = ctx.config.logging.file;
        daemonLogger = ctx.logger;
        const nips = ctx.config.organizations.map((org) => org.nip);
        if (nips.length === 0) {
          throw new ConfigError("No organizations configured");
        }
        const adaptive = ctx.config.sync.adaptivePolling;
        const statePath = resolveRateLimitStatePath(ctx.config.storage.root);
        let intervalSeconds = ctx.config.pollingIntervalSeconds;
        if (adaptive.enabled) {
          const persisted = await readRateLimitState(statePath);
          if (persisted) {
            // Restarting at the floor would immediately re-trip the limiter.
            intervalSeconds = clampIntervalSeconds(
              persisted.intervalSeconds,
              adaptive,
            );
            ctx.rateLimitTracker.restoreRetryAfterDeadline(
              persisted.retryAfterDeadlineMs,
            );
          }
        }
        let intervalMs = intervalSeconds * 1000;
        const statusService = new StatusService(ctx.store, {
          storageRoot: ctx.config.storage.root,
          fallbackIntervalSeconds: ctx.config.pollingIntervalSeconds,
          adaptivePollingEnabled: adaptive.enabled,
        });
        const stopController = installShutdownController(ctx.logger);
        shutdown = stopController;
        const startupEvent = logServiceLifecycle(ctx.logger, {
          action: "start",
          stage: "completed",
          origin: "service",
          reason: "daemon-alias-entered",
          context: { serviceMode: "daemon" },
        });
        await statusService.recordLifecycle(startupEvent);
        printHeader("Sync");
        printKeyValues([
          ["mode", "watch"],
          ["environment", ctx.config.environment],
          ["nips", nips.join(", ")],
          ["logFile", ctx.config.logging.file],
          ["interval", formatDuration(intervalMs)],
          ...getLifecycleEventEntries(startupEvent),
        ]);

        const notifier = new Notifier(ctx.config, ctx.logger);
        const sync = new SyncService({
          client: ctx.client,
          auth: ctx.auth,
          config: ctx.config,
          logger: ctx.logger,
          store: ctx.store,
          progress,
          countdownIntervalSeconds: ctx.countdownIntervalSeconds,
          // Watch mode notifies per NIP so a stop mid-cycle cannot lose alerts.
          notifier,
        });
        let iteration = 0;

        while (true) {
          iteration += 1;
          const startedAt = Date.now();
          let cycleCompleted = false;
          const cycle = (async (): Promise<SyncCycleOutcome> => {
            let result: Awaited<ReturnType<SyncService["runOnce"]>> | null =
              null;
            let errorMessage: string | null = null;
            try {
              progress?.(`Progress: sync cycle ${iteration} started`);
              result = await sync.runOnce();
              await notifier.notifyUnpaidInvoices(result, ctx.store);
            } catch (error) {
              logUnexpectedError(error, daemonLogger, daemonLogFile);
              errorMessage = formatCliError(error);
            } finally {
              cycleCompleted = true;
            }
            return { result, errorMessage };
          })();
          await Promise.race([cycle, stopController.whenStopRequested]);
          if (stopController.stopRequested && !cycleCompleted) {
            // Let the in-flight notification finish, but not forever.
            await Promise.race([cycle, sleep(shutdownDrainMs)]);
            if (!cycleCompleted) {
              ctx.logger.warn(
                { iteration, drainTimeoutMs: shutdownDrainMs },
                "Shutdown drain timed out; abandoning in-flight sync cycle",
              );
              renderer?.done();
              stopController.finalize();
              break;
            }
          }
          renderer?.done();
          const { result, errorMessage } = await cycle;
          const durationMs = Date.now() - startedAt;
          if (adaptive.enabled) {
            const cycleSummary = ctx.rateLimitTracker.completeCycle();
            const nextIntervalSeconds = computeNextIntervalSeconds({
              currentIntervalSeconds: intervalSeconds,
              hadRateLimit: cycleSummary.hadRateLimit,
              options: adaptive,
              retryAfterDeadlineMs: ctx.rateLimitTracker.getRetryAfterDeadline(),
            });
            if (nextIntervalSeconds !== intervalSeconds) {
              ctx.logger.info(
                {
                  iteration,
                  previousIntervalSeconds: intervalSeconds,
                  intervalSeconds: nextIntervalSeconds,
                  rateLimitCount: cycleSummary.rateLimitCount,
                  cleanCycles: cycleSummary.cleanCycles,
                },
                "Adaptive polling interval updated",
              );
            }
            intervalSeconds = nextIntervalSeconds;
            intervalMs = intervalSeconds * 1000;
            await writeRateLimitState(statePath, {
              intervalSeconds,
              nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
              retryAfterDeadlineMs:
                ctx.rateLimitTracker.getRetryAfterDeadline(),
            });
          }
          const status = await statusService.getStatus();
          const invoicesToPay = result ? getInvoicesToPay(result.items) : [];
          printHeader(`Sync iteration ${iteration}`);
          const summaryEntries: [string, string | number | null][] = [
            ["status", errorMessage ? "failed" : "completed"],
            ["downloaded", result?.downloaded ?? 0],
            ["skipped", result?.skipped ?? 0],
            ["failed", result?.failed ?? (errorMessage ? 1 : 0)],
            ["toPay", invoicesToPay.length],
            ["duration", formatDuration(durationMs)],
            ["lastSyncAt", status.lastSyncAt ?? "-"],
            ["nextRunIn", formatDuration(intervalMs)],
          ];
          if (errorMessage) {
            summaryEntries.push(["error", errorMessage]);
          }
          printKeyValues(summaryEntries);
          if (invoicesToPay.length > 0) {
            printList(
              "Invoices to pay:",
              formatInvoicesToPay(result?.items ?? []),
            );
          }

          if (stopController.stopRequested) {
            stopController.finalize();
            break;
          }
          if (progress) {
            progress(`Progress: next run in ${formatDuration(intervalMs)}`);
            await Promise.race([
              sleepWithCountdown(
                intervalMs,
                ctx.countdownIntervalSeconds,
                (remaining) =>
                  progress(
                    `Progress: next run in ${formatDuration(remaining)}`,
                  ),
              ),
              stopController.whenStopRequested,
            ]);
            renderer?.done();
          } else {
            await Promise.race([
              sleep(intervalMs),
              stopController.whenStopRequested,
            ]);
          }
          if (stopController.stopRequested) {
            stopController.finalize();
            break;
          }
        }
      } catch (error) {
        shutdown?.dispose();
        renderer?.done();
        const logHint = logUnexpectedError(error, daemonLogger, daemonLogFile);
        console.error(`${formatCliError(error)}${logHint}`);
        process.exitCode = exitCodeFromError(error);
      }
    });

  program.addCommand(daemonCmd, { hidden: true });
}
