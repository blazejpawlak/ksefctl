import type { Command } from "commander";
import { printVersion } from "../version";
import { runCommand } from "./runCommand";

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("Show current version")
    .action(runCommand(async () => printVersion()));
}
