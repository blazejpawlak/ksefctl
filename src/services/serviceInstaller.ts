import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
      message.includes("Unit")
    ) {
      return;
    }
    throw error;
  }
};

export type ServiceInstallOptions = {
  configPath: string;
  storageRoot: string;
  nodePath: string;
  cliPath: string;
};

const serviceName = APP_NAME;

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
    const homeDir = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(homeDir)) {
      throw new Error("HOME is not an absolute path");
    }
    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    await ensureDir(launchAgentsDir);
    await ensureDir(path.join(options.storageRoot, "logs"));
    const plistPath = path.join(launchAgentsDir, `com.${serviceName}.plist`);

    assertSafeUnitValue("nodePath", options.nodePath);
    assertSafeUnitValue("cliPath", options.cliPath);
    assertSafeUnitValue("configPath", options.configPath);
    assertSafeUnitValue("storageRoot", options.storageRoot);

    const localstoragePath = path.join(defaultDataRoot(), "localstorage.json");

    const isRoot = process.getuid?.() === 0;
    if (isRoot) {
      await validatePrivilegedInstallOptions(options);
    }
    const nodeOptionsValue = isRoot
      ? null
      : buildNodeOptionsWithLocalstorage(
          process.env.NODE_OPTIONS,
          localstoragePath,
        );
    const nodeOptionsEntry =
      nodeOptionsValue === null
        ? ""
        : `\n      <key>NODE_OPTIONS</key><string>${escapeXml(nodeOptionsValue)}</string>`;

    const nodePathValue = escapeXml(options.nodePath);
    const cliPathValue = escapeXml(options.cliPath);
    const configPathValue = escapeXml(options.configPath);
    const storageRootValue = escapeXml(options.storageRoot);
    const stdoutPath = escapeXml(
      path.join(options.storageRoot, "logs", `${serviceName}.out.log`),
    );
    const stderrPath = escapeXml(
      path.join(options.storageRoot, "logs", `${serviceName}.err.log`),
    );

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.${serviceName}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePathValue}</string>
      <string>${cliPathValue}</string>
      <string>daemon</string>
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
      <key>NODE_ENV</key><string>production</string>${nodeOptionsEntry}
    </dict>
  </dict>
</plist>
`;

    await fs.writeFile(plistPath, plist, "utf-8");
    const uid = process.getuid?.() ?? 0;
    await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    await execFileAsync("launchctl", [
      "enable",
      `gui/${uid}/com.${serviceName}`,
    ]);
    return plistPath;
  }

  private async uninstallLaunchd(): Promise<string> {
    const homeDir = process.env.HOME ?? os.homedir();
    if (!path.isAbsolute(homeDir)) {
      throw new Error("HOME is not an absolute path");
    }
    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    const plistPath = path.join(launchAgentsDir, `com.${serviceName}.plist`);
    const uid = process.getuid?.() ?? 0;
    await execFileSafe("launchctl", ["bootout", `gui/${uid}`, plistPath]);
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
    const nodeOptionsLine =
      nodeOptionsValue === null
        ? ""
        : `Environment="NODE_OPTIONS=${escapeSystemdEnvValue(nodeOptionsValue)}"\n`;

    const target = isRoot ? "multi-user.target" : "default.target";
    assertSafeUnitValue("nodePath", options.nodePath);
    assertSafeUnitValue("cliPath", options.cliPath);
    assertSafeUnitValue("configPath", options.configPath);
    assertSafeUnitValue("storageRoot", options.storageRoot);
    const nodePathValue = escapeSystemdUnitValue(options.nodePath);
    const cliPathValue = escapeSystemdUnitValue(options.cliPath);
    const configPathValue = escapeSystemdUnitValue(options.configPath);
    const storageRootValue = escapeSystemdUnitValue(options.storageRoot);
    const unit = `[Unit]
Description=KSeFctl Service
After=network.target

[Service]
Type=simple
ExecStart="${nodePathValue}" "${cliPathValue}" daemon --config "${configPathValue}"
WorkingDirectory="${storageRootValue}"
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
${nodeOptionsLine}NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=${target}
`;

    await fs.writeFile(unitPath, unit, "utf-8");

    if (isRoot) {
      await execFileAsync("systemctl", ["daemon-reload"]);
      await execFileAsync("systemctl", [
        "enable",
        "--now",
        `${serviceName}.service`,
      ]);
    } else {
      await execFileAsync("systemctl", ["--user", "daemon-reload"]);
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
