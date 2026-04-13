import type { Command } from "commander";
import { ConfigError, exitCodeFromError } from "../../utils/errors";
import { ensureInitialized } from "../bootstrap";
import { createContext } from "../context";
import { isValidNip } from "../keychain";
import { createProgressRenderer } from "../progress";
import { printHeader, printKeyValues } from "../ui";
import { formatCliError, type RootOptions } from "./runCommand";

type VerifyOptions = {
  nip?: string;
  verbose?: boolean;
};

export function registerSystemVerify(system: Command, program: Command): void {
  system
    .command("verify")
    .description("Validate authentication for configured environment")
    .option("--nip <nip>", "validate a single NIP")
    .option("-v, --verbose", "enable verbose logging")
    .action(async (options: VerifyOptions) => {
      const renderer = process.stderr.isTTY
        ? createProgressRenderer({ stream: process.stderr })
        : null;
      try {
        const rootOpts = program.opts<RootOptions>();
        const verbose = options.verbose ?? rootOpts.verbose;
        const { config } = rootOpts;
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
