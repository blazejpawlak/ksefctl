import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// The PDF converter (`@akmf/ksef-fe-invoice-converter`) is a commit-pinned git
// devDependency. It is built at development time and its self-contained ESM
// bundle is vendored into a git-ignored directory that ships in the published
// package, so consumers never fetch git and never build it.
export const converterPackageName = "@akmf/ksef-fe-invoice-converter";
export const vendorDirName = path.join("vendor", "ksef-pdf-generator");
export const bundleFileName = "ksef-fe-invoice-converter.js";
export const licenseFileName = "LICENSE";
export const metadataFileName = "metadata.json";

const pinPattern = /^github:([^#\s]+\/[^#\s]+)#([0-9a-f]{40})$/;

export const vendorDir = (packageRoot) => path.join(packageRoot, vendorDirName);

export const sha256 = (content) =>
  createHash("sha256").update(content).digest("hex");

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf-8"));

// The pin is the devDependency spec, `github:<owner>/<repo>#<commit sha>`.
export const readPin = async (packageRoot) => {
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  const spec = packageJson.devDependencies?.[converterPackageName];
  const match = typeof spec === "string" ? spec.match(pinPattern) : null;
  if (!match) {
    throw new Error(
      `devDependencies["${converterPackageName}"] must be a commit-pinned github spec (github:<owner>/<repo>#<40-hex sha>), got ${JSON.stringify(spec)}`,
    );
  }
  return { source: match[1], commit: match[2] };
};

// The lockfile records what npm actually installed for the pin. It is optional
// (a source tarball may not carry it), so a missing entry is not an error.
const readLockedConverter = async (packageRoot) => {
  try {
    const lock = await readJson(path.join(packageRoot, "package-lock.json"));
    const entry = lock.packages?.[`node_modules/${converterPackageName}`];
    return entry ?? null;
  } catch {
    return null;
  }
};

export const readMetadata = async (packageRoot) =>
  readJson(path.join(vendorDir(packageRoot), metadataFileName));

// Returns the reasons the vendored copy cannot be shipped (empty when it can).
export const findVendorProblems = async (packageRoot) => {
  const dir = vendorDir(packageRoot);
  const problems = [];

  let bundle = null;
  for (const fileName of [bundleFileName, licenseFileName]) {
    try {
      const content = await fs.readFile(path.join(dir, fileName));
      if (content.length === 0) {
        problems.push(`${path.join(vendorDirName, fileName)} is empty`);
      } else if (fileName === bundleFileName) {
        bundle = content;
      }
    } catch {
      problems.push(`${path.join(vendorDirName, fileName)} is missing`);
    }
  }

  let metadata = null;
  try {
    metadata = await readMetadata(packageRoot);
  } catch {
    problems.push(
      `${path.join(vendorDirName, metadataFileName)} is missing or not valid JSON`,
    );
  }

  let pin = null;
  try {
    pin = await readPin(packageRoot);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (metadata && pin) {
    if (metadata.name !== converterPackageName) {
      problems.push(
        `metadata name ${JSON.stringify(metadata.name)} is not ${converterPackageName}`,
      );
    }
    if (metadata.commit !== pin.commit) {
      problems.push(
        `vendored converter commit ${String(metadata.commit)} does not match the devDependency pin ${pin.commit}`,
      );
    }
    if (typeof metadata.version !== "string" || metadata.version === "") {
      problems.push("metadata has no converter version");
    }
    const locked = await readLockedConverter(packageRoot);
    if (locked) {
      if (locked.version !== metadata.version) {
        problems.push(
          `vendored converter version ${String(metadata.version)} does not match package-lock.json (${String(locked.version)})`,
        );
      }
      const lockedCommit = String(locked.resolved ?? "").split("#")[1];
      if (lockedCommit && lockedCommit !== pin.commit) {
        problems.push(
          `package-lock.json resolves the converter to ${lockedCommit}, not the devDependency pin ${pin.commit}`,
        );
      }
    }
  }
  if (metadata && bundle && metadata.bundleSha256 !== sha256(bundle)) {
    problems.push(
      "vendored bundle does not match the checksum recorded in metadata.json",
    );
  }

  return problems;
};
