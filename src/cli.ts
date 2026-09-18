#!/usr/bin/env node
import { Command, Option } from "commander";
import { registerDaemon } from "./cli/commands/daemon";
import { formatCliError, logUnexpectedError } from "./cli/commands/runCommand";
import { registerStatus } from "./cli/commands/status";
import { registerSync } from "./cli/commands/sync";
import { registerSystemCompletion } from "./cli/commands/systemCompletion";
import { registerSystemConfig } from "./cli/commands/systemConfig";
import { registerSystemInit } from "./cli/commands/systemInit";
import { registerSystemNotifications } from "./cli/commands/systemNotifications";
import { registerSystemPin } from "./cli/commands/systemPin";
import { registerSystemSecret } from "./cli/commands/systemSecret";
import {
  registerSystemService,
  showServiceLogs,
} from "./cli/commands/systemService";
import { registerSystemVerify } from "./cli/commands/systemVerify";
import {
  buildCompletionSpec,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "./cli/completion";
import { handleFirstRun, shouldRunFirstRun } from "./cli/firstRun";
import {
  ensureLocalstorageNodeOption,
  formatVersionOutput,
  printVersion,
} from "./cli/version";
import { exitCodeFromError } from "./utils/errors";

export { formatCliError, logUnexpectedError };

const program = new Command();

program
  .name("ksefctl")
  .description("KSeF inbox sync CLI")
  .option("-c, --config <path>", "path to config file")
  .option("-v, --verbose", "enable verbose logging")
  .option("-V, --version", "output application version")
  .addOption(
    new Option("--no-first-run", "disable first-run prompts").hideHelp(),
  );

const system = program
  .command("system")
  .description("Setup, credentials, and service management");

registerSystemInit(system, program);
registerSystemVerify(system, program);
registerSystemService(system, program);
registerSystemPin(system);
registerSystemConfig(system, program);
registerSystemSecret(system, program);
registerSystemNotifications(system, program);
registerSystemCompletion(system, program);
registerSync(program);
registerDaemon(program);
registerStatus(program);

program.addHelpText("after", () => {
  const completionNote =
    "\nShell completion:\n  ksefctl system completion <bash|zsh|fish>";
  const firstRunNote =
    "\nFirst run:\n  Prompts to install completion and initialize when the data root is missing.";
  return `${completionNote}${firstRunNote}`;
});

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
      await showServiceLogs(configPath, { lines: "50" });
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
  formatVersionOutput,
  hasVersionFlag,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
  shouldRunFirstRun,
};
