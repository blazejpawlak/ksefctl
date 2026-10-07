import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptsSource = path.join(import.meta.dirname, "..", "..", "scripts");
const scriptNames = [
  "prepare-ksef-pdf-generator.mjs",
  "vendored-converter.mjs",
  "third-party-notices.mjs",
];
const pinnedCommit = "f59fc4e2addcf42c74b1674e7c1d534085bc3a84";
const bundleSource = "export const built = true;\n";

// A base64 blob that looks like an embedded TrueType font carrying `name`
// strings, the way the bundle embeds Roboto.
const fakeFontBundle = (names: string): string =>
  `export const font = "${Buffer.concat([
    Buffer.from([0, 1, 0, 0]),
    Buffer.from(`${names}${"x".repeat(600)}`, "latin1"),
  ]).toString("base64")}";\n`;

// Stands in for npm: records the argv and npm-related environment of every call
// and creates the build artifacts for `npm run build`. PREPARE_TEST_PROBE picks
// how `npm install-scripts ls` answers.
const stubNpm = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => /^npm_config_/i.test(name) || name === "NODE_ENV",
  ),
);
fs.appendFileSync(
  process.env.PREPARE_TEST_RECORD,
  JSON.stringify({ args, cwd: process.cwd(), env }) + "\\n",
);
if (args[0] === "install-scripts") {
  if (process.env.PREPARE_TEST_PROBE === "unknown") {
    console.error('Unknown command: "install-scripts"');
    process.exit(1);
  }
  if (process.env.PREPARE_TEST_PROBE === "broken") {
    console.error("npm error code EALLOWSCRIPTS");
    process.exit(1);
  }
}
if (args[0] === "run") {
  fs.mkdirSync("dist", { recursive: true });
  fs.writeFileSync(
    "dist/ksef-fe-invoice-converter.js",
    process.env.PREPARE_TEST_BUNDLE ?? "export const built = true;\\n",
  );
}
`;

// The environment npm exports to lifecycle scripts for the README install
// (`npm install --global ... --allow-scripts=...`) with --omit=dev and a
// production NODE_ENV on top, plus settings that must keep reaching the nested
// npm.
const outerEnv = {
  npm_config_global: "true",
  npm_config_prefix: "/opt/global",
  npm_config_local_prefix: "/opt/global/lib/node_modules/ksefctl",
  npm_config_location: "global",
  npm_config_omit: "dev",
  npm_config_only: "prod",
  npm_config_production: "true",
  npm_config_dev: "false",
  npm_config_allow_scripts: "@blazejpawlak/ksefctl,keytar",
  npm_config_dangerously_allow_all_scripts: "true",
  NODE_ENV: "production",
  npm_config_registry: "https://npm.pkg.github.com/",
  npm_config_cache: "/opt/cache",
  npm_config_https_proxy: "http://proxy.invalid:3128",
};

type Call = {
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

describe("prepare-ksef-pdf-generator", () => {
  let root: string;
  let vendorDir: string;
  let converterDir: string;
  let recordPath: string;

  // npm's hidden lockfile records what is installed for the converter.
  const writeInstalledLock = (commit: string) =>
    fs.mkdir(path.join(root, "pkg", "node_modules"), { recursive: true }).then(() =>
      fs.writeFile(
        path.join(root, "pkg", "node_modules", ".package-lock.json"),
        JSON.stringify({
          packages: {
            "node_modules/@akmf/ksef-fe-invoice-converter": {
              version: "1.2.3",
              resolved: `git+ssh://git@github.com/CIRFMF/ksef-pdf-generator.git#${commit}`,
            },
          },
        }),
      ),
    );

  const addDependency = async (
    name: string,
    version: string,
    license: string,
    licenseText: string | null,
    extra: Record<string, unknown> = {},
  ) => {
    const dir = path.join(converterDir, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version, license, ...extra }),
    );
    if (licenseText !== null) {
      await fs.writeFile(path.join(dir, "LICENSE"), licenseText);
    }
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-prepare-")));
    converterDir = path.join(root, "pkg", "node_modules", "@akmf", "ksef-fe-invoice-converter");
    vendorDir = path.join(root, "pkg", "vendor", "ksef-pdf-generator");
    recordPath = path.join(root, "calls.jsonl");
    await fs.mkdir(path.join(root, "pkg", "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "bin"));
    await fs.mkdir(converterDir, { recursive: true });
    for (const name of scriptNames) {
      await fs.copyFile(
        path.join(scriptsSource, name),
        path.join(root, "pkg", "scripts", name),
      );
    }
    await fs.cp(
      path.join(scriptsSource, "third-party-assets"),
      path.join(root, "pkg", "scripts", "third-party-assets"),
      { recursive: true },
    );
    await writeInstalledLock(pinnedCommit);
    await fs.writeFile(
      path.join(root, "pkg", "package.json"),
      JSON.stringify({
        devDependencies: {
          "@akmf/ksef-fe-invoice-converter": `github:CIRFMF/ksef-pdf-generator#${pinnedCommit}`,
        },
      }),
    );
    await fs.writeFile(
      path.join(converterDir, "package.json"),
      JSON.stringify({
        name: "@akmf/ksef-fe-invoice-converter",
        version: "1.2.3",
        dependencies: { "dep-a": "^1.0.0" },
      }),
    );
    await fs.writeFile(path.join(converterDir, "LICENSE"), "MIT License\n");
    await addDependency("dep-a", "1.0.0", "MIT", "License text of dep-a\n");
    await fs.writeFile(path.join(root, "bin", "npm"), stubNpm, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const runScript = async (
    probe: string,
    ...scriptArgs: string[]
  ) => runScriptWith(probe, {}, ...scriptArgs);

  const runScriptWith = async (
    probe: string,
    extraEnv: Record<string, string>,
    ...scriptArgs: string[]
  ) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "pkg", "scripts", "prepare-ksef-pdf-generator.mjs"), ...scriptArgs],
      {
        encoding: "utf-8",
        env: {
          PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          PREPARE_TEST_RECORD: recordPath,
          PREPARE_TEST_PROBE: probe,
          ...extraEnv,
          ...outerEnv,
        },
      },
    );
    const recorded = await fs.readFile(recordPath, "utf-8").catch(() => "");
    const calls = recorded
      .trimEnd()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Call);
    return { result, calls };
  };

  it("runs the probe, install and build as a local dev install", async () => {
    const { result, calls } = await runScript("ok");

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["install-scripts", "ls"],
      ["install", "--package-lock=false"],
      ["run", "build"],
    ]);
    for (const call of calls) {
      expect(call.cwd).toBe(converterDir);
      expect(call.env).toEqual({
        npm_config_registry: "https://npm.pkg.github.com/",
        npm_config_cache: "/opt/cache",
        npm_config_https_proxy: "http://proxy.invalid:3128",
      });
    }
    for (const call of calls.slice(0, 2)) {
      expect(call.args).toEqual(
        expect.arrayContaining(["--global=false", "--location=project", "--include=dev"]),
      );
    }
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining(["--global=false", "--location=project"]),
    );
    expect(
      await fs.readFile(path.join(vendorDir, "ksef-fe-invoice-converter.js"), "utf-8"),
    ).toBe("export const built = true;\n");
    expect(await fs.readFile(path.join(vendorDir, "LICENSE"), "utf-8")).toBe(
      "MIT License\n",
    );
    expect(
      JSON.parse(await fs.readFile(path.join(vendorDir, "metadata.json"), "utf-8")),
    ).toEqual({
      name: "@akmf/ksef-fe-invoice-converter",
      version: "1.2.3",
      source: "CIRFMF/ksef-pdf-generator",
      commit: pinnedCommit,
      bundleSha256: createHash("sha256").update(bundleSource).digest("hex"),
      noticesSha256: createHash("sha256")
        .update(await fs.readFile(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt")))
        .digest("hex"),
    });
    const notices = await fs.readFile(
      path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"),
      "utf-8",
    );
    expect(notices).toContain("dep-a@1.0.0");
    expect(notices).toContain("License text of dep-a");
    expect(notices).toContain("(none)");
    // Only the vendor directory is produced: no staging leftovers, and the
    // converter package keeps no copies of its build output.
    expect(await fs.readdir(path.join(root, "pkg", "vendor"))).toEqual([
      "ksef-pdf-generator",
    ]);
    await expect(
      fs.access(path.join(converterDir, "ksef-fe-invoice-converter.js")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(converterDir, ".npmrc"), "utf-8")).toBe(
      "allow-scripts[]=esbuild\nallow-scripts[]=fsevents\n",
    );
  });

  it("drops the allowlist only when npm does not know the command", async () => {
    await fs.writeFile(path.join(converterDir, ".npmrc"), "stale\n");
    const { result } = await runScript("unknown");

    expect(result.status, result.stderr).toBe(0);
    await expect(fs.access(path.join(converterDir, ".npmrc"))).rejects.toThrow();
  });

  it("keeps the allowlist when the probe fails for another reason", async () => {
    const { result } = await runScript("broken");

    expect(result.status, result.stderr).toBe(0);
    expect(await fs.readFile(path.join(converterDir, ".npmrc"), "utf-8")).toBe(
      "allow-scripts[]=esbuild\nallow-scripts[]=fsevents\n",
    );
  });

  it("skips the build when the vendored converter is up to date", async () => {
    await runScript("ok");
    await fs.rm(recordPath);

    const { result, calls } = await runScript("ok");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("up to date");
    expect(calls).toEqual([]);
  });

  it("rebuilds with --force even when the vendored converter is up to date", async () => {
    await runScript("ok");
    await fs.rm(recordPath);

    const { result, calls } = await runScript("ok", "--force");

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map((call) => call.args[0])).toEqual([
      "install-scripts",
      "install",
      "run",
    ]);
  });

  it("rebuilds when the vendored converter no longer matches the pin", async () => {
    await runScript("ok");
    await fs.rm(recordPath);
    const metadataPath = path.join(vendorDir, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8")) as {
      commit: string;
    };
    metadata.commit = "0".repeat(40);
    await fs.writeFile(metadataPath, JSON.stringify(metadata));

    const { result, calls } = await runScript("ok");

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map((call) => call.args[0])).toContain("run");
    expect(
      (JSON.parse(await fs.readFile(metadataPath, "utf-8")) as { commit: string })
        .commit,
    ).toBe(pinnedCommit);
  });

  it("fails clearly when the converter devDependency is not installed", async () => {
    await fs.rm(converterDir, { recursive: true });

    const { result, calls } = await runScript("ok");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("devDependency");
    expect(result.stderr).toContain("npm ci");
    expect(calls).toEqual([]);
    await expect(fs.access(vendorDir)).rejects.toThrow();
  });

  it("fails before building when the installed converter is not the pinned commit", async () => {
    await writeInstalledLock("1".repeat(40));

    for (const scriptArgs of [[], ["--force"]]) {
      const { result, calls } = await runScript("ok", ...scriptArgs);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`at ${"1".repeat(40)}`);
      expect(result.stderr).toContain(`pins ${pinnedCommit}`);
      expect(result.stderr).toContain("npm ci");
      expect(calls).toEqual([]);
      await expect(fs.access(vendorDir)).rejects.toThrow();
    }
  });

  it("refuses to label a build whose installed commit cannot be determined", async () => {
    await fs.rm(path.join(root, "pkg", "node_modules", ".package-lock.json"));

    const { result, calls } = await runScript("ok");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown origin");
    expect(calls).toEqual([]);
  });

  it("does not rebuild a stale vendor directory over a mismatched install", async () => {
    await runScript("ok");
    await writeInstalledLock("2".repeat(40));
    await fs.rm(recordPath);

    const { result, calls } = await runScript("ok");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm ci");
    expect(calls).toEqual([]);
  });

  it("includes the notices of a reviewed asset the bundle embeds, with its license text", async () => {
    const bundle = fakeFontBundle(
      "Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) licensed under the SIL Open Font License, Version 1.1.",
    );

    const { result } = await runScriptWith("ok", { PREPARE_TEST_BUNDLE: bundle });

    expect(result.status, result.stderr).toBe(0);
    const notices = await fs.readFile(
      path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"),
      "utf-8",
    );
    expect(notices).toContain("Roboto fonts");
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("fails when the bundle embeds a font nothing covers", async () => {
    const bundle = fakeFontBundle("Some Other Font, proprietary");

    const { result } = await runScriptWith("ok", { PREPARE_TEST_BUNDLE: bundle });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("embedded font");
    expect(result.stderr).toContain("not covered");
    await expect(fs.access(vendorDir)).rejects.toThrow();
  });

  it("fails when a bundled dependency publishes no license file", async () => {
    await addDependency("no-license-dep", "2.0.0", "MIT", null);
    await fs.writeFile(
      path.join(converterDir, "package.json"),
      JSON.stringify({
        name: "@akmf/ksef-fe-invoice-converter",
        version: "1.2.3",
        dependencies: { "dep-a": "^1.0.0", "no-license-dep": "^2.0.0" },
      }),
    );

    const { result } = await runScript("ok");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no-license-dep@2.0.0");
    expect(result.stderr).toContain("publishes no license file");
    await expect(fs.access(vendorDir)).rejects.toThrow();
  });

  it("accepts a reviewed license-file exception and says so in the notices", async () => {
    await addDependency("fontkit", "2.0.4", "MIT", null, {
      author: "Devon Govett <devongovett@gmail.com>",
    });
    await fs.writeFile(
      path.join(converterDir, "package.json"),
      JSON.stringify({
        name: "@akmf/ksef-fe-invoice-converter",
        version: "1.2.3",
        dependencies: { fontkit: "^2.0.4" },
      }),
    );

    const { result } = await runScript("ok");

    expect(result.status, result.stderr).toBe(0);
    const notices = await fs.readFile(
      path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"),
      "utf-8",
    );
    expect(notices).toContain("fontkit@2.0.4");
    expect(notices).toContain("none published");
    expect(notices).toContain("Copyright (c) Devon Govett <devongovett@gmail.com>");
  });
});
