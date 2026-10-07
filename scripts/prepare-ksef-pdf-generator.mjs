import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const converterPath = path.join("node_modules", "@akmf", "ksef-fe-invoice-converter");

// Walk up from this package like Node's resolver does: in a repository
// checkout or a global install the converter is nested under this package,
// but npm may hoist it to a parent node_modules when ksefctl is a dependency.
const findConverterRoot = async () => {
  let dir = path.join(scriptDir, "..");
  for (;;) {
    const candidate = path.join(dir, converterPath);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`Cannot find ${converterPath} above ${scriptDir}`);
      }
      dir = parent;
    }
  }
};
const filesToCopy = [
  "ksef-fe-invoice-converter.js",
  "ksef-fe-invoice-converter.umd.cjs",
  "index.d.ts",
];

// npm 11 gates dependency install scripts behind an allowlist. The converter is
// installed as its own project, so the root package.json allowScripts does not
// apply; its Vite build needs esbuild's postinstall (fsevents is macOS-only).
const converterAllowedScripts = ["esbuild", "fsevents"];

// The converter's own install and build print upstream warnings (its dev
// dependencies, Vite and declaration output) that ksefctl cannot act on. They
// go to a log file; it is printed only when a step fails.
const logFileName = "ksefctl-prepare.log";
const failureTailLines = 80;

// The converter must be installed as a local project with its dev dependencies,
// whatever mode the outer install runs in. During `npm install --global` npm
// exports npm_config_global=true (plus prefix and location) to lifecycle
// scripts, which would make the nested `npm install` put the converter into the
// global prefix instead, and production installs omit the devDependencies the
// build needs. The README's `--allow-scripts=...` is exported too, and npm 11
// rejects it in a project-scoped install (EALLOWSCRIPTS); dropping it also lets
// the converter's own .npmrc allowlist govern rather than a blanket
// --dangerously-allow-all-scripts. Registry, auth, proxy and cache settings are
// left inherited.
const inheritedInstallModeVariables = new Set([
  "npm_config_global",
  "npm_config_location",
  "npm_config_prefix",
  "npm_config_local_prefix",
  "npm_config_omit",
  "npm_config_only",
  "npm_config_production",
  "npm_config_dev",
  "npm_config_allow_scripts",
  "npm_config_dangerously_allow_all_scripts",
]);
const localInstallEnv = () => {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!inheritedInstallModeVariables.has(name.toLowerCase().replaceAll("-", "_"))) {
      env[name] = value;
    }
  }
  if (env.NODE_ENV === "production") {
    delete env.NODE_ENV;
  }
  return env;
};
const localInstallFlags = ["--global=false", "--location=project", "--include=dev"];

const runLogged = async (command, args, cwd, logPath) => {
  const result = spawnSync(command, args, {
    cwd,
    env: localInstallEnv(),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  await fs.appendFile(
    logPath,
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`,
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
    );
  }
};

// npm versions without allowScripts warn about an unknown "allow-scripts"
// config key, so only write it where npm understands it. Only an unknown
// command means "unsupported": any other probe failure is left for the install
// step to report rather than silently dropping the allowlist.
const supportsAllowScripts = (cwd) => {
  const probe = spawnSync(
    "npm",
    ["install-scripts", "ls", ...localInstallFlags],
    { cwd, env: localInstallEnv(), encoding: "utf-8" },
  );
  return !(
    probe.status !== 0 &&
    /unknown command/i.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`)
  );
};

const writeAllowScriptsConfig = async (packageRoot) => {
  const npmrcPath = path.join(packageRoot, ".npmrc");
  if (!supportsAllowScripts(packageRoot)) {
    await fs.rm(npmrcPath, { force: true });
    return;
  }
  await fs.writeFile(
    npmrcPath,
    converterAllowedScripts.map((name) => `allow-scripts[]=${name}\n`).join(""),
  );
};

const copyArtifacts = async (packageRoot) => {
  for (const fileName of filesToCopy) {
    await fs.copyFile(
      path.join(packageRoot, "dist", fileName),
      path.join(packageRoot, fileName),
    );
  }
};

const printLogTail = async (logPath) => {
  try {
    const lines = (await fs.readFile(logPath, "utf-8")).trimEnd().split("\n");
    console.error(lines.slice(-failureTailLines).join("\n"));
  } catch {
    // The log is best-effort context; the error message is reported anyway.
  }
};

const run = async () => {
  const packageRoot = await findConverterRoot();
  const logPath = path.join(packageRoot, logFileName);
  await fs.writeFile(logPath, "");
  try {
    await writeAllowScriptsConfig(packageRoot);
    await runLogged(
      "npm",
      [
        "install",
        "--package-lock=false",
        "--no-fund",
        "--no-audit",
        ...localInstallFlags,
      ],
      packageRoot,
      logPath,
    );
    await runLogged(
      "npm",
      ["run", "build", "--global=false", "--location=project"],
      packageRoot,
      logPath,
    );
    await copyArtifacts(packageRoot);
  } catch (error) {
    await printLogTail(logPath);
    console.error(`Full log: ${logPath}`);
    throw error;
  }
  const { version } = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf-8"),
  );
  console.log(
    `Prepared @akmf/ksef-fe-invoice-converter ${version} (build log: ${logPath})`,
  );
};

run().catch((error) => {
  console.error("Failed to prepare ksef-pdf-generator artifacts");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
