import type { Command } from "commander";
import YAML from "yaml";
import { sanitizeConfig } from "../../config/loadConfig";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { runCommand, type RootOptions } from "./runCommand";

type ConfigShowOptions = {
  verbose?: boolean;
};

export function registerSystemConfig(
  system: Command,
  program: Command,
): void {
  const systemConfig = system
    .command("config")
    .description("Config commands");

  systemConfig
    .command("show")
    .description("Show sanitized effective config")
    .option("-v, --verbose", "enable verbose logging")
    .action(
      runCommand(async (options: ConfigShowOptions) => {
        const rootOpts = program.opts<RootOptions>();
        const verbose = options.verbose ?? rootOpts.verbose;
        const { config } = rootOpts;
        await ensureInitialized(config);
        const ctx = await createContext(config, { verbose });
        const sanitized = sanitizeConfig(ctx.config);
        console.log(YAML.stringify(sanitized));
      }),
    );
}
