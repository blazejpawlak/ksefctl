import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectEmbeddedAssets, noticesFileName } from "./third-party-notices.mjs";

// The PDF converter (`@akmf/ksef-fe-invoice-converter`) is a commit-pinned git
// devDependency. It is built at development time and its self-contained ESM
// bundle is vendored into a git-ignored directory that ships in the published
// package, so consumers never fetch git and never build it.
export const converterPackageName = "@akmf/ksef-fe-invoice-converter";
export const vendorDirName = path.join("vendor", "ksef-pdf-generator");
export const bundleFileName = "ksef-fe-invoice-converter.js";
export const licenseFileName = "LICENSE";
export const metadataFileName = "metadata.json";
export { noticesFileName };

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

// The commit npm actually installed for the converter, read from the hidden
// lockfile npm writes into node_modules (or, failing that, from the converter's
// own package.json). Null when it cannot be determined, e.g. no node_modules.
export const readInstalledCommit = async (packageRoot) => {
  const modules = path.join(packageRoot, "node_modules");
  const fromSpec = (value) => {
    const commit = String(value ?? "").split("#")[1];
    return /^[0-9a-f]{40}$/.test(commit ?? "") ? commit : null;
  };
  try {
    const lock = await readJson(path.join(modules, ".package-lock.json"));
    const entry = lock.packages?.[`node_modules/${converterPackageName}`];
    const commit = fromSpec(entry?.resolved);
    if (commit) return commit;
  } catch {
    // Fall through to the converter's own package.json.
  }
  try {
    const pkg = await readJson(
      path.join(modules, ...converterPackageName.split("/"), "package.json"),
    );
    return (
      (/^[0-9a-f]{40}$/.test(pkg.gitHead ?? "") ? pkg.gitHead : null) ??
      fromSpec(pkg._resolved)
    );
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
  let notices = null;
  for (const fileName of [bundleFileName, licenseFileName, noticesFileName]) {
    try {
      const content = await fs.readFile(path.join(dir, fileName));
      if (content.length === 0) {
        problems.push(`${path.join(vendorDirName, fileName)} is empty`);
      } else if (fileName === bundleFileName) {
        bundle = content;
      } else if (fileName === noticesFileName) {
        notices = content.toString("utf-8");
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
  if (metadata && notices !== null && metadata.noticesSha256 !== sha256(notices)) {
    problems.push(
      `${noticesFileName} does not match the checksum recorded in metadata.json`,
    );
  }
  // The notices must cover every font/profile the bundle embeds.
  if (bundle && notices !== null) {
    const embedded = await detectEmbeddedAssets(bundle);
    problems.push(...embedded.problems);
    for (const asset of embedded.assets) {
      if (!notices.includes(asset.heading)) {
        problems.push(`${noticesFileName} has no notice for embedded ${asset.id}`);
      }
    }
  }
  // The pin is what the vendored code claims to be built from; check that the
  // converter npm installed really is that commit. Without node_modules (a
  // consumer-style tree) there is nothing to compare.
  if (pin) {
    const installed = await readInstalledCommit(packageRoot);
    if (installed && installed !== pin.commit) {
      problems.push(
        `the installed converter is at ${installed}, not the devDependency pin ${pin.commit}; run npm ci`,
      );
    }
  }

  return problems;
};
