import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCompletionSpec,
  formatVersionOutput,
  hasVersionFlag,
  installCompletion,
  renderBashCompletion,
  renderFishCompletion,
  shouldRunFirstRun,
} from "../../src/cli";
import { escapeFishDescription } from "../../src/cli/completion";
import { defaultDataRoot } from "../../src/utils/paths";

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

  afterEach(() => {
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
    program.option("--config <path>").option("-v, --verbose");
    program.command("sync").option("--once");

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

  it("escapes fish completion descriptions for quotes, backslashes, substitution, and newlines", () => {
    expect(escapeFishDescription("say \"hi\" and \"\"\"more\"\"\"")).toBe(
      "say \\\"hi\\\" and \\\"\\\"\\\"more\\\"\\\"\\\"",
    );
    expect(escapeFishDescription("path\\to\\file and trailing\\")).toBe(
      "path\\\\to\\\\file and trailing\\\\",
    );
    expect(escapeFishDescription("\\\"")).toBe("\\\\\\\"");
    expect(escapeFishDescription("\\\\\"")).toBe("\\\\\\\\\\\"");
    expect(escapeFishDescription("$HOME ${HOME} $(whoami) $$$$")).toBe(
      "\\$HOME \\${HOME} \\$\\(whoami) \\$\\$\\$\\$",
    );
    expect(escapeFishDescription("(echo pwned)")).toBe("\\(echo pwned)");
    expect(escapeFishDescription("((((cmd")).toBe("\\(\\(\\(\\(cmd");
    expect(escapeFishDescription("line1\ncomplete -c pwned\rline2")).toBe(
      "line1 complete -c pwned line2",
    );
    expect(escapeFishDescription("a\0b\tc\x1bd\u007fe")).toBe("a b c d e");

    const payload =
      "say \"hi\" $HOME $(whoami) (echo pwned) path\\file\ncomplete -c pwned\0\t\u007f";
    const program = new Command();
    program.option("--payload <value>", payload);
    const output = renderFishCompletion(buildCompletionSpec(program));
    const payloadLine = output
      .split("\n")
      .find((line) => line.includes("-l payload"));

    expect(payloadLine).toBeDefined();
    expect(payloadLine).toContain(`-d "${escapeFishDescription(payload)}"`);
    expect(payloadLine).toContain("\\\"hi\\\"");
    expect(payloadLine).toContain("\\$HOME");
    expect(payloadLine).toContain("\\$\\(whoami)");
    expect(payloadLine).toContain("\\(echo pwned)");
    expect(payloadLine).toContain("path\\\\file");
    expect(payloadLine).not.toContain("say \"hi\"");
    expect(payloadLine).not.toMatch(/(^|[^\\])\$HOME/);
    expect(payloadLine).not.toMatch(/(^|[^\\])\$\(/);
    expect(payloadLine).not.toMatch(/(^|[^\\])\(echo pwned\)/);
    expect(payloadLine).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(output).not.toMatch(/\ncomplete -c pwned(?:\s|$)/);
    expect(
      output.split("\n").filter((line) => line.includes("-l payload")),
    ).toHaveLength(1);
  });

  it("detects global version flags before command parsing", () => {
    expect(hasVersionFlag(["--version"])).toBe(true);
    expect(hasVersionFlag(["-V"])).toBe(true);
    expect(hasVersionFlag(["sync", "--version"])).toBe(true);
    expect(hasVersionFlag(["--", "--version"])).toBe(false);
  });

  it("formats version output with short commit info", () => {
    expect(formatVersionOutput("2026.02.21", "06fa00c")).toBe(
      "2026.02.21 (06fa00c)",
    );
  });

  it("formats version output with PDF builder build info", () => {
    expect(
      formatVersionOutput("2026.02.21", "06fa00c", {
        name: "@akmf/ksef-fe-invoice-converter",
        version: "1.1.39",
        source: "CIRFMF/ksef-pdf-generator",
        commit: "fb12569a439a391a8e0c705e7dc331079be8c942",
      }),
    ).toBe(
      [
        "2026.02.21 (06fa00c)",
        "pdf-builder: @akmf/ksef-fe-invoice-converter 1.1.39 (CIRFMF/ksef-pdf-generator@fb12569a; check upstream releases for newer versions)",
      ].join("\n"),
    );
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
      defaultDataRoot(),
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

  it("refuses to overwrite symlinked completion files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-comp-"));
    process.env.HOME = tmpDir;
    setTty(true);

    const completionDir = path.join(defaultDataRoot(), "completions");
    await fs.mkdir(completionDir, { recursive: true, mode: 0o700 });
    const targetPath = path.join(tmpDir, "target.bash");
    const completionPath = path.join(completionDir, "ksefctl.bash");
    await fs.writeFile(targetPath, "target", "utf-8");
    await fs.symlink(targetPath, completionPath);

    const program = new Command();
    program.command("sync");
    const spec = buildCompletionSpec(program);

    await expect(installCompletion("bash", spec)).rejects.toThrow(
      "Refusing to modify symlinked rc file",
    );
  });

  it("respects first-run opt-out and config existence", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-first-"));
    process.env.HOME = tmpDir;
    const rootDir = defaultDataRoot();
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
    await fs.mkdir(rootDir, { recursive: true });
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

  it("runs first-run when data root is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-first-"));
    process.env.HOME = tmpDir;
    setTty(true);

    const shouldRun = await shouldRunFirstRun(true);
    expect(shouldRun).toBe(true);
  });
});
