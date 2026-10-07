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

const runLogged = async (command, args, cwd, logPath) => {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
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
// config key, so only write it where npm understands it.
const supportsAllowScripts = (cwd) =>
  spawnSync("npm", ["install-scripts", "ls"], { cwd, stdio: "ignore" })
    .status === 0;

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
      ["install", "--package-lock=false", "--no-fund", "--no-audit"],
      packageRoot,
      logPath,
    );
    await runLogged("npm", ["run", "build"], packageRoot, logPath);
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
