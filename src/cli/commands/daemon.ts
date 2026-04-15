import type { Logger } from "pino";
import { Command } from "commander";
import { StatusService } from "../../core/statusService";
import { SyncService } from "../../core/syncService";
import { Notifier } from "../../notifications/notifier";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import { formatDuration, sleep, sleepWithCountdown } from "../../utils/time";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { formatInvoicesToPay, getInvoicesToPay } from "../paymentSummary";
import { createProgressRenderer } from "../progress";
import { printHeader, printKeyValues, printList } from "../ui";
import {
  formatCliError,
  logUnexpectedError,
  type RootOptions,
} from "./runCommand";

export function registerDaemon(program: Command): void {
  const daemonCmd = new Command("daemon");
  daemonCmd
    .description("Deprecated: use sync --watch instead")
    .addHelpText("before", "Deprecated: this command is an alias for sync --watch.\n")
    .action(async () => {
      const rootOpts = program.opts<RootOptions>();
      const { config, verbose } = rootOpts;
      let daemonLogFile: string | null = null;
      let daemonLogger: Logger | null = null;
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
        const intervalMs = ctx.config.pollingIntervalSeconds * 1000;
        printHeader("Sync");
        printKeyValues([
          ["mode", "watch"],
          ["environment", ctx.config.environment],
          ["nips", nips.join(", ")],
          ["logFile", ctx.config.logging.file],
          ["interval", formatDuration(intervalMs)],
        ]);

        const sync = new SyncService({
          client: ctx.client,
          auth: ctx.auth,
          config: ctx.config,
          logger: ctx.logger,
          store: ctx.store,
          progress,
          countdownIntervalSeconds: ctx.countdownIntervalSeconds,
        });
        const notifier = new Notifier(ctx.config, ctx.logger);
        const statusService = new StatusService(ctx.store);
        let iteration = 0;

        while (true) {
          iteration += 1;
          const startedAt = Date.now();
          let result: Awaited<ReturnType<SyncService["runOnce"]>> | null = null;
          let errorMessage: string | null = null;
          try {
            progress?.(`Progress: sync cycle ${iteration} started`);
            result = await sync.runOnce();
            await notifier.notifyUnpaidInvoices(result, ctx.store);
          } catch (error) {
            logUnexpectedError(error, daemonLogger, daemonLogFile);
            errorMessage = formatCliError(error);
          }
          renderer?.done();
          const durationMs = Date.now() - startedAt;
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

          if (progress) {
            progress(`Progress: next run in ${formatDuration(intervalMs)}`);
            await sleepWithCountdown(
              intervalMs,
              ctx.countdownIntervalSeconds,
              (remaining) =>
                progress(`Progress: next run in ${formatDuration(remaining)}`),
            );
            renderer?.done();
          } else {
            await sleep(intervalMs);
          }
        }
      } catch (error) {
        renderer?.done();
        const logHint = logUnexpectedError(error, daemonLogger, daemonLogFile);
        console.error(`${formatCliError(error)}${logHint}`);
        process.exitCode = exitCodeFromError(error);
      }
    });

  program.addCommand(daemonCmd, { hidden: true });
}
