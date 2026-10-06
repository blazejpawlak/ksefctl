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

const runCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    return;
  }
  if (result.error) {
    throw result.error;
  }
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
};

const copyArtifacts = async (packageRoot) => {
  for (const fileName of filesToCopy) {
    await fs.copyFile(
      path.join(packageRoot, "dist", fileName),
      path.join(packageRoot, fileName),
    );
  }
};

const run = async () => {
  const packageRoot = await findConverterRoot();
  await fs.writeFile(
    path.join(packageRoot, ".npmrc"),
    converterAllowedScripts.map((name) => `allow-scripts[]=${name}\n`).join(""),
  );
  runCommand(
    "npm",
    ["install", "--package-lock=false", "--no-fund", "--no-audit"],
    packageRoot,
  );
  runCommand("npm", ["run", "build"], packageRoot);
  await copyArtifacts(packageRoot);
};

run().catch((error) => {
  console.error("Failed to prepare ksef-pdf-generator artifacts");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
