import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildNodeOptionsWithLocalstorage } from "../utils/nodeOptions";
import { defaultDataRoot, ensureDir } from "../utils/paths";

// Module-level result caches — persist across calls within a process lifetime
let packageVersionPromise: Promise<string> | null = null;
let versionOutputPromise: Promise<string> | null = null;

export const resolveLocalstoragePath = (): string =>
  path.join(defaultDataRoot(), "localstorage.json");

const execFileAsync = promisify(execFile);

export const formatVersionOutput = (version: string, commit: string): string =>
  `${version} (${commit})`;

export const readPackageVersion = async (): Promise<string> => {
  packageVersionPromise ??= fs
    .readFile(path.join(__dirname, "..", "package.json"), "utf-8")
    .then((raw) => {
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? "unknown";
    });

  return packageVersionPromise;
};

export const readShortCommit = async (): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--short", "HEAD"],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
      },
    );
    const commit = stdout.trim();
    return commit.length > 0 ? commit : "unknown";
  } catch {
    return "unknown";
  }
};

export const readVersionOutput = async (): Promise<string> => {
  versionOutputPromise ??= Promise.all([
    readPackageVersion(),
    readShortCommit(),
  ]).then(([version, commit]) => formatVersionOutput(version, commit));

  return versionOutputPromise;
};

export const printVersion = async (): Promise<void> => {
  console.log(await readVersionOutput());
};

export const ensureLocalstorageNodeOption = async (): Promise<void> => {
  const localstoragePath = resolveLocalstoragePath();
  await ensureDir(path.dirname(localstoragePath));
  process.env.NODE_OPTIONS = buildNodeOptionsWithLocalstorage(
    process.env.NODE_OPTIONS,
    localstoragePath,
  );
};
