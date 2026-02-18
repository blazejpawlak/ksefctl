import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export const APP_NAME = "ksefctl";

export type Platform = "darwin" | "linux";

export const isSupportedPlatform = (platform: string): platform is Platform =>
  platform === "darwin" || platform === "linux";

export const expandHome = (inputPath: string): string => {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
};

export const defaultConfigPath = (): string => {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), `.${APP_NAME}`, "config.yaml");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, APP_NAME, "config.yaml");
};

export const defaultDataRoot = (): string => {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), `.${APP_NAME}`);
  }
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, APP_NAME);
};

export const defaultLogPath = (root: string): string => {
  return path.join(root, "logs", "ksefctl.log");
};

export const ensureDir = async (
  dirPath: string,
  mode = 0o700,
): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true, mode });
};
