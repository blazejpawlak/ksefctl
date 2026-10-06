import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSync } from "../../src/cli/commands/sync.js";
import {
  allowExcessArgumentsRecursively,
  formatCliError,
} from "../../src/cli.js";

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

  it("rejects --time-window together with --watch", async () => {
    await expect(
      parseSync(["--watch", "--time-window", "01-01-2026:31-01-2026"]),
    ).rejects.toThrow(
      /--time-window <from:to>' cannot be used with option '--watch'/,
    );
  });

  it("rejects --redownload together with --redownload-all", async () => {
    await expect(
      parseSync(["--redownload", "KSEF-1", "--redownload-all"]),
    ).rejects.toThrow(
      /--redownload <ksefNumber>' cannot be used with option '--redownload-all'/,
    );
  });

  it("rejects --repair-missing-pdfs together with --flat-sync", async () => {
    await expect(
      parseSync(["--repair-missing-pdfs", "--flat-sync"]),
    ).rejects.toThrow(
      /--repair-missing-pdfs' cannot be used with option '--flat-sync'/,
    );
  });
});

describe("excess command-arguments", () => {
  const buildProgram = (onAction: (name: string) => void) => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    const system = program.command("system");
    system.command("completion").argument("<shell>").action(() => {
      onAction("completion");
    });
    // Commands attached with addCommand() do not inherit parent settings.
    const daemon = new Command("daemon")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .action(() => {
        onAction("daemon");
      });
    program.addCommand(daemon);
    return program;
  };

  it("are rejected by commander's default settings", async () => {
    const program = buildProgram(() => undefined);
    await expect(
      program.parseAsync(["node", "ksefctl", "daemon", "extra"]),
    ).rejects.toThrow(/too many arguments for 'daemon'/);
  });

  it("are ignored across the whole command tree once allowed", async () => {
    const called: string[] = [];
    const program = buildProgram((name) => called.push(name));
    allowExcessArgumentsRecursively(program);
    await program.parseAsync(["node", "ksefctl", "daemon", "extra"]);
    await program.parseAsync([
      "node",
      "ksefctl",
      "system",
      "completion",
      "zsh",
      "extra",
    ]);
    expect(called).toEqual(["daemon", "completion"]);
  });
});
