import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(
  scriptDir,
  "..",
  "node_modules",
  "@akmf",
  "ksef-fe-invoice-converter",
);
const filesToCopy = [
  "ksef-fe-invoice-converter.js",
  "ksef-fe-invoice-converter.umd.cjs",
  "index.d.ts",
];

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

const copyArtifacts = async () => {
  for (const fileName of filesToCopy) {
    await fs.copyFile(
      path.join(packageRoot, "dist", fileName),
      path.join(packageRoot, fileName),
    );
  }
};

const run = async () => {
  await fs.access(packageRoot);
  runCommand(
    "npm",
    ["install", "--package-lock=false", "--no-fund", "--no-audit"],
    packageRoot,
  );
  runCommand("npm", ["run", "build"], packageRoot);
  await copyArtifacts();
};

run().catch((error) => {
  console.error("Failed to prepare ksef-pdf-generator artifacts");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
