import YAML from "yaml";
import fs from "node:fs/promises";
import { resolveConfigPath } from "./loadConfig";

export const updateConfigFile = async (
  configPath: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> => {
  const resolved = resolveConfigPath(configPath);
  const raw = await fs.readFile(resolved, "utf-8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  const updated = updater(parsed);
  const yaml = YAML.stringify(updated);
  await fs.writeFile(resolved, yaml, { encoding: "utf-8", mode: 0o600 });
};
