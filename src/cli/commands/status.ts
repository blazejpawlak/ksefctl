import type { Command } from "commander";
import { StatusService } from "../../core/statusService.js";
import { ensureInitialized } from "../bootstrap.js";
import { createContext } from "../context.js";
import { getLifecycleStatusEntries } from "../lifecycleStatus.js";
import { printHeader, printKeyValues } from "../ui.js";
import { runCommand, type RootOptions } from "./runCommand.js";

type StatusOptions = {
  json?: boolean;
};

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show last sync status")
    .option("--json", "output JSON")
    .action(
      runCommand(async (options: StatusOptions) => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const statusService = new StatusService(ctx.store, {
          storageRoot: ctx.config.storage.root,
          fallbackIntervalSeconds: ctx.config.pollingIntervalSeconds,
          adaptivePollingEnabled: ctx.config.sync.adaptivePolling.enabled,
        });
        const status = await statusService.getStatus();
        const payload = {
          configPath: ctx.configPath,
          storageRoot: ctx.config.storage.root,
          ...status,
        };
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        printHeader("Status");
        printKeyValues([
          ["configPath", payload.configPath],
          ["storageRoot", payload.storageRoot],
          ["lastSyncAt", payload.lastSyncAt],
          ["lastSuccessAt", payload.lastSuccessAt],
          ["lastError", payload.lastError],
          ["lastDownloadedCount", payload.lastDownloadedCount],
          ["effectiveIntervalSeconds", payload.effectiveIntervalSeconds],
          ["nextRunAt", payload.nextRunAt],
          ...getLifecycleStatusEntries(payload),
        ]);
      }),
    );
}
