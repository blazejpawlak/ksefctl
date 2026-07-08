import type { Command } from "commander";
import type { Logger } from "pino";
import { Option } from "commander";
import path from "node:path";
import { repairMissingInvoicePdfs } from "../../core/pdfRepairService";
import { StatusService } from "../../core/statusService";
import { SyncService } from "../../core/syncService";
import { parseCliTimeWindow } from "../../core/window";
import { Notifier } from "../../notifications/notifier";
import { PdfService } from "../../services/pdfService";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import { expandHome } from "../../utils/paths";
import {
  installServiceStopSignalLogging,
  logServiceLifecycle,
} from "../../utils/serviceLifecycle";
import { formatDuration, sleep, sleepWithCountdown } from "../../utils/time";
import { ensureInitialized } from "../bootstrap";
import { sanitizeForTerminal } from "../commandTree";
import { createContext } from "../context";
import { isValidNip } from "../keychain";
import { getLifecycleEventEntries } from "../lifecycleStatus";
import { formatInvoicesToPay, getInvoicesToPay } from "../paymentSummary";
import { createProgressRenderer } from "../progress";
import { printHeader, printKeyValues, printList } from "../ui";
import { readVersionOutput } from "../version";
import {
  formatCliError,
  logUnexpectedError,
  type RootOptions,
} from "./runCommand";

type SyncOptions = {
  nip?: string;
  redownload?: string;
  redownloadAll?: boolean;
  flatSync?: boolean;
  timeWindow?: string;
  outputPath?: string;
  watch?: boolean;
  json?: boolean;
  repairMissingPdfs?: boolean;
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
    .option("-n, --nip <nip>", "sync or re-download for a single NIP")
    .addOption(
      new Option(
        "--redownload <ksefNumber>",
        "re-download a specific invoice (requires --nip)",
      ).conflicts("redownloadAll"),
    )
    .addOption(
      new Option(
        "--redownload-all",
        "re-download all invoices in sync window (optionally filter by --nip)",
      ).conflicts("redownload"),
    )
    .option("--flat-sync", "store invoices in flat monthly folders (YYYY/MM)")
    .addOption(
      new Option(
        "--time-window <from:to>",
        "explicit date range as DD-MM-YYYY:DD-MM-YYYY (requires --redownload, --redownload-all, or --flat-sync)",
      ).conflicts("watch"),
    )
    .option(
      "--output-path <path>",
      "override invoice output directory (requires --nip when multiple orgs configured)",
    )
    .option(
      "--watch",
      "run continuously in the foreground, polling every pollingIntervalSeconds (default: 300 s); for background/unattended use run system service install instead",
    )
    .addOption(
      new Option(
        "--repair-missing-pdfs",
        "generate PDFs for local XML invoices that are missing PDF files without contacting KSeF",
      ).conflicts([
        "watch",
        "redownload",
        "redownloadAll",
        "flatSync",
        "timeWindow",
      ]),
    )
    .option("--json", "output results as JSON")
    .action(async (options: SyncOptions) => {
      let logFile: string | null = null;
      let cmdLogger: Logger | null = null;
      let cleanupServiceStopLogging: (() => void) | null = null;
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
        const version = await readVersionOutput();
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
          throw new ConfigError(
            "Use --nip with --redownload when multiple organizations are configured",
          );
        }
        if (options.outputPath && nips.length > 1) {
          throw new ConfigError(
            "Use --nip with --output-path when multiple organizations are configured",
          );
        }
        if (options.watch && (options.redownload || options.redownloadAll)) {
          throw new ConfigError(
            "--redownload flags cannot be used with --watch",
          );
        }
        if (options.outputPath && options.repairMissingPdfs) {
          throw new ConfigError(
            "--output-path cannot be used with --repair-missing-pdfs",
          );
        }
        if (
          options.timeWindow &&
          !options.redownload &&
          !options.redownloadAll &&
          !options.flatSync
        ) {
          throw new ConfigError(
            "--time-window requires --redownload, --redownload-all, or --flat-sync",
          );
        }
        const explicitWindow = options.timeWindow
          ? parseCliTimeWindow(options.timeWindow)
          : undefined;
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
        const statusService = new StatusService(ctx.store);

        if (options.repairMissingPdfs) {
          printHeader("Repair missing PDFs");
          const result = await repairMissingInvoicePdfs(
            {
              config: ctx.config,
              logger: ctx.logger,
              pdfService: new PdfService(),
            },
            { nip: nipFilter },
          );
          if (options.json) {
            console.log(JSON.stringify({ status: "completed", ...result }));
          } else {
            printKeyValues([
              ["status", "completed"],
              ["scanned", result.scanned],
              ["missing", result.missing],
              ["repaired", result.repaired],
              ["failed", result.failed],
              ["skipped", result.skipped],
            ]);
            const failedItems = result.items.filter(
              (item) => item.status === "failed",
            );
            if (failedItems.length > 0) {
              printList(
                "Failed PDF repairs:",
                failedItems.map(
                  (item) =>
                    `${sanitizeForTerminal(item.nip)} | ${sanitizeForTerminal(item.ksefNumber || "-")} | ${sanitizeForTerminal(item.reason ?? "failed")} | ${sanitizeForTerminal(item.xmlPath)}`,
                ),
              );
            }
          }
          return;
        }

        if (options.watch) {
          cleanupServiceStopLogging = installServiceStopSignalLogging(
            ctx.logger,
          );
          const startupEvent = logServiceLifecycle(ctx.logger, {
            action: "start",
            stage: "completed",
            origin: "service",
            reason: "watch-mode-entered",
            context: { serviceMode: "watch" },
          });
          await statusService.recordLifecycle(startupEvent);
          const intervalMs = ctx.config.pollingIntervalSeconds * 1000;
          printHeader("Sync");
          printKeyValues([
            ["mode", "watch"],
            ["version", version],
            ["environment", ctx.config.environment],
            ["nips", nips.join(", ")],
            ["logFile", ctx.config.logging.file],
            ["interval", formatDuration(intervalMs)],
            ...getLifecycleEventEntries(startupEvent),
          ]);

          let iteration = 0;
          while (true) {
            iteration += 1;
            const startedAt = Date.now();
            let result: Awaited<ReturnType<SyncService["runOnce"]>> | null =
              null;
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
              ["pdfFailed", result?.pdfFailed ?? 0],
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
            if (options.json) {
              console.log(
                JSON.stringify({
                  iteration,
                  status: errorMessage ? "failed" : "completed",
                  downloaded: result?.downloaded ?? 0,
                  skipped: result?.skipped ?? 0,
                  failed: result?.failed ?? (errorMessage ? 1 : 0),
                  pdfFailed: result?.pdfFailed ?? 0,
                  toPay: invoicesToPay.length,
                  durationMs,
                  lastSyncAt: status.lastSyncAt ?? null,
                  error: errorMessage ?? undefined,
                }),
              );
            }
            if (progress) {
              progress(`Progress: next run in ${formatDuration(intervalMs)}`);
              await sleepWithCountdown(
                intervalMs,
                ctx.countdownIntervalSeconds,
                (remaining) =>
                  progress(
                    `Progress: next run in ${formatDuration(remaining)}`,
                  ),
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
            ["version", version],
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
            explicitWindow,
          );
          const invoicesToPay = getInvoicesToPay(result.items);
          renderer?.done();
          if (options.json) {
            console.log(
              JSON.stringify({
                status: "completed",
                environment: ctx.config.environment,
                nips,
                downloaded: result.downloaded,
                skipped: result.skipped,
                failed: result.failed,
                pdfFailed: result.pdfFailed,
                toPay: invoicesToPay.length,
                items: result.items,
              }),
            );
          } else {
            printKeyValues([
              ["status", "completed"],
              ["downloaded", result.downloaded],
              ["skipped", result.skipped],
              ["failed", result.failed],
              ["pdfFailed", result.pdfFailed],
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
        cleanupServiceStopLogging?.();
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
