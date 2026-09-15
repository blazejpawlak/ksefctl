import type { Command } from "commander";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultDataRoot, ensureDir } from "../utils/paths";

export type OptionMeta = {
  short?: string;
  long?: string;
  description?: string;
  takesValue: boolean;
  valueName?: string;
};

export type ShellType = "bash" | "zsh" | "fish";

export type CompletionSpec = {
  subcommandsByPath: Record<string, string[]>;
  optionsByPath: Record<string, OptionMeta[]>;
};

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

export const buildCompletionSpec = (root: Command): CompletionSpec => {
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
    currentPath: string,
    inheritedOptions: OptionMeta[],
  ) => {
    const currentOptions = [...inheritedOptions, ...collectOptions(command)];
    optionsByPath[currentPath] = currentOptions;
    const children = command.commands.filter(
      (child) => child.name() !== "help",
    );
    subcommandsByPath[currentPath] = children
      .map((child) => child.name())
      .sort();
    for (const child of children) {
      const childPath = currentPath
        ? `${currentPath} ${child.name()}`
        : child.name();
      visit(child, childPath, currentOptions);
    }
  };

  visit(root, "", []);
  subcommandsByPath["system completion"] = ["bash", "zsh", "fish"];
  return { subcommandsByPath, optionsByPath };
};

export const renderBashCompletion = (spec: CompletionSpec): string => {
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
    `        case "$word" in ${topLevel.replace(/ /g, "|")}) cmdpath="$word";; *) break;; esac`,
    "        ;;",
  ];
  const paths = Object.keys(spec.subcommandsByPath)
    .filter((currentPath) => currentPath.length > 0)
    .sort((left, right) => left.split(" ").length - right.split(" ").length);
  for (const currentPath of paths) {
    const subcommands = spec.subcommandsByPath[currentPath];
    if (!subcommands || subcommands.length === 0) continue;
    lines.push(`      "${currentPath}")`);
    lines.push(
      `        case "$word" in ${subcommands.join("|")}) cmdpath="${currentPath} $word";; *) break;; esac`,
    );
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("  done");
  lines.push("  if [[ \"$cur\" == -* ]]; then");
  lines.push("    case \"$cmdpath\" in");
  for (const [currentPath, options] of Object.entries(spec.optionsByPath)) {
    const names = optionNames(options).join(" ");
    lines.push(`      "${currentPath}")`);
    lines.push(`        COMPREPLY=( $(compgen -W "${names}" -- "$cur") )`);
    lines.push("        return 0");
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    COMPREPLY=()");
  lines.push("    return 0");
  lines.push("  fi");
  lines.push("  if [ $COMP_CWORD -eq 1 ]; then");
  lines.push(`    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )`);
  lines.push("    return 0");
  lines.push("  fi");
  lines.push("  case \"$cmdpath\" in");
  for (const [currentPath, subcommands] of Object.entries(
    spec.subcommandsByPath,
  )) {
    if (currentPath === "" || subcommands.length === 0) continue;
    const depth = currentPath.split(" ").length + 1;
    lines.push(`    "${currentPath}")`);
    lines.push(`      if [ $COMP_CWORD -eq ${depth} ]; then`);
    lines.push(
      `        COMPREPLY=( $(compgen -W "${subcommands.join(" ")}" -- "$cur") )`,
    );
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("complete -F _ksefctl_complete ksefctl");
  return lines.join("\n");
};

export const renderZshCompletion = (spec: CompletionSpec): string => {
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
  ];
  lines.push("  local cur=\"${words[CURRENT]}\"");
  lines.push("  local prev=\"${words[CURRENT-1]}\"");
  lines.push("  if [[ \"$prev\" == \"--config\" || \"$prev\" == \"-c\" ]]; then");
  lines.push("    _files");
  lines.push("    return");
  lines.push("  fi");
  lines.push("  local cmdpath=\"\"");
  lines.push("  local word");
  lines.push("  local i=2");
  lines.push("  while (( i < CURRENT )); do");
  lines.push("    word=\"${words[i]}\"");
  lines.push("    if [[ \"$word\" == -- ]]; then break; fi");
  lines.push("    if [[ \"$word\" == -* ]]; then");
  lines.push(
    "      if (( i < CURRENT - 1 )) && [[ \"${words[i+1]}\" != -* ]]; then",
  );
  lines.push("        (( i++ ))");
  lines.push("      fi");
  lines.push("      (( i++ ))");
  lines.push("      continue");
  lines.push("    fi");
  lines.push("    case \"$cmdpath\" in");
  lines.push("      \"\")");
  lines.push(
    `        case "$word" in ${(spec.subcommandsByPath[""] ?? []).join("|")}) cmdpath="$word";; *) break;; esac`,
  );
  lines.push("        ;;");
  const paths = Object.keys(spec.subcommandsByPath)
    .filter((currentPath) => currentPath.length > 0)
    .sort((left, right) => left.split(" ").length - right.split(" ").length);
  for (const currentPath of paths) {
    const subcommands = spec.subcommandsByPath[currentPath];
    if (!subcommands || subcommands.length === 0) continue;
    lines.push(`      "${currentPath}")`);
    lines.push(
      `        case "$word" in ${subcommands.join("|")}) cmdpath="${currentPath} $word";; *) break;; esac`,
    );
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    (( i++ ))");
  lines.push("  done");
  lines.push("  if [[ \"$cur\" == -* ]]; then");
  lines.push("    case \"$cmdpath\" in");
  for (const [currentPath, options] of Object.entries(spec.optionsByPath)) {
    const names = optionNames(options).join(" ");
    lines.push(`      "${currentPath}")`);
    lines.push(`        _values 'option' ${names}`);
    lines.push("        return");
    lines.push("        ;;");
  }
  lines.push("    esac");
  lines.push("    return");
  lines.push("  fi");
  lines.push("  case \"$cmdpath\" in");
  for (const [currentPath, subcommands] of Object.entries(
    spec.subcommandsByPath,
  )) {
    if (currentPath === "" || subcommands.length === 0) continue;
    const depth = currentPath.split(" ").length + 2;
    lines.push(`    "${currentPath}")`);
    lines.push(`      if (( CURRENT == ${depth} )); then`);
    lines.push(`        _values 'subcommand' ${subcommands.join(" ")}`);
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("_ksefctl \"$@\"");
  return lines.join("\n");
};

/**
 * Escape a value for a fish `complete -d "..."` double-quoted string.
 * Fish expands `$` and `(...)` inside double quotes, so those are escaped
 * after backslashes; control characters are flattened to keep one directive per line.
 */
export const escapeFishDescription = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\$/g, "\\$")
    .replace(/\(/g, "\\(");

export const renderFishCompletion = (spec: CompletionSpec): string => {
  const lines = [
    `complete -c ksefctl -f -n "__fish_use_subcommand" -a "${(spec.subcommandsByPath[""] ?? []).join(" ")}"`,
  ];
  for (const [currentPath, subcommands] of Object.entries(
    spec.subcommandsByPath,
  )) {
    if (currentPath === "" || subcommands.length === 0) continue;
    const condition = currentPath
      .split(" ")
      .map((word) => `__fish_seen_subcommand_from ${word}`)
      .join("; and ");
    lines.push(
      `complete -c ksefctl -f -n "${condition}" -a "${subcommands.join(" ")}"`,
    );
  }
  for (const [currentPath, options] of Object.entries(spec.optionsByPath)) {
    const condition = currentPath
      ? currentPath
          .split(" ")
          .map((word) => `__fish_seen_subcommand_from ${word}`)
          .join("; and ")
      : "";
    for (const option of options) {
      const shortFlag = option.short ? `-s ${option.short.slice(1)}` : "";
      const longFlag = option.long ? `-l ${option.long.slice(2)}` : "";
      const description = option.description
        ? `-d "${escapeFishDescription(option.description)}"`
        : "";
      const valueArgs = isConfigOption(option)
        ? "-r -a \"(__fish_complete_path)\""
        : option.takesValue
          ? "-r"
          : "";
      const conditionFlag = condition ? `-n "${condition}"` : "";
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
  const stat = await fs.lstat(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error("Completion directory must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("Completion path is not a directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("Completion directory is not owned by current user");
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error("Completion directory is group/world-writable");
  }
};

const writeRegularFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const exists = await ensureRegularFile(filePath);
  const flags = exists
    ? fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refusing to modify non-file completion path");
    }
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
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

export const installCompletion = async (
  shell: ShellType,
  spec: CompletionSpec,
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
    await ensureSafeCompletionDir(fishDir);
    const fishPath = path.join(fishDir, "ksefctl.fish");
    await writeRegularFile(fishPath, `${renderFishCompletion(spec)}\n`);
    return {
      installed: true,
      message: `Installed completion to ${fishPath}`,
      activateCommand: `source ${shQuote(fishPath)}`,
    };
  }

  if (shell === "bash") {
    const completionPath = path.join(completionDir, "ksefctl.bash");
    await writeRegularFile(completionPath, `${renderBashCompletion(spec)}\n`);
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
  await writeRegularFile(completionPath, `${renderZshCompletion(spec)}\n`);
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

export const detectShell = (): ShellType | null => {
  const shell = path.basename(process.env.SHELL ?? "");
  if (shell === "bash" || shell === "zsh" || shell === "fish") {
    return shell;
  }
  return null;
};
