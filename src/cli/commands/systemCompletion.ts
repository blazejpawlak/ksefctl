import type { Command } from "commander";
import { ConfigError } from "../../utils/errors";
import {
  buildCompletionSpec,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "../completion";

export function registerSystemCompletion(
  system: Command,
  program: Command,
): void {
  system
    .command("completion")
    .description("Generate shell completion script")
    .argument("<shell>", "shell type (bash|zsh|fish)")
    .action((shell: string) => {
      const normalized = shell.trim().toLowerCase();
      const spec = buildCompletionSpec(program);
      if (normalized === "bash") {
        console.log(renderBashCompletion(spec));
        return;
      }
      if (normalized === "zsh") {
        console.log(renderZshCompletion(spec));
        return;
      }
      if (normalized === "fish") {
        console.log(renderFishCompletion(spec));
        return;
      }
      throw new ConfigError(
        `Unsupported shell: ${shell}. Use bash, zsh, or fish.`,
      );
    });
}
