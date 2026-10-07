import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptSource = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "prepare-ksef-pdf-generator.mjs",
);

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
  for (const name of ["ksef-fe-invoice-converter.js", "ksef-fe-invoice-converter.umd.cjs", "index.d.ts"]) {
    fs.writeFileSync("dist/" + name, "");
  }
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
  let converterDir: string;
  let recordPath: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-prepare-")));
    converterDir = path.join(root, "pkg", "node_modules", "@akmf", "ksef-fe-invoice-converter");
    recordPath = path.join(root, "calls.jsonl");
    await fs.mkdir(path.join(root, "pkg", "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "bin"));
    await fs.mkdir(converterDir, { recursive: true });
    await fs.copyFile(
      scriptSource,
      path.join(root, "pkg", "scripts", "prepare-ksef-pdf-generator.mjs"),
    );
    await fs.writeFile(path.join(converterDir, "package.json"), "{\"version\":\"0.0.0\"}");
    await fs.writeFile(path.join(root, "bin", "npm"), stubNpm, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const runScript = async (probe: string) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "pkg", "scripts", "prepare-ksef-pdf-generator.mjs")],
      {
        encoding: "utf-8",
        env: {
          PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          PREPARE_TEST_RECORD: recordPath,
          PREPARE_TEST_PROBE: probe,
          ...outerEnv,
        },
      },
    );
    const calls = (await fs.readFile(recordPath, "utf-8"))
      .trimEnd()
      .split("\n")
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
    await expect(
      fs.access(path.join(converterDir, "ksef-fe-invoice-converter.js")),
    ).resolves.toBeUndefined();
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
});
