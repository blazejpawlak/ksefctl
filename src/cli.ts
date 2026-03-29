#!/usr/bin/env node
import { Command } from "commander";
import YAML from "yaml";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bootstrapInteractive,
  ensureInitialized,
  getInitializationStatus,
  resetAndBootstrap,
} from "./cli/bootstrap";
import { createContext } from "./cli/context";
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
import { sanitizeConfig } from "./config/loadConfig";
import { StatusService } from "./core/statusService";
import { SyncService } from "./core/syncService";
import { Notifier } from "./notifications/notifier";
import { ServiceInstaller } from "./services/serviceInstaller";
import { exitCodeFromError, ConfigError } from "./utils/errors";
import { buildNodeOptionsWithLocalstorage } from "./utils/nodeOptions";
import { defaultDataRoot, ensureDir } from "./utils/paths";
import { formatDuration, sleep, sleepWithCountdown } from "./utils/time";

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
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
};

const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const printLabelValues = (
  entries: [string, string | number | null][],
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

type OptionMeta = {
  short?: string;
  long?: string;
  description?: string;
  takesValue: boolean;
  valueName?: string;
};

type ShellType = "bash" | "zsh" | "fish";

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
  once?: boolean;
  nip?: string;
  forceRedownload?: string;
  forceRedownloadAll?: boolean;
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

const getRootOptions = (): RootOptions => program.opts<RootOptions>();

const parseOptionMeta = (option: {
  flags: string;
  description?: string;
}): OptionMeta => {
  const takesValue = /<[^>]+>|\[[^\]]+\]/.test(option.flags);
  const valueMatch = /<(\w+)>|\[(\w+)\]/.exec(option.flags);
  const valueName = valueMatch ? (valueMatch[1] ?? valueMatch[2]) : undefined;
  const parts = option.flags
    .split(/[ ,|]+/)
    .map((part) => part.replace(/,$/, ""))
    .filter(
      (part) =>
        part.startsWith("-") && !part.includes("<") && !part.includes("["),
    );
  const long = parts.find((part) => part.startsWith("--"));
  const short = parts.find((part) => /^-[^-]$/.test(part));
  return {
    short,
    long,
    description: option.description,
    takesValue,
    valueName,
  };
};

const optionNames = (options: OptionMeta[]): string[] => {
  const names = options
    .flatMap((option) => [option.long, option.short])
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(names));
};

const isConfigOption = (option: OptionMeta): boolean =>
  option.long === "--config" || option.short === "-c";

const buildCompletionSpec = (root: Command) => {
  const topCommands = root.commands
    .filter((child) => child.name() !== "help")
    .map((child) => child.name())
    .sort();
  const subcommandsByPath: Record<string, string[]> = {
    "": topCommands,
  };
  const optionsByPath: Record<string, OptionMeta[]> = {};

  const collectOptions = (command: Command): OptionMeta[] =>
    command.options.map((option) => parseOptionMeta(option));

  const visit = (
    command: Command,
    path: string,
    inheritedOptions: OptionMeta[],
  ) => {
    const currentOptions = [...inheritedOptions, ...collectOptions(command)];
    optionsByPath[path] = currentOptions;
    const children = command.commands.filter(
      (child) => child.name() !== "help",
    );
    subcommandsByPath[path] = children.map((child) => child.name()).sort();
    for (const child of children) {
      const childPath = path ? `${path} ${child.name()}` : child.name();
      visit(child, childPath, currentOptions);
    }
  };

  visit(root, "", []);
  subcommandsByPath["system completion"] = ["bash", "zsh", "fish"];
  return { subcommandsByPath, optionsByPath };
};

const renderBashCompletion = (spec: {
  subcommandsByPath: Record<string, string[]>;
  optionsByPath: Record<string, OptionMeta[]>;
}): string => {
  const topLevel = (spec.subcommandsByPath[""] ?? []).join(" ");
  const lines = [
    "_ksefctl_complete() {",
    "  local cur",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  local prev",
    "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
    "  if [[ \"$prev\" == \"--config\" || \"$prev\" == \"-c\" ]]; then",
    "    COMPREPLY=( $(compgen -f -- \"$cur\") )",
    "    return 0",
    "  fi",
    "  if [[ \"$cur\" == --config=* ]]; then",
    "    local pathpart=\"${cur#--config=}\"",
    "    local matches=( $(compgen -f -- \"$pathpart\") )",
    "    COMPREPLY=()",
    "    for m in \"${matches[@]}\"; do COMPREPLY+=(\"--config=$m\"); done",
    "    return 0",
    "  fi",
    "  local cmdpath=\"\"",
    "  local word",
    "  for ((i=1; i<COMP_CWORD; i++)); do",
    "    word=\"${COMP_WORDS[i]}\"",
    "    if [[ \"$word\" == -- ]]; then break; fi",
    "    if [[ \"$word\" == -* ]]; then",
    "      if [[ $i -lt $((COMP_CWORD-1)) && \"${COMP_WORDS[i+1]}\" != -* ]]; then",
    "        ((i++))",
    "      fi",
    "      continue",
    "    fi",
    "    case \"$cmdpath\" in",
    "      \"\")",
    `        case \"$word\" in ${topLevel.replace(/ /g, "|")}) cmdpath=\"$word\";; *) break;; esac`,
    "        ;;",
  ];
  const paths = Object.keys(spec.subcommandsByPath)
    .filter((path) => path.length > 0)
    .sort((a, b) => a.split(" ").length - b.split(" ").length);
  for (const path of paths) {
    const subs = spec.subcommandsByPath[path];
    if (!subs || subs.length === 0) continue;
    lines.push(`      \"${path}\")`);
    lines.push(
      `        case \"$word\" in ${subs.join("|")}) cmdpath=\"${path} $word\";; *) break;; esac`,
    );
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("  done");
  lines.push("  if [[ \"$cur\" == -* ]]; then");
  lines.push("    case \"$cmdpath\" in");
  for (const [path, options] of Object.entries(spec.optionsByPath)) {
    const names = optionNames(options).join(" ");
    lines.push(`      \"${path}\")`);
    lines.push(`        COMPREPLY=( $(compgen -W \"${names}\" -- \"$cur\") )`);
    lines.push("        return 0");
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    COMPREPLY=()");
  lines.push("    return 0");
  lines.push("  fi");
  lines.push("  if [ $COMP_CWORD -eq 1 ]; then");
  lines.push(`    COMPREPLY=( $(compgen -W \"${topLevel}\" -- \"$cur\") )`);
  lines.push("    return 0");
  lines.push("  fi");
  lines.push("  case \"$cmdpath\" in");
  for (const [path, subs] of Object.entries(spec.subcommandsByPath)) {
    if (path === "" || subs.length === 0) continue;
    const depth = path.split(" ").length + 1;
    lines.push(`    \"${path}\")`);
    lines.push(`      if [ $COMP_CWORD -eq ${depth} ]; then`);
    lines.push(
      `        COMPREPLY=( $(compgen -W \"${subs.join(" ")}\" -- \"$cur\") )`,
    );
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("complete -F _ksefctl_complete ksefctl");
  return lines.join("\n");
};

const renderZshCompletion = (spec: {
  subcommandsByPath: Record<string, string[]>;
  optionsByPath: Record<string, OptionMeta[]>;
}): string => {
  const lines = [
    "#compdef ksefctl",
    "_ksefctl() {",
    "  local -a commands",
    `  commands=(${(spec.subcommandsByPath[""] ?? []).join(" ")})`,
    "  _arguments -C '1:command:->commands' '*::args:->args'",
    "  case $state in",
    "    commands)",
    "      _values 'command' ${commands[@]}",
    "      return",
    "      ;;",
    "  esac",
    "  local cur=\"${words[CURRENT]}\"",
    "  local prev=\"${words[CURRENT-1]}\"",
    "  if [[ \"$prev\" == \"--config\" || \"$prev\" == \"-c\" ]]; then",
    "    _files",
    "    return",
    "  fi",
    "  local cmdpath=\"\"",
    "  local word",
    "  local i=2",
    "  while (( i < CURRENT )); do",
    "    word=\"${words[i]}\"",
    "    if [[ \"$word\" == -- ]]; then break; fi",
    "    if [[ \"$word\" == -* ]]; then",
    "      if (( i < CURRENT - 1 )) && [[ \"${words[i+1]}\" != -* ]]; then",
    "        (( i++ ))",
    "      fi",
    "      (( i++ ))",
    "      continue",
    "    fi",
    "    case \"$cmdpath\" in",
    "      \"\")",
    `        case \"$word\" in ${(spec.subcommandsByPath[""] ?? []).join("|")}) cmdpath=\"$word\";; *) break;; esac`,
    "        ;;",
  ];
  const paths = Object.keys(spec.subcommandsByPath)
    .filter((path) => path.length > 0)
    .sort((a, b) => a.split(" ").length - b.split(" ").length);
  for (const path of paths) {
    const subs = spec.subcommandsByPath[path];
    if (!subs || subs.length === 0) continue;
    lines.push(`      \"${path}\")`);
    lines.push(
      `        case \"$word\" in ${subs.join("|")}) cmdpath=\"${path} $word\";; *) break;; esac`,
    );
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    (( i++ ))");
  lines.push("  done");
  lines.push("  if [[ \"$cur\" == -* ]]; then");
  lines.push("    case \"$cmdpath\" in");
  for (const [path, options] of Object.entries(spec.optionsByPath)) {
    const names = optionNames(options).join(" ");
    lines.push(`      \"${path}\")`);
    lines.push(`        _values 'option' ${names}`);
    lines.push("        return");
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    return");
  lines.push("  fi");
  lines.push("  case \"$cmdpath\" in");
  for (const [path, subs] of Object.entries(spec.subcommandsByPath)) {
    if (path === "" || subs.length === 0) continue;
    const depth = path.split(" ").length + 2;
    lines.push(`    \"${path}\")`);
    lines.push(`      if (( CURRENT == ${depth} )); then`);
    lines.push(`        _values 'subcommand' ${subs.join(" ")}`);
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("_ksefctl \"$@\"");
  return lines.join("\n");
};

const renderFishCompletion = (spec: {
  subcommandsByPath: Record<string, string[]>;
  optionsByPath: Record<string, OptionMeta[]>;
}): string => {
  const lines = [
    `complete -c ksefctl -f -n "__fish_use_subcommand" -a "${(spec.subcommandsByPath[""] ?? []).join(" ")}"`,
  ];
  for (const [path, subs] of Object.entries(spec.subcommandsByPath)) {
    if (path === "" || subs.length === 0) continue;
    const condition = path
      .split(" ")
      .map((word) => `__fish_seen_subcommand_from ${word}`)
      .join("; and ");
    lines.push(
      `complete -c ksefctl -f -n "${condition}" -a "${subs.join(" ")}"`,
    );
  }
  for (const [path, options] of Object.entries(spec.optionsByPath)) {
    const condition = path
      ? path
          .split(" ")
          .map((word) => `__fish_seen_subcommand_from ${word}`)
          .join("; and ")
      : "";
    for (const option of options) {
      const shortFlag = option.short ? `-s ${option.short.slice(1)}` : "";
      const longFlag = option.long ? `-l ${option.long.slice(2)}` : "";
      const description = option.description
        ? `-d \"${option.description.replace(/\"/g, "\\\\\"")}\"`
        : "";
      const valueArgs = isConfigOption(option)
        ? "-r -a \"(__fish_complete_path)\""
        : option.takesValue
          ? "-r"
          : "";
      const conditionFlag = condition ? `-n \"${condition}\"` : "";
      lines.push(
        `complete -c ksefctl -f ${conditionFlag} ${shortFlag} ${longFlag} ${valueArgs} ${description}`.trim(),
      );
    }
  }
  return lines.join("\n");
};

const ensureRegularFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to modify symlinked rc file");
    }
    if (!stat.isFile()) {
      throw new Error("Refusing to modify non-file rc path");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const ensureSafeCompletionDir = async (dirPath: string): Promise<void> => {
  const stat = await fs.stat(dirPath);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("Completion directory is not owned by current user");
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error("Completion directory is group/world-writable");
  }
};

const appendRcBlock = async (
  rcPath: string,
  lines: string[],
): Promise<void> => {
  const markerStart = "# ksefctl completion start";
  const markerEnd = "# ksefctl completion end";
  const block = [markerStart, ...lines, markerEnd].join("\n");
  const exists = await ensureRegularFile(rcPath);
  if (!exists) {
    const handle = await fs.open(
      rcPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(`${block}\n`, "utf-8");
    } finally {
      await handle.close();
    }
    return;
  }
  const handle = await fs.open(
    rcPath,
    fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refusing to modify non-file rc path");
    }
    const content = await handle.readFile("utf-8");
    if (content.includes(markerStart)) {
      return;
    }
    const trimmed = content.trimEnd();
    const prefix = trimmed.length === 0 ? "" : "\n\n";
    await handle.truncate(0);
    await handle.writeFile(`${trimmed}${prefix}${block}\n`, "utf-8");
  } finally {
    await handle.close();
  }
};

const shQuote = (value: string): string => {
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
};

const fileExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

const selectBashRcPath = async (homeDir: string): Promise<string> => {
  const bashrc = path.join(homeDir, ".bashrc");
  const bashProfile = path.join(homeDir, ".bash_profile");
  const profile = path.join(homeDir, ".profile");
  if (await fileExists(bashrc)) return bashrc;
  if (await fileExists(bashProfile)) return bashProfile;
  if (await fileExists(profile)) return profile;
  return bashrc;
};

const installCompletion = async (
  shell: ShellType,
  spec: ReturnType<typeof buildCompletionSpec>,
): Promise<{
  installed: boolean;
  message: string;
  activateCommand?: string;
}> => {
  if (process.getuid?.() === 0) {
    return { installed: false, message: "Skipping completion install as root" };
  }
  const homeDir = os.homedir();
  if (!path.isAbsolute(homeDir)) {
    throw new Error("Home directory is not absolute");
  }
  const completionDir = path.join(defaultDataRoot(), "completions");
  await ensureDir(completionDir);
  await ensureSafeCompletionDir(completionDir);

  if (shell === "fish") {
    const fishDir = path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"),
      "fish",
      "completions",
    );
    await ensureDir(fishDir);
    const fishPath = path.join(fishDir, "ksefctl.fish");
    await fs.writeFile(fishPath, `${renderFishCompletion(spec)}\n`, "utf-8");
    return {
      installed: true,
      message: `Installed completion to ${fishPath}`,
      activateCommand: `source ${shQuote(fishPath)}`,
    };
  }

  if (shell === "bash") {
    const completionPath = path.join(completionDir, "ksefctl.bash");
    await fs.writeFile(
      completionPath,
      `${renderBashCompletion(spec)}\n`,
      "utf-8",
    );
    const rcPath = await selectBashRcPath(homeDir);
    try {
      await appendRcBlock(rcPath, [`source ${shQuote(completionPath)}`]);
      return {
        installed: true,
        message: `Installed completion to ${rcPath}`,
        activateCommand: `source ${shQuote(rcPath)}`,
      };
    } catch (error) {
      return {
        installed: false,
        message: `Installed completion script but could not update ${rcPath}: ${(error as Error).message}`,
      };
    }
  }

  const completionPath = path.join(completionDir, "_ksefctl");
  await fs.writeFile(completionPath, `${renderZshCompletion(spec)}\n`, "utf-8");
  const rcPath = path.join(homeDir, ".zshrc");
  try {
    await appendRcBlock(rcPath, [
      `fpath=(${shQuote(completionDir)} $fpath)`,
      "autoload -Uz compinit && compinit",
    ]);
    return {
      installed: true,
      message: `Installed completion to ${rcPath}`,
      activateCommand: `source ${shQuote(rcPath)}`,
    };
  } catch (error) {
    return {
      installed: false,
      message: `Installed completion script but could not update ${rcPath}: ${(error as Error).message}`,
    };
  }
};

const detectShell = (): ShellType | null => {
  const shell = path.basename(process.env.SHELL ?? "");
  if (shell === "bash" || shell === "zsh" || shell === "fish") {
    return shell;
  }
  return null;
};

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

const firstRunMarkerPath = (): string =>
  path.join(defaultDataRoot(), "first-run.json");

const firstRunDisabled = (flag?: boolean): boolean => {
  if (flag === false) return true;
  const envValue = process.env.KSEFCTL_NO_FIRST_RUN;
  if (!envValue) return false;
  return ["1", "true", "yes"].includes(envValue.trim().toLowerCase());
};

const promptYesNo = async (question: string): Promise<boolean> => {
  const answer = await promptText(question);
  return /^y(es)?$/i.test(answer.trim());
};

const shouldRunFirstRun = async (flag?: boolean) => {
  if (firstRunDisabled(flag)) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const markerPath = firstRunMarkerPath();
  const markerExists = await fs
    .access(markerPath)
    .then(() => true)
    .catch(() => false);
  if (markerExists) return false;
  const rootExists = await fs
    .access(defaultDataRoot())
    .then(() => true)
    .catch(() => false);
  return !rootExists;
};

const writeFirstRunMarker = async (payload: Record<string, unknown>) => {
  const markerPath = firstRunMarkerPath();
  await ensureDir(path.dirname(markerPath));
  await fs.writeFile(markerPath, JSON.stringify(payload, null, 2), "utf-8");
};

const handleFirstRun = async (options: {
  configPath?: string;
  firstRunFlag?: boolean;
}): Promise<void> => {
  const shouldRun = await shouldRunFirstRun(options.firstRunFlag);
  if (!shouldRun) return;

  const shell = detectShell();
  let completionStatus = "skipped";
  let completionMessage: string | null = null;
  if (shell) {
    const enableCompletion = await promptYesNo(
      `Enable ${shell} shell completion? (y/N): `,
    );
    if (enableCompletion) {
      const spec = buildCompletionSpec(program);
      try {
        const result = await installCompletion(shell, spec);
        completionStatus = result.installed ? "installed" : "skipped";
        completionMessage = result.message;
        if (result.activateCommand) {
          completionMessage = `${completionMessage} (activate now: ${result.activateCommand})`;
        }
      } catch (error) {
        completionStatus = "failed";
        completionMessage = (error as Error).message;
      }
    } else {
      completionStatus = "declined";
    }
  } else {
    completionStatus = "unavailable";
  }

  const initNow = await promptYesNo("Bootstrap and initialize now? (y/N): ");
  if (initNow) {
    await bootstrapInteractive(options.configPath);
  }

  await writeFirstRunMarker({
    completedAt: new Date().toISOString(),
    completion: completionStatus,
    completionMessage,
    initialized: initNow,
    shell: shell ?? "unknown",
  });

  printHeader("First Run");
  const entries: [string, string | number | null][] = [
    ["completion", completionStatus],
    ["init", initNow ? "started" : "declined"],
  ];
  if (completionMessage) {
    entries.push(["completionInfo", completionMessage]);
  }
  printKeyValues(entries);
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
  .option("-c, --config <path>", "path to config file")
  .option("-v, --verbose", "enable verbose logging")
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
      console.error((error as Error).message);
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
      printHeader("Sync");
      printKeyValues([
        ["status", "starting"],
        ["environment", ctx.config.environment],
        ["nips", nips.join(", ")],
        ["logFile", ctx.config.logging.file],
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
          errorMessage = (error as Error).message;
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
          summaryEntries.push(["Error", sanitizeForTerminal(errorMessage)]);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
      process.exitCode = exitCodeFromError(error);
    }
  });

program
  .command("version")
  .description("Show current version")
  .action(async () => {
    try {
      const pkgPath = path.join(__dirname, "..", "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      console.log(parsed.version ?? "unknown");
    } catch (error) {
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
      console.error((error as Error).message);
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
    if (!hasHelp && !hasCommand) {
      const configPath = parseConfigOverride(args);
      const firstRunFlag = parseFirstRunFlag(args);
      await handleFirstRun({ configPath, firstRunFlag });
      await ensureLocalstorageNodeOption();
      program.outputHelp();
      return;
    }
    await ensureLocalstorageNodeOption();
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = exitCodeFromError(error);
  }
};

if (require.main === module) {
  void main();
}

export {
  buildCompletionSpec,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
  shouldRunFirstRun,
};
