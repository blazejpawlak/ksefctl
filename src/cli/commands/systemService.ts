import type { Command } from "commander";
import path from "node:path";
import { ServiceInstaller } from "../../services/serviceInstaller";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { printHeader, printKeyValues } from "../ui";
import { runCommand, type RootOptions } from "./runCommand";

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
}
