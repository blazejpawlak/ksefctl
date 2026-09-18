import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KSEFCTL_SERVICE_MODE } from "../cli/serviceMode";
import { buildNodeOptionsWithLocalstorage } from "../utils/nodeOptions";
import { APP_NAME, defaultDataRoot, ensureDir } from "../utils/paths";

const execFileAsync = promisify(execFile);

const execFileSafe = async (command: string, args: string[]): Promise<void> => {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    const message = (error as Error).message;
    if (
      message.includes("No such file or directory") ||
      message.includes("No such process") ||
      message.includes("not loaded") ||
      message.includes("not-found") ||
      message.includes("Unit") ||
      message.includes("Boot-out failed")
    ) {
      return;
    }
    throw error;
  }
};

export type ServiceInstallOptions = {
  configPath: string;
  storageRoot: string;
  lifecycleLogPath: string;
  nodePath: string;
  cliPath: string;
};

export type LaunchdTarget = {
  launchdDir: string;
  plistPath: string;
  domain: string;
};

const serviceName = APP_NAME;

const resolveServiceOutputPath = (
  storageRoot: string,
  streamName: "stdout" | "err",
): string => path.join(storageRoot, "logs", `${serviceName}.${streamName}.log`);

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const escapeSystemdEnvValue = (value: string): string => {
  const escapedQuotes = String.raw`\"`;
  return value
    .replace(/[\r\n\0]/g, " ")
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, escapedQuotes);
};

const escapeSystemdUnitValue = (value: string): string =>
  escapeSystemdEnvValue(value);

const assertSafeUnitValue = (label: string, value: string): void => {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid ${label} value`);
  }
};

const assertSafePrivilegedPath = async (
  label: string,
  filePath: string,
): Promise<void> => {
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `${label} must be an absolute path for root service installation`,
    );
  }
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${label} must not be a symlink for root service installation`,
    );
  }
  if (stats.uid !== 0) {
    throw new Error(
      `${label} must be owned by root for root service installation`,
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `${label} must not be group or world writable for root service installation`,
    );
  }
};

const validatePrivilegedInstallOptions = async (
  options: ServiceInstallOptions,
): Promise<void> => {
  await assertSafePrivilegedPath("nodePath", options.nodePath);
  await assertSafePrivilegedPath("cliPath", options.cliPath);
  await assertSafePrivilegedPath("configPath", options.configPath);
  await assertSafePrivilegedPath("storageRoot", options.storageRoot);
};

export const resolveLaunchdTarget = (
  homeDir: string,
  uid: number,
  isRoot: boolean,
): LaunchdTarget => {
  if (isRoot) {
    const launchdDir = "/Library/LaunchDaemons";
    return {
      launchdDir,
      plistPath: path.join(launchdDir, `com.${serviceName}.plist`),
      domain: "system",
    };
  }
  if (!path.isAbsolute(homeDir)) {
    throw new Error("HOME is not an absolute path");
  }
  const launchdDir = path.join(homeDir, "Library", "LaunchAgents");
  return {
    launchdDir,
    plistPath: path.join(launchdDir, `com.${serviceName}.plist`),
    domain: `gui/${uid}`,
  };
};

export const buildLaunchdPlist = (
  options: ServiceInstallOptions,
  nodeOptionsValue: string | null,
): string => {
  const nodeOptionsEntry =
    nodeOptionsValue === null
      ? ""
      : `\n      <key>NODE_OPTIONS</key><string>${escapeXml(nodeOptionsValue)}</string>`;

  const nodePathValue = escapeXml(options.nodePath);
  const cliPathValue = escapeXml(options.cliPath);
  const configPathValue = escapeXml(options.configPath);
  const storageRootValue = escapeXml(options.storageRoot);
  // launchd has no size or age cap for StandardOutPath / StandardErrorPath.
  // Those files grow unbounded for as long as the job stays loaded; ksefctl
  // log rotation (src/utils/logger.ts) only covers logging.file. Cap these
  // service stdio files with newsyslog(8) (or an equivalent rotator) at:
  //   <storageRoot>/logs/ksefctl.stdout.log
  //   <storageRoot>/logs/ksefctl.err.log
  const stdoutPath = escapeXml(
    resolveServiceOutputPath(options.storageRoot, "stdout"),
  );
  const stderrPath = escapeXml(
    resolveServiceOutputPath(options.storageRoot, "err"),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.${serviceName}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePathValue}</string>
      <string>${cliPathValue}</string>
      <string>sync</string>
      <string>--watch</string>
      <string>--config</string>
      <string>${configPathValue}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>WorkingDirectory</key><string>${storageRootValue}</string>
    <key>StandardOutPath</key><string>${stdoutPath}</string>
    <key>StandardErrorPath</key><string>${stderrPath}</string>
    <key>Umask</key><integer>63</integer>
    <key>EnvironmentVariables</key>
    <dict>
      <key>${KSEFCTL_SERVICE_MODE}</key><string>1</string>
      <key>NODE_ENV</key><string>production</string>${nodeOptionsEntry}
    </dict>
  </dict>
</plist>
`;
};

const ensureRegularFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to modify symlinked service file");
    }
    if (!stat.isFile()) {
      throw new Error("Refusing to modify non-file service path");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
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
      throw new Error("Refusing to modify non-file service path");
    }
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
};

export const buildSystemdUnit = (
  options: ServiceInstallOptions,
  nodeOptionsValue: string | null,
  isRoot: boolean,
): string => {
  const nodeOptionsLine =
    nodeOptionsValue === null
      ? ""
      : `Environment="NODE_OPTIONS=${escapeSystemdEnvValue(nodeOptionsValue)}"\n`;
  const target = isRoot ? "multi-user.target" : "default.target";
  const nodePathValue = escapeSystemdUnitValue(options.nodePath);
  const cliPathValue = escapeSystemdUnitValue(options.cliPath);
  const configPathValue = escapeSystemdUnitValue(options.configPath);
  const storageRootValue = escapeSystemdUnitValue(options.storageRoot);

  // File-backed StandardOutput=append cannot be rotated by ksefctl.
  // journald applies its own size/age retention (SystemMaxUse / MaxFileSec).
  return `[Unit]
Description=KSeFctl Service
After=network.target

[Service]
Type=simple
ExecStart="${nodePathValue}" "${cliPathValue}" sync --watch --config "${configPathValue}"
WorkingDirectory="${storageRootValue}"
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${serviceName}
Restart=on-failure
RestartSec=5
Environment=${KSEFCTL_SERVICE_MODE}=1
Environment=NODE_ENV=production
${nodeOptionsLine}NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=${target}
`;
};

export class ServiceInstaller {
  async install(options: ServiceInstallOptions): Promise<string> {
    if (process.platform === "darwin") {
      return this.installLaunchd(options);
    }
    return this.installSystemd(options);
  }

  async uninstall(): Promise<string> {
    if (process.platform === "darwin") {
      return this.uninstallLaunchd();
    }
    return this.uninstallSystemd();
  }

  private async installLaunchd(
    options: ServiceInstallOptions,
  ): Promise<string> {
    const uid = process.getuid?.() ?? 0;
    const isRoot = uid === 0;
    const homeDir = process.env.HOME ?? os.homedir();
    if (isRoot) {
      await validatePrivilegedInstallOptions(options);
    }
    const { launchdDir, plistPath, domain } = resolveLaunchdTarget(
      homeDir,
      uid,
      isRoot,
    );
    if (isRoot) {
      await assertSafePrivilegedPath("launchdDir", launchdDir);
    } else {
      await ensureDir(launchdDir);
    }
    await ensureDir(path.join(options.storageRoot, "logs"));

    assertSafeUnitValue("nodePath", options.nodePath);
    assertSafeUnitValue("cliPath", options.cliPath);
    assertSafeUnitValue("configPath", options.configPath);
    assertSafeUnitValue("storageRoot", options.storageRoot);

    const localstoragePath = path.join(defaultDataRoot(), "localstorage.json");
    const nodeOptionsValue = isRoot
      ? null
      : buildNodeOptionsWithLocalstorage(
          process.env.NODE_OPTIONS,
          localstoragePath,
        );
    const plist = buildLaunchdPlist(options, nodeOptionsValue);

    await writeRegularFile(plistPath, plist);
    // Bootout any existing registration before re-bootstrapping (idempotent install).
    await execFileSafe("launchctl", ["bootout", domain, plistPath]);
    await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
    await execFileAsync("launchctl", [
      "enable",
      `${domain}/com.${serviceName}`,
    ]);
    return plistPath;
  }

  private async uninstallLaunchd(): Promise<string> {
    const uid = process.getuid?.() ?? 0;
    const isRoot = uid === 0;
    const homeDir = process.env.HOME ?? os.homedir();
    const { plistPath, domain } = resolveLaunchdTarget(homeDir, uid, isRoot);
    await execFileSafe("launchctl", ["bootout", domain, plistPath]);
    await fs.rm(plistPath, { force: true });
    return plistPath;
  }

  private async installSystemd(
    options: ServiceInstallOptions,
  ): Promise<string> {
    const isRoot = process.getuid?.() === 0;
    if (isRoot) {
      await validatePrivilegedInstallOptions(options);
    }
    const homeDir = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(homeDir)) {
      throw new Error("HOME is not an absolute path");
    }
    const unitDir = isRoot
      ? "/etc/systemd/system"
      : path.join(homeDir, ".config", "systemd", "user");

    await ensureDir(unitDir);
    const unitPath = path.join(unitDir, `${serviceName}.service`);

    const localstoragePath = path.join(defaultDataRoot(), "localstorage.json");
    const nodeOptionsValue = isRoot
      ? null
      : buildNodeOptionsWithLocalstorage(
          process.env.NODE_OPTIONS,
          localstoragePath,
        );
    assertSafeUnitValue("nodePath", options.nodePath);
    assertSafeUnitValue("cliPath", options.cliPath);
    assertSafeUnitValue("configPath", options.configPath);
    assertSafeUnitValue("storageRoot", options.storageRoot);
    const unit = buildSystemdUnit(options, nodeOptionsValue, isRoot);

    await writeRegularFile(unitPath, unit);

    if (isRoot) {
      await execFileAsync("systemctl", ["daemon-reload"]);
      // Stop any running instance before re-enabling (idempotent install).
      await execFileSafe("systemctl", [
        "disable",
        "--now",
        `${serviceName}.service`,
      ]);
      await execFileAsync("systemctl", [
        "enable",
        "--now",
        `${serviceName}.service`,
      ]);
    } else {
      await execFileAsync("systemctl", ["--user", "daemon-reload"]);
      // Stop any running instance before re-enabling (idempotent install).
      await execFileSafe("systemctl", [
        "--user",
        "disable",
        "--now",
        `${serviceName}.service`,
      ]);
      await execFileAsync("systemctl", [
        "--user",
        "enable",
        "--now",
        `${serviceName}.service`,
      ]);
    }

    return unitPath;
  }

  private async uninstallSystemd(): Promise<string> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(homeDir)) {
      throw new Error("HOME is not an absolute path");
    }
    const unitDir = isRoot
      ? "/etc/systemd/system"
      : path.join(homeDir, ".config", "systemd", "user");
    const unitPath = path.join(unitDir, `${serviceName}.service`);

    if (isRoot) {
      await execFileSafe("systemctl", [
        "disable",
        "--now",
        `${serviceName}.service`,
      ]);
      await execFileSafe("systemctl", ["daemon-reload"]);
    } else {
      await execFileSafe("systemctl", [
        "--user",
        "disable",
        "--now",
        `${serviceName}.service`,
      ]);
      await execFileSafe("systemctl", ["--user", "daemon-reload"]);
    }

    await fs.rm(unitPath, { force: true });
    return unitPath;
  }
}
