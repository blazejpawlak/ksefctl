import type { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { StatusService } from "../../core/statusService";
import { ServiceInstaller } from "../../services/serviceInstaller";
import { APP_NAME } from "../../utils/paths";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { printHeader, printKeyValues } from "../ui";
import { runCommand, type RootOptions } from "./runCommand";

const execFileAsync = promisify(execFile);
const serviceLabel = `com.${APP_NAME}`;
const unitName = `${APP_NAME}.service`;

const parseLaunchdProp = (output: string, key: string): string | null => {
  const m = new RegExp(`"${key}"\\s*=\\s*(\\S+?);`).exec(output);
  if (!m) return null;
  return (m[1] ?? "").replace(/^"|"$/g, "") || null;
};

const parseSystemdProp = (output: string, key: string): string | null => {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(output);
  return m ? (m[1] ?? null) : null;
};

type OsServiceState = {
  running: boolean;
  pid: string | null;
  state: string;
  exitCode: string | null;
};

async function queryOsServiceState(): Promise<OsServiceState> {
  const uid = process.getuid?.() ?? 0;
  const isRoot = uid === 0;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("launchctl", ["list", serviceLabel]);
      const pid = parseLaunchdProp(stdout, "PID");
      const lastExitStatus = parseLaunchdProp(stdout, "LastExitStatus");
      return {
        running: pid !== null,
        pid,
        state: pid !== null ? "running" : "stopped",
        exitCode: lastExitStatus !== null && lastExitStatus !== "0" ? lastExitStatus : null,
      };
    } catch {
      return { running: false, pid: null, state: "not installed", exitCode: null };
    }
  } else {
    const args = isRoot
      ? ["show", unitName, "--property=ActiveState,SubState,MainPID,ExecMainStatus", "--no-pager"]
      : ["--user", "show", unitName, "--property=ActiveState,SubState,MainPID,ExecMainStatus", "--no-pager"];
    try {
      const { stdout } = await execFileAsync("systemctl", args);
      const activeState = parseSystemdProp(stdout, "ActiveState") ?? "unknown";
      const subState = parseSystemdProp(stdout, "SubState") ?? "unknown";
      const mainPid = parseSystemdProp(stdout, "MainPID");
      const execMainStatus = parseSystemdProp(stdout, "ExecMainStatus");
      return {
        running: activeState === "active" && subState === "running",
        pid: mainPid && mainPid !== "0" ? mainPid : null,
        state: `${activeState}/${subState}`,
        exitCode: execMainStatus && execMainStatus !== "0" ? execMainStatus : null,
      };
    } catch {
      return { running: false, pid: null, state: "not installed", exitCode: null };
    }
  }
}

async function restartOsService(): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const isRoot = uid === 0;
  if (process.platform === "darwin") {
    const domain = isRoot ? "system" : `gui/${uid}`;
    await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${serviceLabel}`]);
  } else {
    if (isRoot) {
      await execFileAsync("systemctl", ["restart", unitName]);
    } else {
      await execFileAsync("systemctl", ["--user", "restart", unitName]);
    }
  }
}

type LogsOptions = { follow?: boolean; lines?: string; error?: boolean };

export function registerSystemService(
  system: Command,
  program: Command,
): void {
  const systemService = system
    .command("service")
    .description("Service management commands");

  systemService
    .command("install")
    .description("Install and enable launchd/systemd service")
    .action(
      runCommand(async () => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
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
      }),
    );

  systemService
    .command("uninstall")
    .description("Remove launchd/systemd service")
    .action(
      runCommand(async () => {
        const { config } = program.opts<RootOptions>();
        await ensureInitialized(config);
        const installer = new ServiceInstaller();
        const pathRemoved = await installer.uninstall();
        printHeader("System Service Uninstall");
        printKeyValues([["servicePath", pathRemoved]]);
      }),
    );

  systemService
    .command("status")
    .description("Show service state and last sync info")
    .action(
      runCommand(async () => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const osState = await queryOsServiceState();
        const statusService = new StatusService(ctx.store);
        const syncStatus = await statusService.getStatus();
        printHeader("System Service Status");
        const entries: [string, string | number | null][] = [
          ["state", osState.state],
          ["pid", osState.pid ?? "-"],
        ];
        if (osState.exitCode !== null) {
          entries.push(["lastExitCode", osState.exitCode]);
        }
        entries.push(
          ["lastSyncAt", syncStatus.lastSyncAt ?? "-"],
          ["lastSuccessAt", syncStatus.lastSuccessAt ?? "-"],
          ["lastDownloaded", syncStatus.lastDownloadedCount ?? 0],
        );
        if (syncStatus.lastError) {
          entries.push(["lastError", syncStatus.lastError]);
        }
        printKeyValues(entries);
      }),
    );

  systemService
    .command("restart")
    .description("Restart the background service")
    .action(
      runCommand(async () => {
        await restartOsService();
        printHeader("System Service Restart");
        printKeyValues([["status", "restarted"]]);
      }),
    );

  systemService
    .command("logs")
    .description("Show service log output")
    .option("-f, --follow", "follow log output")
    .option("-n, --lines <n>", "number of lines to show", "50")
    .option("--error", "show stderr log instead of stdout")
    .action(
      runCommand(async (opts: LogsOptions) => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const logFile = opts.error ? `${APP_NAME}.err.log` : `${APP_NAME}.out.log`;
        const logPath = path.join(ctx.config.storage.root, "logs", logFile);
        const tailArgs = ["-n", opts.lines ?? "50"];
        if (opts.follow) tailArgs.push("-f");
        tailArgs.push(logPath);
        await new Promise<void>((resolve, reject) => {
          const child = spawn("tail", tailArgs, { stdio: "inherit" });
          child.on("close", (code) => {
            if (code !== null && code !== 0) reject(new Error(`tail exited with code ${code}`));
            else resolve();
          });
          child.on("error", reject);
        });
      }),
    );
}
