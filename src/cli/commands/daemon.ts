import type { Command } from "commander";
import type { Logger } from "pino";
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

type DaemonOptions = {
  verbose?: boolean;
};

export function registerDaemon(program: Command): void {
  program
    .command("daemon")
    .description("Run continuous foreground sync")
    .option("-v, --verbose", "enable verbose logging")
    .action(async (options: DaemonOptions) => {
      const rootOpts = program.opts<RootOptions>();
      const verbose = options.verbose ?? rootOpts.verbose;
      const { config } = rootOpts;
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
        printHeader("Daemon");
        printKeyValues([
          ["Status", "Running"],
          ["Environment", ctx.config.environment],
          ["NIPs", nips.join(", ")],
          ["LogFile", ctx.config.logging.file],
          ["Interval", formatDuration(intervalMs)],
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
          printHeader("Daemon Iteration");
          const summaryEntries: [string, string | number | null][] = [
            ["Status", errorMessage ? "Failed" : "Completed"],
            ["Downloaded", result?.downloaded ?? 0],
            ["Skipped", result?.skipped ?? 0],
            ["Failed", result?.failed ?? (errorMessage ? 1 : 0)],
            ["ToPay", invoicesToPay.length],
            ["Duration", formatDuration(durationMs)],
            ["LastSyncAt", status.lastSyncAt ?? "-"],
            ["NextRunIn", formatDuration(intervalMs)],
          ];
          if (errorMessage) {
            summaryEntries.push(["Error", errorMessage]);
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
}
