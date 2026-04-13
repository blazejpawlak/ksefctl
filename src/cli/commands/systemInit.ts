import type { Command } from "commander";
import { exitCodeFromError } from "../../utils/errors";
import {
  bootstrapInteractive,
  getInitializationStatus,
  resetAndBootstrap,
} from "../bootstrap";
import { initConfig } from "../init";
import { promptText } from "../prompt";
import { printHeader, printKeyValues } from "../ui";
import { formatCliError, type RootOptions } from "./runCommand";

type InitOptions = {
  force?: boolean;
  yes?: boolean;
};

export function registerSystemInit(system: Command, program: Command): void {
  system
    .command("init")
    .description("Create config template and storage directories")
    .option("-f, --force", "reset config and re-run bootstrap")
    .option("--yes", "skip confirmation prompt")
    .action(async (options: InitOptions) => {
      try {
        const isInteractive = process.stdin.isTTY;
        const { config } = program.opts<RootOptions>();

        if (!isInteractive) {
          const configPath = await initConfig(config, Boolean(options.force));
          printHeader("Init");
          printKeyValues([
            ["status", "template written"],
            ["configPath", configPath],
          ]);
          console.log(
            "Run 'ksefctl system init' in an interactive terminal to set up NIPs and tokens.",
          );
          return;
        }

        if (options.force) {
          if (!options.yes) {
            const confirm = await promptText(
              "This will remove config and keychain tokens for all NIPs. Continue? (y/N): ",
            );
            if (!/^y(es)?$/i.test(confirm.trim())) {
              printHeader("Init");
              printKeyValues([["status", "cancelled"]]);
              return;
            }
          }
          await resetAndBootstrap(config);
        } else {
          const status = await getInitializationStatus(config);
          if (status.initialized) {
            printHeader("Init");
            printKeyValues([["status", "already initialized"]]);
            return;
          }
          await bootstrapInteractive(config);
        }
        printHeader("Init");
        printKeyValues([["status", "initialized"]]);
      } catch (error) {
        console.error(formatCliError(error));
        process.exitCode = exitCodeFromError(error);
      }
    });
}
