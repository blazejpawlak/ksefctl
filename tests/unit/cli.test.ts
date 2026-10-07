import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerSync } from "../../src/cli/commands/sync.js";
import {
  allowExcessArgumentsRecursively,
  formatCliError,
} from "../../src/cli.js";
import { ConfigError, exitCodeFromError } from "../../src/utils/errors.js";

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

  it("truncates non-config errors to 500 characters on one line", () => {
    const formatted = formatCliError(new Error(`first\nsecond ${"x".repeat(900)}`));
    // The cap applies before the newline is stripped, so 499 chars remain.
    expect(formatted).toHaveLength(499);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted).not.toContain("\n");
  });
});

describe("config error formatting", () => {
  const prettyConfigMessage = (count: number): string => {
    const schema = z.object({
      organizations: z.array(z.object({ nip: z.string().length(10) })),
    });
    const result = schema.safeParse({
      organizations: Array.from({ length: count }, () => ({ nip: "1" })),
    });
    if (result.success) throw new Error("expected invalid config");
    return `Invalid config at /tmp/config.yaml:\n${z.prettifyError(result.error)}`;
  };

  it("shows every violation on its own line past 500 characters", () => {
    const message = prettyConfigMessage(20);
    expect(message.length).toBeGreaterThan(500);

    const formatted = formatCliError(new ConfigError(message));

    expect(formatted).toBe(message);
    expect(formatted).toContain("→ at organizations[19].nip");
    const lines = formatted.split("\n");
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.filter((line) => line.includes("→ at organizations[")))
      .toHaveLength(20);
  });

  it("strips escape sequences and control characters but keeps newlines", () => {
    const formatted = formatCliError(
      new ConfigError(
        "Invalid config:\n✖ bad \u001b[31mred\u001b[0m\u0007 value\r\n✖ \u009b2Jx\ty\u0000z\n✖ last",
      ),
    );

    expect(formatted).toBe(
      "Invalid config:\n✖ bad [31mred[0m value\n✖ 2Jxyz\n✖ last",
    );
    expect(formatted).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it("redacts secrets without swallowing the following line", () => {
    const formatted = formatCliError(
      new ConfigError(
        "Invalid config:\n✖ token: abc123\n✖ next violation\n✖ see https://user:hunter2@host/x?api_key=k1&a=b",
      ),
    );

    expect(formatted).not.toContain("abc123");
    expect(formatted).not.toContain("hunter2");
    expect(formatted).not.toContain("k1");
    expect(formatted).toContain("✖ token: [REDACTED]\n✖ next violation\n");
  });

  it("caps pathological diagnostics and reports the omitted lines", () => {
    const message = Array.from({ length: 250 }, (_, i) => `✖ violation ${i}`).join(
      "\n",
    );

    const formatted = formatCliError(new ConfigError(message));

    const lines = formatted.split("\n");
    expect(lines).toHaveLength(101);
    expect(lines[99]).toBe("✖ violation 99");
    expect(lines[100]).toBe("... (150 more lines omitted)");
  });

  it("bounds the total length of a huge single-line config error", () => {
    const formatted = formatCliError(new ConfigError("x".repeat(20_000)));
    expect(formatted).toHaveLength(5000);
    expect(formatted.endsWith("...")).toBe(true);
  });

  it("keeps exit code 4 for config errors", () => {
    expect(exitCodeFromError(new ConfigError("bad"))).toBe(4);
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
