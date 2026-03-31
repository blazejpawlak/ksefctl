import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultDataRoot, ensureDir } from "../utils/paths";
import { bootstrapInteractive } from "./bootstrap";
import {
  buildCompletionSpec,
  detectShell,
  installCompletion,
  type ShellType,
} from "./completion";
import { promptText } from "./prompt";
import { printHeader, printKeyValues } from "./ui";

export const firstRunMarkerPath = (): string =>
  path.join(defaultDataRoot(), "first-run.json");

export const firstRunDisabled = (flag?: boolean): boolean => {
  if (flag === false) return true;
  const envValue = process.env.KSEFCTL_NO_FIRST_RUN;
  if (!envValue) return false;
  return ["1", "true", "yes"].includes(envValue.trim().toLowerCase());
};

const promptYesNo = async (question: string): Promise<boolean> => {
  const answer = await promptText(question);
  return /^y(es)?$/i.test(answer.trim());
};

export const shouldRunFirstRun = async (flag?: boolean): Promise<boolean> => {
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

const writeFirstRunMarker = async (
  payload: Record<string, unknown>,
): Promise<void> => {
  const markerPath = firstRunMarkerPath();
  await ensureDir(path.dirname(markerPath));
  await fs.writeFile(markerPath, JSON.stringify(payload, null, 2), "utf-8");
};

export const handleFirstRun = async (
  program: Command,
  options: {
    configPath?: string;
    firstRunFlag?: boolean;
  },
): Promise<void> => {
  const shouldRun = await shouldRunFirstRun(options.firstRunFlag);
  if (!shouldRun) return;

  const shell: ShellType | null = detectShell();
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
