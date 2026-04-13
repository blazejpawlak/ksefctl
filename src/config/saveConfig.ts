import lockfile from "proper-lockfile";
import YAML from "yaml";
import fs from "node:fs/promises";
import { atomicWriteFile } from "../utils/paths";
import { resolveConfigPath } from "./loadConfig";

export const updateConfigFile = async (
  configPath: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> => {
  const resolved = resolveConfigPath(configPath);
  // Ensure file exists so lockfile can create the .lock sibling
  await fs.open(resolved, "a").then((handle) => handle.close());
  const release = await lockfile.lock(resolved, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500, randomize: true },
    realpath: false,
  });
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const updated = updater(parsed);
    const yaml = YAML.stringify(updated);
    await atomicWriteFile(resolved, yaml);
  } finally {
    await release();
  }
};
