import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, APP_NAME, "config.yaml");
};

export const defaultDataRoot = (): string => {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), `.${APP_NAME}`);
  }
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
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

export const atomicWriteFile = async (
  filePath: string,
  data: string | Buffer,
): Promise<void> => {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  // Unique temp name per PID + UUID: prevents stale-.tmp failures from prior
  // crashes and closes the predictable-filename DoS foothold on shared dirs.
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, data, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
};
