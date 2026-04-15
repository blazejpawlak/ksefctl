import type { Command } from "commander";
import { clearSecret, setSecret, showSecrets } from "../keychain";
import { printHeader, printKeyValues } from "../ui";
import { runCommand, type RootOptions } from "./runCommand";

type SecretSetOptions = {
  nip?: string;
  tokenStdin?: boolean;
};

type SecretClearOptions = {
  nip: string;
};

export function registerSystemSecret(
  system: Command,
  program: Command,
): void {
  const secret = system
    .command("secret")
    .description("Manage KSeF authentication tokens");

  secret
    .command("set")
    .description("Store KSeF token in keychain")
    .option("-n, --nip <nip>", "NIP (10 digits)")
    .option("--token-stdin", "read KSeF token from stdin")
    .action(
      runCommand(async (options: SecretSetOptions) => {
        const { config } = program.opts<RootOptions>();
        const result = await setSecret(
          config,
          options.nip,
          undefined,
          Boolean(options.tokenStdin),
        );
        printHeader("Secret Set");
        printKeyValues([["nip", result.nip]]);
      }),
    );

  secret
    .command("show")
    .description("Show keychain secret presence")
    .action(
      runCommand(async () => {
        const { config } = program.opts<RootOptions>();
        const entries = await showSecrets(config);
        printHeader("Secrets");
        printKeyValues(
          entries.map((entry) => [
            entry.nip,
            entry.present ? "present" : "missing",
          ]),
        );
      }),
    );

  secret
    .command("clear")
    .description("Remove keychain secret for a NIP")
    .requiredOption("-n, --nip <nip>", "NIP (10 digits)")
    .action(
      runCommand(async (options: SecretClearOptions) => {
        const { config } = program.opts<RootOptions>();
        await clearSecret(config, options.nip);
        printHeader("Secret Clear");
        printKeyValues([["nip", options.nip]]);
      }),
    );
}
