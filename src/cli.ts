#!/usr/bin/env node
import { Command } from "commander";
import YAML from "yaml";
import path from "node:path";
import { createContext } from "./cli/context";
import { sanitizeConfig } from "./config/loadConfig";
import { exitCodeFromError, ConfigError } from "./utils/errors";
import { SyncService } from "./core/syncService";
import { StatusService } from "./core/statusService";
import { Notifier } from "./notifications/notifier";
import { ServiceInstaller } from "./services/serviceInstaller";
import { printHeader, printKeyValues, printList } from "./cli/ui";
import { clearSecret, isValidNip, setSecret, showSecrets } from "./cli/secrets";
import {
  bootstrapInteractive,
  ensureInitialized,
  getInitializationStatus,
  resetAndBootstrap,
} from "./cli/bootstrap";
import { promptText } from "./cli/prompt";
import { createProgressRenderer } from "./cli/progress";
import { defaultDataRoot, ensureDir } from "./utils/paths";
import { formatDuration, sleep, sleepWithCountdown } from "./utils/time";
import { buildNodeOptionsWithLocalstorage } from "./utils/nodeOptions";

const resolveLocalstoragePath = (): string =>
  path.join(defaultDataRoot(), "localstorage.json");

const ensureLocalstorageNodeOption = async (): Promise<void> => {
  const localstoragePath = resolveLocalstoragePath();
  await ensureDir(path.dirname(localstoragePath));
  process.env.NODE_OPTIONS = buildNodeOptionsWithLocalstorage(
    process.env.NODE_OPTIONS,
    localstoragePath,
  );
};

const program = new Command();

const getCommandPath = (command: Command): string => {
  const names: string[] = [];
  let current: Command | null = command;
  while (current && current.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
};

const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const printLabelValues = (
  entries: Array<[string, string | number | null]>,
): void => {
  for (const [key, value] of entries) {
    console.log(`${key}: ${value ?? "-"}`);
  }
};

const collectLeafCommands = (command: Command): Command[] => {
  const children = command.commands.filter((child) => child.name() !== "help");
  if (children.length === 0) {
    return [command];
  }
  return children.flatMap((child) => collectLeafCommands(child));
};

const formatCommandHelp = (command: Command): string => {
  const path = getCommandPath(command);
  if (!path) {
    return "";
  }
  const options = command.options;
  if (options.length === 0) {
    return "";
  }
  const header = `${path} [options]`;
  const lines = [`  ${header}`];
  for (const option of options) {
    const required = option.required ? " (required)" : "";
    const description = option.description ? `  ${option.description}` : "";
    lines.push(`    ${option.flags}${required}${description}`);
  }
  return lines.join("\n");
};

program
  .name("ksefctl")
  .description("KSeF inbox sync CLI")
  .option("-c, --config <path>", "path to config file");

program
  .command("init")
  .description("Create config template and storage directories")
  .option("-f, --force", "reset config and re-run bootstrap")
  .option("--yes", "skip confirmation prompt")
  .action(async (options) => {
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
        await resetAndBootstrap(program.opts().config);
      } else {
        const status = await getInitializationStatus(program.opts().config);
        if (status.initialized) {
          printHeader("Init");
          printKeyValues([["status", "already initialized"]]);
          return;
        }
        await bootstrapInteractive(program.opts().config);
      }
      printHeader("Init");
      printKeyValues([["status", "initialized"]]);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("auth")
  .description("Authentication commands")
  .command("verify")
  .description("Validate authentication for configured environment")
  .option("--nip <nip>", "validate a single NIP")
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    const renderer = process.stderr.isTTY
      ? createProgressRenderer({ stream: process.stderr })
      : null;
    try {
      await ensureInitialized(program.opts().config);
      const progress = renderer
        ? (message: string) => renderer.update(message)
        : undefined;
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
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
      printHeader("Auth Verify");
      printKeyValues([
        ["status", "ok"],
        ["environment", ctx.config.environment],
      ]);
    } catch (error) {
      renderer?.done();
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("sync")
  .description("Synchronize invoices")
  .option("--once", "run a single sync cycle")
  .option("--nip <nip>", "run for a single NIP")
  .option(
    "--force-redownload <ksefNumber>",
    "force re-download for a specific invoice",
  )
  .option(
    "--force-redownload-all",
    "force re-download of all invoices in sync window",
  )
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    let started = false;
    let logFile: string | null = null;
    const renderer = process.stderr.isTTY
      ? createProgressRenderer({ stream: process.stderr })
      : null;
    try {
      await ensureInitialized(program.opts().config);
      const progress = renderer
        ? (message: string) => renderer.update(message)
        : undefined;
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
        progress,
        countdownIntervalSeconds: options.verbose ? 10 : 60,
      });
      const runOnce = options.once ?? true;
      if (!runOnce) {
        throw new ConfigError("Only --once sync is supported");
      }
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
      if (options.forceRedownloadAll && nips.length > 1) {
        throw new ConfigError(
          "Use --nip when force redownload all is requested",
        );
      }
      printHeader("Sync");
      printKeyValues([
        ["status", "starting"],
        ["environment", ctx.config.environment],
        ["nips", nips.join(", ")],
        ["logFile", ctx.config.logging.file],
      ]);
      if (!options.verbose) {
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
      );
      const notifier = new Notifier(ctx.config, ctx.logger);
      renderer?.done();
      printKeyValues([
        ["status", "completed"],
        ["downloaded", result.downloaded],
        ["skipped", result.skipped],
        ["failed", result.failed],
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
      await notifier.notify({
        downloaded: result.downloaded,
        items: result.items,
      });
    } catch (error) {
      const message = (error as Error).message;
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
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    const renderer =
      !options.verbose && process.stderr.isTTY
        ? createProgressRenderer({ stream: process.stderr })
        : null;
    try {
      await ensureInitialized(program.opts().config);
      const progress = renderer
        ? (message: string) => renderer.update(message)
        : undefined;
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
        progress,
        countdownIntervalSeconds: options.verbose ? 10 : 60,
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
      const statusService = new StatusService(ctx.store);
      let iteration = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        iteration += 1;
        const startedAt = Date.now();
        let result: Awaited<ReturnType<SyncService["runOnce"]>> | null = null;
        let errorMessage: string | null = null;
        try {
          progress?.(`Progress: sync cycle ${iteration} started`);
          result = await sync.runOnce();
        } catch (error) {
          errorMessage = (error as Error).message;
        }
        renderer?.done();
        const durationMs = Date.now() - startedAt;
        const status = await statusService.getStatus();
        printHeader("Daemon Iteration");
        const summaryEntries: Array<[string, string | number | null]> = [
          ["Status", errorMessage ? "Failed" : "Completed"],
          ["Downloaded", result?.downloaded ?? 0],
          ["Skipped", result?.skipped ?? 0],
          ["Failed", result?.failed ?? (errorMessage ? 1 : 0)],
          ["Duration", formatDuration(durationMs)],
          ["LastSyncAt", status.lastSyncAt ?? "-"],
          ["NextRunIn", formatDuration(intervalMs)],
        ];
        if (errorMessage) {
          summaryEntries.push(["Error", sanitizeForTerminal(errorMessage)]);
        }
        printLabelValues(summaryEntries);

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
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("install-service")
  .description("Install and enable launchd/systemd service")
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    try {
      await ensureInitialized(program.opts().config);
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
      });
      const installer = new ServiceInstaller();
      const cliArg = process.argv[1];
      const pathInstalled = await installer.install({
        configPath: ctx.configPath,
        storageRoot: ctx.config.storage.root,
        nodePath: process.execPath,
        cliPath: cliArg ? path.resolve(cliArg) : process.execPath,
      });
      printHeader("Service Install");
      printKeyValues([["servicePath", pathInstalled]]);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("uninstall-service")
  .description("Remove launchd/systemd service")
  .action(async () => {
    try {
      await ensureInitialized(program.opts().config);
      const installer = new ServiceInstaller();
      const pathRemoved = await installer.uninstall();
      printHeader("Service Uninstall");
      printKeyValues([["servicePath", pathRemoved]]);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("status")
  .description("Show last sync status")
  .option("--json", "output JSON")
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    try {
      await ensureInitialized(program.opts().config);
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
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
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("config")
  .description("Config commands")
  .command("show")
  .description("Show sanitized effective config")
  .option("--verbose", "enable verbose logging")
  .action(async (options) => {
    try {
      await ensureInitialized(program.opts().config);
      const ctx = await createContext(program.opts().config, {
        verbose: options.verbose,
      });
      const sanitized = sanitizeConfig(ctx.config);
      console.log(YAML.stringify(sanitized));
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

const secret = program
  .command("secret")
  .description("Keychain secret commands");

secret
  .command("set")
  .description("Store KSeF token in keychain")
  .option("--nip <nip>", "NIP (10 digits)")
  .option("--token-stdin", "Read KSeF token from stdin")
  .action(async (options) => {
    try {
      const result = await setSecret(
        program.opts().config,
        options.nip,
        undefined,
        Boolean(options.tokenStdin),
      );
      printHeader("Secret Set");
      printKeyValues([["nip", result.nip]]);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

secret
  .command("show")
  .description("Show keychain secret presence")
  .action(async () => {
    try {
      const entries = await showSecrets(program.opts().config);
      printHeader("Secrets");
      printKeyValues(
        entries.map((entry) => [
          entry.nip,
          entry.present ? "present" : "missing",
        ]),
      );
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

secret
  .command("clear")
  .description("Remove keychain secret for a NIP")
  .requiredOption("--nip <nip>", "NIP (10 digits)")
  .action(async (options) => {
    try {
      await clearSecret(program.opts().config, options.nip);
      printHeader("Secret Clear");
      printKeyValues([["nip", options.nip]]);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program.addHelpText("after", () => {
  const leafCommands = collectLeafCommands(program).filter(
    (command) => command !== program,
  );
  if (leafCommands.length === 0) {
    return "";
  }
  const entries = leafCommands
    .map((command) => formatCommandHelp(command))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return "";
  }
  return `\nCommand-specific options:\n  (Global options apply to all commands.)\n${entries.join("\n")}`;
});

const main = async () => {
  try {
    await ensureLocalstorageNodeOption();
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = exitCodeFromError(error);
  }
};

void main();
