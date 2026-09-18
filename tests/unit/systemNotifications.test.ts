import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSystemNotifications } from "../../src/cli/commands/systemNotifications";

describe("system notifications command", () => {
  it("registers the notifications backfill command and safety options", () => {
    const program = new Command();
    const system = program.command("system");

    registerSystemNotifications(system, program);

    const notifications = system.commands.find(
      (command) => command.name() === "notifications",
    );
    const backfill = notifications?.commands.find(
      (command) => command.name() === "backfill",
    );
    expect(backfill).toBeDefined();
    expect(backfill?.options.map((option) => option.long)).toEqual([
      "--dry-run",
      "--yes",
    ]);
  });
});
