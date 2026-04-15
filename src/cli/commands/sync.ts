import type { Command } from "commander";
import type { Logger } from "pino";
import { Option } from "commander";
import path from "node:path";
import { StatusService } from "../../core/statusService";
import { SyncService } from "../../core/syncService";
import { Notifier } from "../../notifications/notifier";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import { expandHome } from "../../utils/paths";
import { formatDuration, sleep, sleepWithCountdown } from "../../utils/time";
import { ensureInitialized } from "../bootstrap";
import { sanitizeForTerminal } from "../commandTree";
import { createContext } from "../context";
import { isValidNip } from "../keychain";
import { formatInvoicesToPay, getInvoicesToPay } from "../paymentSummary";
import { createProgressRenderer } from "../progress";
import { printHeader, printKeyValues, printList } from "../ui";
import { formatCliError, logUnexpectedError, type RootOptions } from "./runCommand";

type SyncOptions = {
  nip?: string;
  redownload?: string;
  redownloadAll?: boolean;
  flatSync?: boolean;
  outputPath?: string;
  watch?: boolean;
  json?: boolean;
};

const resolveCliOutputPath = (outputPath?: string): string | undefined => {
  if (!outputPath) return undefined;
  const expanded = expandHome(outputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
};

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Download invoices from KSeF")
    .option("-n, --nip <nip>", "sync a single NIP")
    .addOption(
      new Option("--redownload <ksefNumber>", "re-download a specific invoice (requires --nip)").conflicts("redownloadAll"),
    )
    .addOption(
      new Option("--redownload-all", "re-download all invoices in sync window").conflicts("redownload"),
    )
    .option("--flat-sync", "store invoices in flat monthly folders (YYYY/MM)")
    .option(
      "--output-path <path>",
      "override invoice output directory (requires --nip when multiple orgs configured)",
    )
    .option("--watch", "run continuously until interrupted")
    .option("--json", "output results as JSON")
    .action(async (options: SyncOptions) => {
      let logFile: string | null = null;
      let cmdLogger: Logger | null = null;
      const renderer = process.stderr.isTTY
        ? createProgressRenderer({ stream: process.stderr })
        : null;
      try {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const progress = renderer
          ? (message: string) => renderer.update(message)
          : undefined;
        const ctx = await createContext(config, {
          verbose,
          progress,
          countdownIntervalSeconds: verbose ? 10 : 60,
        });
        if (options.nip && !isValidNip(options.nip)) {
          throw new ConfigError("Invalid NIP format (expected 10 digits)");
        }
        const nips = options.nip
          ? [options.nip]
          : ctx.config.organizations.map((org) => org.nip);
        if (nips.length === 0) {
          throw new ConfigError("No organizations configured");
        }
        if (options.redownload && nips.length > 1) {
          throw new ConfigError("Use --nip with --redownload when multiple organizations are configured");
        }
        if (options.outputPath && nips.length > 1) {
          throw new ConfigError(
            "Use --nip with --output-path when multiple organizations are configured",
          );
        }
        if (options.watch && (options.redownload || options.redownloadAll)) {
          throw new ConfigError("--redownload flags cannot be used with --watch");
        }
        const outputPath = resolveCliOutputPath(options.outputPath);
        logFile = ctx.config.logging.file;
        cmdLogger = ctx.logger;
        const nipFilter =
          options.nip ?? (nips.length === 1 ? nips[0] : undefined);
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

        if (options.watch) {
          const intervalMs = ctx.config.pollingIntervalSeconds * 1000;
          const statusService = new StatusService(ctx.store);
          printHeader("Sync");
          printKeyValues([
            ["mode", "watch"],
            ["environment", ctx.config.environment],
            ["nips", nips.join(", ")],
            ["logFile", ctx.config.logging.file],
            ["interval", formatDuration(intervalMs)],
          ]);

          let iteration = 0;
          while (true) {
            iteration += 1;
            const startedAt = Date.now();
            let result: Awaited<ReturnType<SyncService["runOnce"]>> | null = null;
            let errorMessage: string | null = null;
            try {
              progress?.(`Progress: sync cycle ${iteration} started`);
              result = await sync.runOnce(
                undefined,
                nipFilter,
                false,
                options.flatSync,
                outputPath,
              );
              await notifier.notifyUnpaidInvoices(result, ctx.store);
            } catch (error) {
              logUnexpectedError(error, cmdLogger, logFile);
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
              printList("Invoices to pay:", formatInvoicesToPay(result?.items ?? []));
            }
            if (options.json) {
              console.log(JSON.stringify({
                iteration,
                status: errorMessage ? "failed" : "completed",
                downloaded: result?.downloaded ?? 0,
                skipped: result?.skipped ?? 0,
                failed: result?.failed ?? (errorMessage ? 1 : 0),
                toPay: invoicesToPay.length,
                durationMs,
                lastSyncAt: status.lastSyncAt ?? null,
                error: errorMessage ?? undefined,
              }));
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
        } else {
          // One-shot mode
          printHeader("Sync");
          printKeyValues([
            ["status", "starting"],
            ["environment", ctx.config.environment],
            ["nips", nips.join(", ")],
            ["logFile", ctx.config.logging.file],
            ["outputPath", outputPath ?? "(config/default)"],
          ]);
          if (!verbose) {
            console.log("Progress: run with --verbose for detailed logs.");
          }
          const result = await sync.runOnce(
            options.redownload,
            nipFilter,
            Boolean(options.redownloadAll),
            options.flatSync,
            outputPath,
          );
          const invoicesToPay = getInvoicesToPay(result.items);
          renderer?.done();
          if (options.json) {
            console.log(JSON.stringify({
              status: "completed",
              environment: ctx.config.environment,
              nips,
              downloaded: result.downloaded,
              skipped: result.skipped,
              failed: result.failed,
              toPay: invoicesToPay.length,
              items: result.items,
            }));
          } else {
            printKeyValues([
              ["status", "completed"],
              ["downloaded", result.downloaded],
              ["skipped", result.skipped],
              ["failed", result.failed],
              ["toPay", invoicesToPay.length],
            ]);
            if (result.items.length === 0) {
              console.log("Downloaded invoices: (none)");
            } else {
              printList(
                "Downloaded invoices:",
                result.items.map(
                  (item) =>
                    `${sanitizeForTerminal(item.nip)} | ${sanitizeForTerminal(item.ksefNumber)} -> ${sanitizeForTerminal(item.path)}`,
                ),
              );
            }
            if (invoicesToPay.length === 0) {
              console.log("Invoices to pay: (none)");
            } else {
              printList("Invoices to pay:", formatInvoicesToPay(result.items));
            }
          }
          await notifier.notifyUnpaidInvoices(result, ctx.store);
        }
      } catch (error) {
        const message = formatCliError(error);
        renderer?.done();
        const logHint = logUnexpectedError(error, cmdLogger, logFile);
        if (logFile) {
          printKeyValues([
            ["status", "failed"],
            ["error", message],
            ["logFile", logFile],
          ]);
        }
        console.error(`${message}${logHint}`);
        process.exitCode = exitCodeFromError(error);
      }
    });
}
