import type { Command } from "commander";
import type { Logger } from "pino";
import path from "node:path";
import { SyncService } from "../../core/syncService";
import { Notifier } from "../../notifications/notifier";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import { expandHome } from "../../utils/paths";
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
  forceRedownload?: string;
  forceRedownloadAll?: boolean;
  flatSync?: boolean;
  outputPath?: string;
  verbose?: boolean;
};

const resolveCliOutputPath = (outputPath?: string): string | undefined => {
  if (!outputPath) return undefined;
  const expanded = expandHome(outputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
};

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Synchronize invoices")
    .option("--nip <nip>", "run for a single NIP")
    .option(
      "--force-redownload <ksefNumber>",
      "force re-download for a specific invoice",
    )
    .option(
      "--force-redownload-all",
      "force re-download of all invoices in sync window",
    )
    .option("--flat-sync", "store fetched invoices in flat monthly folders")
    .option(
      "--output-path <path>",
      "override invoice output path for the selected NIP or single-org run",
    )
    .option("-v, --verbose", "enable verbose logging")
    .action(async (options: SyncOptions) => {
      let started = false;
      let logFile: string | null = null;
      let cmdLogger: Logger | null = null;
      const renderer = process.stderr.isTTY
        ? createProgressRenderer({ stream: process.stderr })
        : null;
      try {
        const rootOpts = program.opts<RootOptions>();
        const verbose = options.verbose ?? rootOpts.verbose;
        const { config } = rootOpts;
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
        if (options.forceRedownload && options.forceRedownloadAll) {
          throw new ConfigError(
            "Use either --force-redownload or --force-redownload-all",
          );
        }
        if (options.forceRedownload && nips.length > 1) {
          throw new ConfigError("Use --nip when force redownload is requested");
        }
        if (options.outputPath && nips.length > 1) {
          throw new ConfigError(
            "Use --nip with --output-path when multiple organizations are configured",
          );
        }
        const outputPath = resolveCliOutputPath(options.outputPath);
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
        started = true;
        logFile = ctx.config.logging.file;
        cmdLogger = ctx.logger;
        const sync = new SyncService({
          client: ctx.client,
          auth: ctx.auth,
          config: ctx.config,
          logger: ctx.logger,
          store: ctx.store,
          progress,
          countdownIntervalSeconds: ctx.countdownIntervalSeconds,
        });
        const nipFilter =
          options.nip ?? (nips.length === 1 ? nips[0] : undefined);
        const result = await sync.runOnce(
          options.forceRedownload,
          nipFilter,
          Boolean(options.forceRedownloadAll),
          options.flatSync,
          outputPath,
        );
        const notifier = new Notifier(ctx.config, ctx.logger);
        const invoicesToPay = getInvoicesToPay(result.items);
        renderer?.done();
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
        await notifier.notifyUnpaidInvoices(result, ctx.store);
      } catch (error) {
        const message = formatCliError(error);
        renderer?.done();
        const logHint = logUnexpectedError(error, cmdLogger, logFile);
        if (started) {
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
