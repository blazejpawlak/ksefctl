import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The vendored converter bundle inlines its production dependencies (pdfmake,
// PDFKit, i18next, ...) and font/profile assets, none of which are delivered as
// packages any more. Their licenses require the notices to travel with the
// code, so THIRD_PARTY_NOTICES.txt is generated at vendoring time and shipped.

export const noticesFileName = "THIRD_PARTY_NOTICES.txt";

const assetsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "third-party-assets",
);

const licenseFilePattern = /^(licen[sc]e|notice|copying|copyright)/i;

// Packages that publish no license file, reviewed by hand: each declares the
// license below in its package.json and its upstream repository carries it. Any
// other bundled package without a license file fails the build.
export const licenseFileExceptions = {
  brotli: "MIT",
  dfa: "MIT",
  fontkit: "MIT",
  tr46: "MIT",
};

const mitTemplate = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf-8"));

const declaredLicense = (pkg) => {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => entry.type ?? String(entry)).join(" OR ");
  }
  return value?.type ?? "UNKNOWN";
};

const authorName = (pkg) =>
  typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? null);

const repositoryUrl = (pkg) =>
  typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? null);

// Node-style lookup, bounded by the converter root: the nested install puts the
// converter's dependencies under its own node_modules.
const resolveDependency = async (name, fromDir, boundary) => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      if (dir === boundary || dir === path.dirname(dir)) return null;
    }
  }
};

// The converter's production dependency tree, transitively, as the build
// resolved it. Optional dependencies are followed only when installed.
export const collectProductionDependencies = async (converterRoot) => {
  const found = new Map();
  const walk = async (dir) => {
    const pkg = await readJson(path.join(dir, "package.json"));
    const required = Object.keys(pkg.dependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    for (const name of [...required, ...optional]) {
      const resolved = await resolveDependency(name, dir, converterRoot);
      if (!resolved) {
        if (required.includes(name)) {
          throw new Error(
            `Cannot resolve ${name} (dependency of ${pkg.name}) under ${converterRoot}`,
          );
        }
        continue;
      }
      const depPkg = await readJson(path.join(resolved, "package.json"));
      const key = `${depPkg.name}@${depPkg.version}`;
      if (found.has(key)) continue;
      found.set(key, { dir: resolved, pkg: depPkg });
      await walk(resolved);
    }
  };
  await walk(converterRoot);

  const dependencies = [];
  const problems = [];
  for (const key of [...found.keys()].sort()) {
    const { dir, pkg } = found.get(key);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const texts = [];
    for (const file of files) {
      texts.push({ file, text: await fs.readFile(path.join(dir, file), "utf-8") });
    }
    const license = declaredLicense(pkg);
    if (texts.length === 0) {
      if (licenseFileExceptions[pkg.name] === license) {
        const holder = authorName(pkg);
        if (holder) {
          texts.push({
            file: "(none published; standard text for the license declared in package.json)",
            text: mitTemplate(holder),
          });
        }
      }
      if (texts.length === 0) {
        problems.push(
          `${key} (license ${license}) publishes no license file and is not a reviewed exception`,
        );
      }
    }
    dependencies.push({
      key,
      license,
      author: authorName(pkg),
      repository: repositoryUrl(pkg),
      texts,
    });
  }
  return { dependencies, problems };
};

const base64Blob = /["'`]([A-Za-z0-9+/]{400,}={0,2})["'`]/g;

const classifyBlob = (bytes) => {
  const magic = bytes.subarray(0, 4).toString("latin1");
  if (
    magic === "\x00\x01\x00\x00" ||
    ["OTTO", "ttcf", "true", "wOFF", "wOF2"].includes(magic)
  ) {
    return "font";
  }
  if (bytes.subarray(36, 40).toString("latin1") === "acsp") return "icc-profile";
  if (
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ||
    magic.startsWith("GIF8")
  ) {
    return "image";
  }
  return null;
};

// Reviewed font/profile assets. Each matcher recognises the asset from its own
// embedded identification, so a different font or profile cannot pass as one of
// these.
const reviewedAssets = [
  {
    id: "Roboto",
    kind: "font",
    matches: (text) =>
      text.includes("The Roboto Project Authors") &&
      text.includes("SIL Open Font License, Version 1.1"),
    heading: "Roboto fonts (pdfmake's built-in virtual file system)",
    license: "OFL-1.1",
    textFile: "roboto-OFL-1.1.txt",
  },
  {
    id: "sRGB2014",
    kind: "icc-profile",
    matches: (text) =>
      text.includes("sRGB2014") &&
      text.includes("Copyright International Color Consortium"),
    heading: "sRGB2014 ICC color profile (PDFKit)",
    license: "ICC profile terms",
    textFile: "icc-profile-terms.txt",
  },
];

// Fonts, color profiles and images embedded as base64 in the bundle. Returns
// the reviewed assets found (with their license text) and the ones nothing
// covers.
export const detectEmbeddedAssets = async (bundle) => {
  const source = Buffer.isBuffer(bundle) ? bundle.toString("utf-8") : bundle;
  const found = new Map();
  const unreviewed = [];
  for (const match of source.matchAll(base64Blob)) {
    const bytes = Buffer.from(match[1], "base64");
    const kind = classifyBlob(bytes);
    if (!kind) continue;
    // Name tables and profile headers hold their strings as 8- or 16-bit text.
    const text = bytes.toString("latin1").replaceAll("\0", "");
    const asset = reviewedAssets.find(
      (candidate) => candidate.kind === kind && candidate.matches(text),
    );
    if (asset) {
      found.set(asset.id, asset);
    } else {
      unreviewed.push(`embedded ${kind} (${bytes.length} bytes) is not covered by the reviewed third-party assets`);
    }
  }
  const assets = [];
  for (const asset of [...found.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    assets.push({
      ...asset,
      text: await fs.readFile(path.join(assetsDir, asset.textFile), "utf-8"),
    });
  }
  return { assets, problems: [...new Set(unreviewed)] };
};

export const renderNotices = ({ converter, dependencies, assets }) => {
  const rule = "=".repeat(78);
  const parts = [
    `THIRD-PARTY NOTICES

The vendored PDF converter (${converter.name} ${converter.version}, built from
${converter.source}@${converter.commit}) is a single ESM bundle that inlines
its production dependencies and some font/profile assets. The notices of that
material follow. The converter's own license is in LICENSE next to this file.

Part 1 lists the converter's production dependency tree as it was resolved for
the build; tree-shaking may have left some of it out of the bundle. Part 2
lists the fonts and profiles embedded in the bundle.`,
    `${rule}\nPART 1: PRODUCTION DEPENDENCIES\n${rule}`,
  ];
  for (const dep of dependencies) {
    const lines = [
      dep.key,
      dep.license === "UNKNOWN"
        ? "License: not declared in package.json (see the license file below)"
        : `License: ${dep.license}`,
    ];
    if (dep.author) lines.push(`Author: ${dep.author}`);
    if (dep.repository) lines.push(`Repository: ${dep.repository}`);
    for (const { file, text } of dep.texts) {
      lines.push("", `--- ${file} ---`, text.trimEnd());
    }
    parts.push(lines.join("\n"));
  }
  parts.push(`${rule}\nPART 2: EMBEDDED ASSETS\n${rule}`);
  for (const asset of assets) {
    parts.push(
      [`${asset.heading}`, `License: ${asset.license}`, "", asset.text.trimEnd()].join(
        "\n",
      ),
    );
  }
  if (assets.length === 0) parts.push("(none)");
  return `${parts.join(`\n\n${"-".repeat(78)}\n\n`)}\n`;
};

// Everything the notices need, or the reasons they cannot be produced.
export const buildNotices = async ({ converterRoot, converter, bundle }) => {
  const { dependencies, problems } = await collectProductionDependencies(converterRoot);
  const embedded = await detectEmbeddedAssets(bundle);
  const allProblems = [...problems, ...embedded.problems];
  if (allProblems.length > 0) {
    throw new Error(
      `Cannot produce third-party notices:\n${allProblems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
  return {
    text: renderNotices({ converter, dependencies, assets: embedded.assets }),
    assetHeadings: embedded.assets.map((asset) => asset.heading),
  };
};
