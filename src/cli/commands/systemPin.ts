import type { Command } from "commander";
import { ConfigError } from "../../utils/errors";
import { fetchTlsPin } from "../pin";
import { printHeader, printKeyValues } from "../ui";
import { runCommand } from "./runCommand";

export function registerSystemPin(system: Command): void {
  system
    .command("pin <host>")
    .description("Fetch the SPKI SHA-256 TLS pin for a host")
    .option("-p, --port <port>", "TLS port (default: 443)")
    .action(
      runCommand(async (host: string, options: { port?: string }) => {
        const port = options.port ? Number(options.port) : 443;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ConfigError(`Invalid port: ${options.port ?? ""}`);
        }
        const result = await fetchTlsPin(host, { port });
        printHeader("TLS Pin");
        printKeyValues([
          ["host", result.host],
          ["port", String(result.port)],
          ["pin", result.pin],
        ]);
        console.log();
        console.log("Paste into config (security.tls):");
        console.log("  enablePinning: true");
        console.log("  pins:");
        console.log(`    - "${result.pin}"`);
      }),
    );
}
