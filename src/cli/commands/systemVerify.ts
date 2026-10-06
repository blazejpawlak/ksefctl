import type { Command } from "commander";
import { ConfigError, exitCodeFromError } from "../../utils/errors.js";
import { ensureInitialized } from "../bootstrap.js";
import { createContext } from "../context.js";
import { isValidNip } from "../keychain.js";
import { createProgressRenderer } from "../progress.js";
import { printHeader, printKeyValues } from "../ui.js";
import { formatCliError, type RootOptions } from "./runCommand.js";

type VerifyOptions = {
  nip?: string;
};

export function registerSystemVerify(system: Command, program: Command): void {
  system
    .command("verify")
    .description("Validate authentication for configured environment")
    .option("-n, --nip <nip>", "validate a single NIP")
    .action(async (options: VerifyOptions) => {
      const renderer = process.stderr.isTTY
        ? createProgressRenderer({ stream: process.stderr })
        : null;
      try {
        const rootOpts = program.opts<RootOptions>();
        const { config, verbose } = rootOpts;
        await ensureInitialized(config);
        const progress = renderer
          ? (message: string) => renderer.update(message)
          : undefined;
        const ctx = await createContext(config, { verbose, progress });
        if (options.nip && !isValidNip(options.nip)) {
          throw new ConfigError("Invalid NIP format (expected 10 digits)");
        }
        const nips = options.nip
          ? [options.nip]
          : ctx.config.organizations.map((org) => org.nip);
        for (const nip of nips) {
          await ctx.auth.getAccessToken(nip);
        }
        renderer?.done();
        printHeader("System Verify");
        printKeyValues([
          ["status", "ok"],
          ["environment", ctx.config.environment],
        ]);
      } catch (error) {
        renderer?.done();
        console.error(formatCliError(error));
        process.exitCode = exitCodeFromError(error);
      }
    });
}
