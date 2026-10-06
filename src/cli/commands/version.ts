import type { Command } from "commander";
import { printVersion } from "../version.js";
import { runCommand } from "./runCommand.js";

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("Show current version")
    .action(runCommand(async () => printVersion()));
}
