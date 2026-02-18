import { Command } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompletionSpec,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  shouldRunFirstRun,
} from "../../src/cli";
import { defaultConfigPath } from "../../src/utils/paths";

const setTty = (value: boolean) => {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
};

describe("completion helpers", () => {
  const originalHome = process.env.HOME;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  const originalNoFirstRun = process.env.KSEFCTL_NO_FIRST_RUN;
  const originalTtyIn = process.stdin.isTTY;
  const originalTtyOut = process.stdout.isTTY;

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.XDG_CONFIG_HOME = originalXdgConfig;
    process.env.KSEFCTL_NO_FIRST_RUN = originalNoFirstRun;
    setTty(Boolean(originalTtyIn));
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalTtyOut,
      configurable: true,
    });
  });

  it("includes options in bash completion output", () => {
    const program = new Command();
    program.option("--config <path>");
    program.command("sync").option("--once").option("--verbose");

    const spec = buildCompletionSpec(program);
    const output = renderBashCompletion(spec);

    expect(output).toContain("sync");
    expect(output).toContain("--config");
    expect(output).toContain("--once");
    expect(output).toContain("--verbose");
    expect(output).toContain("compgen -f");
  });

  it("includes path completion for config in fish output", () => {
    const program = new Command();
    program.option("--config <path>");
    const spec = buildCompletionSpec(program);
    const output = renderFishCompletion(spec);

    expect(output).toContain("__fish_complete_path");
  });

  it("installs bash completion and updates rc file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-comp-"));
    process.env.HOME = tmpDir;
    setTty(true);

    const program = new Command();
    program.command("sync");
    const spec = buildCompletionSpec(program);
    const result = await installCompletion("bash", spec);

    const completionPath = path.join(
      tmpDir,
      ".ksefctl",
      "completions",
      "ksefctl.bash",
    );
    const rcPath = path.join(tmpDir, ".bashrc");
    const completionContent = await fs.readFile(completionPath, "utf-8");
    const rcContent = await fs.readFile(rcPath, "utf-8");

    expect(result.installed).toBe(true);
    expect(completionContent).toContain("_ksefctl_complete");
    expect(rcContent).toContain("ksefctl completion start");
    expect(rcContent).toContain(`source '${completionPath}'`);
  });

  it("respects first-run opt-out and config existence", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-first-"));
    process.env.HOME = tmpDir;
    const configPath = defaultConfigPath();
    setTty(true);

    let shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(true);

    process.env.KSEFCTL_NO_FIRST_RUN = "1";
    shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(false);

    process.env.KSEFCTL_NO_FIRST_RUN = " true ";
    shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(false);

    process.env.KSEFCTL_NO_FIRST_RUN = undefined;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "", "utf-8");
    shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(false);
  });

  it("skips first-run in non-tty", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-first-"));
    process.env.HOME = tmpDir;
    setTty(false);

    const shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(false);
  });
});
