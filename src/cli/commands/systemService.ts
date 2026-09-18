import type { Command } from "commander";
import type { Writable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StatusService } from "../../core/statusService";
import { ServiceInstaller } from "../../services/serviceInstaller";
import { createPrettyLogStream } from "../../utils/logger";
import { APP_NAME } from "../../utils/paths";
import { logServiceLifecycle } from "../../utils/serviceLifecycle";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import {
  getLifecycleEventEntries,
  getLifecycleStatusEntries,
} from "../lifecycleStatus";
import { resolveServiceLogPaths } from "../serviceLogPaths";
import { printHeader, printKeyValues } from "../ui";
import { runCommand, type RootOptions } from "./runCommand";

const execFileAsync = promisify(execFile);
const serviceLabel = `com.${APP_NAME}`;
const unitName = `${APP_NAME}.service`;
const serviceManager = process.platform === "darwin" ? "launchd" : "systemd";

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
      const { stdout } = await execFileAsync("launchctl", [
        "list",
        serviceLabel,
      ]);
      const pid = parseLaunchdProp(stdout, "PID");
      const lastExitStatus = parseLaunchdProp(stdout, "LastExitStatus");
      return {
        running: pid !== null,
        pid,
        state: pid !== null ? "running" : "stopped",
        exitCode:
          lastExitStatus !== null && lastExitStatus !== "0"
            ? lastExitStatus
            : null,
      };
    } catch {
      return {
        running: false,
        pid: null,
        state: "not installed",
        exitCode: null,
      };
    }
  } else {
    const args = isRoot
      ? [
          "show",
          unitName,
          "--property=ActiveState,SubState,MainPID,ExecMainStatus",
          "--no-pager",
        ]
      : [
          "--user",
          "show",
          unitName,
          "--property=ActiveState,SubState,MainPID,ExecMainStatus",
          "--no-pager",
        ];
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
        exitCode:
          execMainStatus && execMainStatus !== "0" ? execMainStatus : null,
      };
    } catch {
      return {
        running: false,
        pid: null,
        state: "not installed",
        exitCode: null,
      };
    }
  }
}

async function restartOsService(): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const isRoot = uid === 0;
  if (process.platform === "darwin") {
    const domain = isRoot ? "system" : `gui/${uid}`;
    await execFileAsync("launchctl", [
      "kickstart",
      "-k",
      `${domain}/${serviceLabel}`,
    ]);
  } else {
    if (isRoot) {
      await execFileAsync("systemctl", ["restart", unitName]);
    } else {
      await execFileAsync("systemctl", ["--user", "restart", unitName]);
    }
  }
}

type LogsOptions = { follow?: boolean; lines?: string; error?: boolean };

const toExistingPath = async (filePath: string): Promise<string | null> => {
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
};

const spawnAndPipe = async (
  command: string,
  args: string[],
  pretty: boolean,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const prettyStream = pretty
      ? (createPrettyLogStream() as unknown as Writable)
      : null;
    const child = spawn(command, args, {
      stdio: ["ignore", prettyStream ? "pipe" : "inherit", "inherit"],
    });
    if (prettyStream && child.stdout) child.stdout.pipe(prettyStream);
    child.on("close", (code) => {
      prettyStream?.end();
      if (code !== null && code !== 0)
        reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
    child.on("error", (error) => {
      prettyStream?.end();
      reject(error);
    });
  });
};

export const showServiceLogs = async (
  configPathOverride: string | undefined,
  opts: LogsOptions,
): Promise<void> => {
  await ensureInitialized(configPathOverride);
  const ctx = await createContext(configPathOverride, { prettyConsole: true });

  // systemd sends the unit's stdout/stderr to journald rather than to files,
  // so the stderr view has to come from journalctl instead of a tail.
  if (serviceManager === "systemd" && opts.error) {
    const journalArgs = process.getuid?.() === 0 ? [] : ["--user"];
    journalArgs.push("-u", unitName, "-n", opts.lines ?? "50", "-p", "err");
    if (opts.follow) journalArgs.push("-f");
    await spawnAndPipe("journalctl", journalArgs, false);
    return;
  }

  const requestedPaths = resolveServiceLogPaths({
    appName: APP_NAME,
    storageRoot: ctx.config.storage.root,
    lifecycleLogPath: ctx.config.logging.file,
    error: opts.error,
  });
  const existingPaths = (
    await Promise.all(requestedPaths.map(toExistingPath))
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingPaths.length === 0) {
    throw new Error("No service log files found");
  }

  const tailArgs = ["-n", opts.lines ?? "50"];
  if (opts.follow) tailArgs.push("-f");
  tailArgs.push(...existingPaths);

  await new Promise<void>((resolve, reject) => {
    const prettyStream = createPrettyLogStream() as unknown as Writable;
    const child = spawn("tail", tailArgs, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.pipe(prettyStream);
    child.on("close", (code) => {
      prettyStream.end();
      if (code !== null && code !== 0)
        reject(new Error(`tail exited with code ${code}`));
      else resolve();
    });
    child.on("error", (error) => {
      prettyStream.end();
      reject(error);
    });
  });
};

export function registerSystemService(system: Command, program: Command): void {
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
        const statusService = new StatusService(ctx.store);
        const initiatedEvent = logServiceLifecycle(ctx.logger, {
          action: "start",
          stage: "initiated",
          origin: "cli",
          reason: "service-install",
          context: { serviceManager },
        });
        await statusService.recordLifecycle(initiatedEvent);
        const installer = new ServiceInstaller();
        const cliArg = process.argv[1];
        const pathInstalled = await installer.install({
          configPath: ctx.configPath,
          storageRoot: ctx.config.storage.root,
          lifecycleLogPath: ctx.config.logging.file,
          nodePath: process.execPath,
          cliPath: cliArg ? path.resolve(cliArg) : process.execPath,
        });
        const completedEvent = logServiceLifecycle(ctx.logger, {
          action: "start",
          stage: "completed",
          origin: "cli",
          reason: "service-install",
          context: { serviceManager, servicePath: pathInstalled },
        });
        await statusService.recordLifecycle(completedEvent);
        printHeader("System Service Install");
        printKeyValues([
          ["servicePath", pathInstalled],
          ...getLifecycleEventEntries(completedEvent),
        ]);
      }),
    );

  systemService
    .command("uninstall")
    .description("Remove launchd/systemd service")
    .action(
      runCommand(async () => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const statusService = new StatusService(ctx.store);
        const initiatedEvent = logServiceLifecycle(ctx.logger, {
          action: "stop",
          stage: "initiated",
          origin: "cli",
          reason: "service-uninstall",
          context: { serviceManager },
        });
        await statusService.recordLifecycle(initiatedEvent);
        const installer = new ServiceInstaller();
        const pathRemoved = await installer.uninstall();
        const completedEvent = logServiceLifecycle(ctx.logger, {
          action: "stop",
          stage: "completed",
          origin: "cli",
          reason: "service-uninstall",
          context: { serviceManager, servicePath: pathRemoved },
        });
        await statusService.recordLifecycle(completedEvent);
        printHeader("System Service Uninstall");
        printKeyValues([
          ["servicePath", pathRemoved],
          ...getLifecycleEventEntries(completedEvent),
        ]);
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
        entries.push(...getLifecycleStatusEntries(syncStatus));
        printKeyValues(entries);
      }),
    );

  systemService
    .command("restart")
    .description("Restart the background service")
    .action(
      runCommand(async () => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const statusService = new StatusService(ctx.store);
        const initiatedEvent = logServiceLifecycle(ctx.logger, {
          action: "restart",
          stage: "initiated",
          origin: "cli",
          reason: "service-restart",
          context: { serviceManager },
        });
        await statusService.recordLifecycle(initiatedEvent);
        await restartOsService();
        const completedEvent = logServiceLifecycle(ctx.logger, {
          action: "restart",
          stage: "completed",
          origin: "cli",
          reason: "service-restart",
          context: { serviceManager },
        });
        await statusService.recordLifecycle(completedEvent);
        printHeader("System Service Restart");
        printKeyValues([
          ["status", "restarted"],
          ...getLifecycleEventEntries(completedEvent),
        ]);
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
        await showServiceLogs(rootOpts.config, opts);
      }),
    );
}
