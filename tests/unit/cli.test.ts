import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { formatCliError } from "../../src/cli";
import { registerSync } from "../../src/cli/commands/sync";

describe("cli error formatting", () => {
  it("sanitizes terminal-facing CLI errors", () => {
    expect(
      formatCliError(
        new Error(
          "HTTP 500 GET /invoices/exports: token=secret request failed (requestId=req-1)",
        ),
      ),
    ).toBe("HTTP 500 GET /invoices/exports (requestId=req-1)");
  });

  it("removes terminal control characters from CLI errors", () => {
    expect(formatCliError(new Error("bad\u0000value\nnext line"))).toBe(
      "badvaluenext line",
    );
  });
});

describe("sync option conflicts", () => {
  const parseSync = (args: string[]) => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerSync(program);
    return program.parseAsync(["node", "ksefctl", "sync", ...args]);
  };

  it("rejects --output-path together with --watch", async () => {
    await expect(
      parseSync(["--watch", "--output-path", "/tmp/ksef-export"]),
    ).rejects.toThrow(/--output-path <path>' cannot be used with option '--watch'/);
  });
});
