#!/usr/bin/env node
import { Command } from "commander";
import YAML from "yaml";
import path from "node:path";
import {
  bootstrapInteractive,
  ensureInitialized,
  getInitializationStatus,
  resetAndBootstrap,
} from "./cli/bootstrap";
import {
  collectLeafCommands,
  formatCommandHelp,
  printLabelValues,
  sanitizeForTerminal,
} from "./cli/commandTree";
import {
  buildCompletionSpec,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "./cli/completion";
import { createContext } from "./cli/context";
import { handleFirstRun, shouldRunFirstRun } from "./cli/firstRun";
import {
  clearSecret,
  isValidNip,
  setSecret,
  showSecrets,
} from "./cli/keychain";
import { formatInvoicesToPay, getInvoicesToPay } from "./cli/paymentSummary";
import { createProgressRenderer } from "./cli/progress";
import { promptText } from "./cli/prompt";
import { printHeader, printKeyValues, printList } from "./cli/ui";
import {
  ensureLocalstorageNodeOption,
  formatVersionOutput,
  printVersion,
} from "./cli/version";
import { sanitizeConfig } from "./config/loadConfig";
import { StatusService } from "./core/statusService";
import { SyncService } from "./core/syncService";
import { Notifier } from "./notifications/notifier";
import { ServiceInstaller } from "./services/serviceInstaller";
import {
  ConfigError,
  exitCodeFromError,
  formatErrorMessage,
} from "./utils/errors";
import { expandHome } from "./utils/paths";
import { formatDuration, sleep, sleepWithCountdown } from "./utils/time";

const program = new Command();

type RootOptions = {
  config?: string;
  verbose?: boolean;
  firstRun?: boolean;
};

type InitOptions = {
  force?: boolean;
  yes?: boolean;
};

type VerifyOptions = {
  nip?: string;
  verbose?: boolean;
};

type SyncOptions = {
  nip?: string;
  forceRedownload?: string;
  forceRedownloadAll?: boolean;
  flatSync?: boolean;
  outputPath?: string;
  verbose?: boolean;
};

type DaemonOptions = {
  verbose?: boolean;
};

type ServiceInstallOptions = {
  verbose?: boolean;
};

type StatusOptions = {
  json?: boolean;
  verbose?: boolean;
};

type ConfigShowOptions = {
  verbose?: boolean;
};

type SecretSetOptions = {
  nip?: string;
  tokenStdin?: boolean;
};

type SecretClearOptions = {
  nip: string;
};

const formatCliError = (error: unknown): string =>
  sanitizeForTerminal(formatErrorMessage(error));

const getRootOptions = (): RootOptions => program.opts<RootOptions>();

const parseConfigOverride = (args: string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--config" || arg === "-c") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        return next;
      }
      return undefined;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
};

const parseFirstRunFlag = (args: string[]): boolean | undefined =>
  args.includes("--no-first-run") ? false : undefined;

const resolveCliOutputPath = (outputPath?: string): string | undefined => {
  if (!outputPath) return undefined;
  const expanded = expandHome(outputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
};

const hasVersionFlag = (args: string[]): boolean => {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--version" || arg === "-V") {
      return true;
    }
  }
  return false;
};

const hasCommandArgs = (args: string[]): boolean => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      return args.slice(i + 1).some((value) => value.length > 0);
    }
    if (arg === "--config" || arg === "-c") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (arg.trim().length === 0) {
      continue;
    }
    return true;
  }
  return false;
};

program
  .name("ksefctl")
  .description("KSeF inbox sync CLI")
  .option("-c, --config <path>", "path to config file")
  .option("-v, --verbose", "enable verbose logging")
  .option("-V, --version", "output application version")
  .option("--no-first-run", "disable first-run prompts");

const system = program.command("system").description("System commands");

system
  .command("init")
  .description("Create config template and storage directories")
  .option("-f, --force", "reset config and re-run bootstrap")
  .option("--yes", "skip confirmation prompt")
  .action(async (options: InitOptions) => {
    try {
      if (!process.stdin.isTTY) {
        throw new ConfigError("Init requires an interactive terminal");
      }
      if (options.force) {
        if (!options.yes) {
          const confirm = await promptText(
            "This will remove config and keychain tokens for all NIPs. Continue? (y/N): ",
          );
          if (!/^y(es)?$/i.test(confirm.trim())) {
            printHeader("Init");
            printKeyValues([["status", "cancelled"]]);
            return;
          }
        }
        const { config } = getRootOptions();
        await resetAndBootstrap(config);
      } else {
        const { config } = getRootOptions();
        const status = await getInitializationStatus(config);
        if (status.initialized) {
          printHeader("Init");
          printKeyValues([["status", "already initialized"]]);
          return;
        }
        await bootstrapInteractive(config);
      }
      printHeader("Init");
      printKeyValues([["status", "initialized"]]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

system
  .command("verify")
  .description("Validate authentication for configured environment")
  .option("--nip <nip>", "validate a single NIP")
  .option("-v, --verbose", "enable verbose logging")
  .action(async (options: VerifyOptions) => {
    const renderer = process.stderr.isTTY
      ? createProgressRenderer({ stream: process.stderr })
      : null;
    try {
      const rootOpts = getRootOptions();
      const verbose = options.verbose ?? rootOpts.verbose;
      const { config } = rootOpts;
      await ensureInitialized(config);
      const progress = renderer
        ? (message: string) => renderer.update(message)
        : undefined;
      const ctx = await createContext(config, {
        verbose,
        progress,
      });
      if (options.nip && !isValidNip(options.nip)) {
        throw new ConfigError("Invalid NIP format (expected 10 digits)");
      }
      const nips = options.nip
        ? [options.nip]
        : ctx.config.organizations.map((org) => org.nip);
      for (const nip of nips) {
        await ctx.auth.getAccessToken(nip);
      }
      renderer?.done();
      printHeader("System Verify");
      printKeyValues([
        ["status", "ok"],
        ["environment", ctx.config.environment],
      ]);
    } catch (error) {
      renderer?.done();
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

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
    const renderer = process.stderr.isTTY
      ? createProgressRenderer({ stream: process.stderr })
      : null;
    try {
      const rootOpts = getRootOptions();
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
      let nips = options.nip
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
      const sync = new SyncService(
        ctx.client,
        ctx.auth,
        ctx.config,
        ctx.logger,
        ctx.store,
        progress,
        ctx.countdownIntervalSeconds,
      );
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
      if (started) {
        printKeyValues([
          ["status", "failed"],
          ["error", message],
          ["logFile", logFile],
        ]);
      }
      console.error(message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("daemon")
  .description("Run continuous foreground sync")
  .option("-v, --verbose", "enable verbose logging")
  .action(async (options: DaemonOptions) => {
    const rootOpts = getRootOptions();
    const verbose = options.verbose ?? rootOpts.verbose;
    const { config } = rootOpts;
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
      const nips = ctx.config.organizations.map((org) => org.nip);
      if (nips.length === 0) {
        throw new ConfigError("No organizations configured");
      }
      const intervalMs = ctx.config.pollingIntervalSeconds * 1000;
      printHeader("Daemon");
      printLabelValues([
        ["Status", "Running"],
        ["Environment", ctx.config.environment],
        ["NIPs", nips.join(", ")],
        ["LogFile", ctx.config.logging.file],
        ["Interval", formatDuration(intervalMs)],
      ]);

      const sync = new SyncService(
        ctx.client,
        ctx.auth,
        ctx.config,
        ctx.logger,
        ctx.store,
        progress,
        ctx.countdownIntervalSeconds,
      );
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
        printLabelValues(summaryEntries);
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
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

const systemService = system
  .command("service")
  .description("Service management commands");

systemService
  .command("install")
  .description("Install and enable launchd/systemd service")
  .option("-v, --verbose", "enable verbose logging")
  .action(async (options: ServiceInstallOptions) => {
    try {
      const rootOpts = getRootOptions();
      const verbose = options.verbose ?? rootOpts.verbose;
      const { config } = rootOpts;
      await ensureInitialized(config);
      const ctx = await createContext(config, {
        verbose,
      });
      const installer = new ServiceInstaller();
      const cliArg = process.argv[1];
      const pathInstalled = await installer.install({
        configPath: ctx.configPath,
        storageRoot: ctx.config.storage.root,
        nodePath: process.execPath,
        cliPath: cliArg ? path.resolve(cliArg) : process.execPath,
      });
      printHeader("System Service Install");
      printKeyValues([["servicePath", pathInstalled]]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

systemService
  .command("uninstall")
  .description("Remove launchd/systemd service")
  .action(async () => {
    try {
      const { config } = getRootOptions();
      await ensureInitialized(config);
      const installer = new ServiceInstaller();
      const pathRemoved = await installer.uninstall();
      printHeader("System Service Uninstall");
      printKeyValues([["servicePath", pathRemoved]]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("status")
  .description("Show last sync status")
  .option("--json", "output JSON")
  .option("-v, --verbose", "enable verbose logging")
  .action(async (options: StatusOptions) => {
    try {
      const rootOpts = getRootOptions();
      const verbose = options.verbose ?? rootOpts.verbose;
      const { config } = rootOpts;
      await ensureInitialized(config);
      const ctx = await createContext(config, {
        verbose,
      });
      const statusService = new StatusService(ctx.store);
      const status = await statusService.getStatus();
      const payload = {
        configPath: ctx.configPath,
        storageRoot: ctx.config.storage.root,
        ...status,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printHeader("Status");
      printKeyValues([
        ["configPath", payload.configPath],
        ["storageRoot", payload.storageRoot],
        ["lastSyncAt", payload.lastSyncAt],
        ["lastSuccessAt", payload.lastSuccessAt],
        ["lastError", payload.lastError],
        ["lastDownloadedCount", payload.lastDownloadedCount],
      ]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("version")
  .description("Show current version")
  .action(async () => {
    try {
      await printVersion();
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

const systemConfig = system.command("config").description("Config commands");

systemConfig
  .command("show")
  .description("Show sanitized effective config")
  .option("-v, --verbose", "enable verbose logging")
  .action(async (options: ConfigShowOptions) => {
    try {
      const rootOpts = getRootOptions();
      const verbose = options.verbose ?? rootOpts.verbose;
      const { config } = rootOpts;
      await ensureInitialized(config);
      const ctx = await createContext(config, {
        verbose,
      });
      const sanitized = sanitizeConfig(ctx.config);
      console.log(YAML.stringify(sanitized));
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

const secret = system.command("secret").description("Keychain secret commands");

secret
  .command("set")
  .description("Store KSeF token in keychain")
  .option("--nip <nip>", "NIP (10 digits)")
  .option("--token-stdin", "Read KSeF token from stdin")
  .action(async (options: SecretSetOptions) => {
    try {
      const { config } = getRootOptions();
      const result = await setSecret(
        config,
        options.nip,
        undefined,
        Boolean(options.tokenStdin),
      );
      printHeader("Secret Set");
      printKeyValues([["nip", result.nip]]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

secret
  .command("show")
  .description("Show keychain secret presence")
  .action(async () => {
    try {
      const { config } = getRootOptions();
      const entries = await showSecrets(config);
      printHeader("Secrets");
      printKeyValues(
        entries.map((entry) => [
          entry.nip,
          entry.present ? "present" : "missing",
        ]),
      );
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

secret
  .command("clear")
  .description("Remove keychain secret for a NIP")
  .requiredOption("--nip <nip>", "NIP (10 digits)")
  .action(async (options: SecretClearOptions) => {
    try {
      const { config } = getRootOptions();
      await clearSecret(config, options.nip);
      printHeader("Secret Clear");
      printKeyValues([["nip", options.nip]]);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  });

system
  .command("completion")
  .description("Print shell completion script (used for auto-install)")
  .argument("<shell>", "shell type (bash|zsh|fish)")
  .action((shell: string) => {
    const normalized = shell.trim().toLowerCase();
    const spec = buildCompletionSpec(program);
    if (normalized === "bash") {
      console.log(renderBashCompletion(spec));
      return;
    }
    if (normalized === "zsh") {
      console.log(renderZshCompletion(spec));
      return;
    }
    if (normalized === "fish") {
      console.log(renderFishCompletion(spec));
      return;
    }
    throw new ConfigError(
      `Unsupported shell: ${shell}. Use bash, zsh, or fish.`,
    );
  });

program.addHelpText("after", () => {
  const leafCommands = collectLeafCommands(program).filter(
    (command) => command !== program,
  );
  const entries = leafCommands
    .map((command) => formatCommandHelp(command))
    .filter((entry) => entry.length > 0);
  const commandOptions =
    entries.length === 0
      ? ""
      : `\nCommand-specific options:\n  (Global options apply to all commands.)\n${entries.join("\n")}`;
  const completionNote =
    "\nShell completion:\n  ksefctl system completion <bash|zsh|fish>";
  const firstRunNote =
    "\nFirst run:\n  Prompts to install completion and initialize when the data root is missing (disable with --no-first-run or KSEFCTL_NO_FIRST_RUN=1).";
  return `${commandOptions}${completionNote}${firstRunNote}`;
});

const main = async () => {
  try {
    const args = process.argv.slice(2);
    const hasHelp = args.includes("--help") || args.includes("-h");
    const hasCommand = hasCommandArgs(args);
    if (hasHelp && !hasCommand) {
      program.outputHelp();
      return;
    }
    if (hasVersionFlag(args)) {
      await printVersion();
      return;
    }
    if (!hasHelp && !hasCommand) {
      const configPath = parseConfigOverride(args);
      const firstRunFlag = parseFirstRunFlag(args);
      await handleFirstRun(program, { configPath, firstRunFlag });
      await ensureLocalstorageNodeOption();
      program.outputHelp();
      return;
    }
    await ensureLocalstorageNodeOption();
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = exitCodeFromError(error);
  }
};

if (require.main === module) {
  void main();
}

export {
  buildCompletionSpec,
  formatCliError,
  formatVersionOutput,
  hasVersionFlag,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
  shouldRunFirstRun,
};
