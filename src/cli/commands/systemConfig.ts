import type { Command } from "commander";
import YAML from "yaml";
import { sanitizeConfig } from "../../config/loadConfig.js";
import { ensureInitialized } from "../bootstrap.js";
import { createContext } from "../context.js";
import { runCommand, type RootOptions } from "./runCommand.js";

export function registerSystemConfig(
  system: Command,
  program: Command,
): void {
  system
    .command("config")
    .description("Show sanitized effective config")
    .action(
      runCommand(async () => {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const sanitized = sanitizeConfig(ctx.config);
        console.log(YAML.stringify(sanitized));
      }),
    );
}
