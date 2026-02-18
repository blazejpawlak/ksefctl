const fs = require("node:fs/promises");
const path = require("node:path");

const packageRoot = path.join(
  process.cwd(),
  "node_modules",
  "@akmf",
  "ksef-fe-invoice-converter",
);
const distRoot = path.join(packageRoot, "dist");

const files = [
  "ksef-fe-invoice-converter.js",
  "ksef-fe-invoice-converter.umd.cjs",
  "index.d.ts",
];

const ensureFile = async (sourcePath, targetPath) => {
  await fs.copyFile(sourcePath, targetPath);
};

const run = async () => {
  await fs.access(distRoot);
  await Promise.all(
    files.map((file) =>
      ensureFile(path.join(distRoot, file), path.join(packageRoot, file)),
    ),
  );
};

run().catch((error) => {
  console.error("Failed to prepare ksef-pdf-generator artifacts");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
