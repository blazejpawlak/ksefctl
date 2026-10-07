import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The vendored converter bundle inlines every module it imports, including
// prebuilt browser bundles (pdfmake's build/pdfmake.js already contains PDFKit,
// core-js, FileSaver, SVG-to-PDFKit and Node polyfills) and some font/profile
// assets. None of that is delivered as packages any more, and the licenses
// require the notices to travel with the code, so THIRD_PARTY_NOTICES.txt is
// generated at vendoring time from what the bundle really contains and shipped.
//
// The inventory comes from source maps, not from the declared dependency tree:
// the converter is built with a (hidden) map listing every input module, and a
// prebuilt input that ships its own .map is expanded recursively. Every module
// must resolve to a package or reviewed component with a non-empty license
// text, from the installed package or from the reviewed inventory in
// scripts/third-party/. Anything else fails the build and the prepack guard.

export const noticesFileName = "THIRD_PARTY_NOTICES.txt";

const thirdPartyDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "third-party",
);

const licenseFilePattern = /^(licen[sc]e|notice|copying|copyright)/i;

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf-8"));

const exists = (filePath) =>
  fs.access(filePath).then(
    () => true,
    () => false,
  );

// Reviewed license texts for components that are bundled but not installed (or
// installed without a license file): name -> { license, version, source, file }.
const loadInventory = async () => {
  try {
    return (await readJson(path.join(thirdPartyDir, "inventory.json"))).components;
  } catch {
    return {};
  }
};

const declaredLicense = (pkg) => {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => entry.type ?? String(entry)).join(" OR ");
  }
  return value?.type ?? null;
};

const repositoryUrl = (pkg) =>
  typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? null);

// The last `node_modules/<name>` segment of a path: the package a module
// belongs to, however deeply the bundler nested it.
const packageOfPath = (modulePath) => {
  const segments = [...modulePath.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  return { name: last[1], end: last.index + last[0].length };
};

// Node-style lookup bounded by the converter root.
const installedDir = async (name, fromDir, boundary) => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
    if (dir === boundary || dir === path.dirname(dir)) return null;
  }
};

const readLicenseFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const texts = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && licenseFilePattern.test(entry.name)) {
      texts.push({
        file: entry.name,
        text: await fs.readFile(path.join(dir, entry.name), "utf-8"),
      });
    }
  }
  return texts;
};

// Source maps list plain paths; webpack maps prefix them with
// webpack://<namespace>/.
const stripWebpackPrefix = (source) => source.replace(/^webpack:\/\/[^/]*\//, "");

// Collects the components of the bundle: a map of component name to
// { name, version, license, source, origins, texts }, and the problems found.
export const inventoryComponents = async ({ converterRoot, mapPath }) => {
  const inventory = await loadInventory();
  const components = new Map();
  const problems = [];
  const distDir = path.dirname(mapPath);

  const add = async (name, { dir, origin, extraTexts, version, license }) => {
    let component = components.get(name);
    if (!component) {
      component = { name, version: null, license: null, source: null, origins: new Set(), texts: [] };
      components.set(name, component);
      if (dir && (await exists(path.join(dir, "package.json")))) {
        const pkg = await readJson(path.join(dir, "package.json"));
        component.version = pkg.version ?? null;
        component.license = declaredLicense(pkg);
        component.source = repositoryUrl(pkg);
      }
      const installedTexts =
        extraTexts ?? (dir && (await exists(dir)) ? await readLicenseFiles(dir) : []);
      let texts = installedTexts.filter(({ text }) => text.trim().length > 0);
      const reviewed = inventory[name];
      if (texts.length === 0 && reviewed) {
        const text = await fs
          .readFile(path.join(thirdPartyDir, "licenses", reviewed.file), "utf-8")
          .catch(() => "");
        if (text.trim().length > 0) {
          texts = [
            {
              file: `reviewed copy of ${reviewed.source}${reviewed.note ? ` (${reviewed.note})` : ""}`,
              text,
            },
          ];
        }
        component.version ??= `${reviewed.version} (as reviewed)`;
        component.license ??= reviewed.license;
        component.source ??= reviewed.source;
      }
      component.version ??= version ?? null;
      component.license ??= license ?? null;
      if (texts.length === 0) {
        problems.push(
          `${name} is bundled but has no non-empty license text (installed package or reviewed entry in scripts/third-party/inventory.json)`,
        );
      }
      component.texts = texts;
    }
    component.origins.add(origin);
  };

  // Expands a prebuilt input that ships its own source map.
  const expand = async (file, hostName, hostDir) => {
    const prebuilt = await readJson(`${file}.map`);
    const origin = `inside ${hostName}'s prebuilt ${path.basename(file)}`;
    const contents = prebuilt.sourcesContent ?? [];
    for (const [index, rawSource] of prebuilt.sources.entries()) {
      const source = stripWebpackPrefix(rawSource);
      const owner = packageOfPath(source);
      if (owner) {
        await add(owner.name, {
          dir: await installedDir(owner.name, hostDir, converterRoot),
          origin,
        });
      } else if (/^\.\/src\/3rd-party\/svg-to-pdfkit(\.js|\/|$)/.test(source)) {
        // pdfmake vendors SVG-to-PDFKit and ships its license next to it.
        const dir = path.join(hostDir, "src", "3rd-party", "svg-to-pdfkit");
        await add("svg-to-pdfkit", {
          dir: null,
          origin,
          extraTexts: (await exists(dir)) ? await readLicenseFiles(dir) : [],
          version: `vendored in ${hostName}`,
          license: "MIT",
        });
      } else if (source.startsWith("./src/")) {
        await add(hostName, { dir: hostDir, origin });
      } else if (source.startsWith("webpack/")) {
        await add("webpack", { dir: null, origin });
      } else if ((contents[index] ?? "").trim() === "") {
        // An empty module contributes no code.
      } else {
        problems.push(
          `${origin}: cannot attribute module ${rawSource} to a package or reviewed component`,
        );
      }
    }
  };

  const map = await readJson(mapPath);
  for (const rawSource of map.sources) {
    const file = path.resolve(distDir, map.sourceRoot ?? "", rawSource);
    const relative = path.relative(converterRoot, file);
    const owner = packageOfPath(relative);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      problems.push(`cannot attribute bundled module ${rawSource} to the converter or a package`);
    } else if (!owner || !relative.startsWith(`node_modules${path.sep}`)) {
      // The converter's own source; its license ships as LICENSE.
    } else {
      const packagePath = relative.slice(0, owner.end);
      const dir = path.join(converterRoot, packagePath);
      await add(owner.name, { dir, origin: "bundled directly" });
      if (await exists(`${file}.map`)) {
        const pkg = await readJson(path.join(dir, "package.json"));
        await expand(file, pkg.name ?? owner.name, dir);
      }
    }
  }
  return { components, problems };
};

const dataUrl = /data:([A-Za-z0-9.+/-]*)((?:;[A-Za-z0-9.+=/-]+)*),([^"'`\s)\\]+)/g;
const base64Literal = /["'`]([A-Za-z0-9+/]{8,}={0,2})["'`]/g;
const textMediaType = /^(text\/.*|application\/(json|javascript|xml|x-www-form-urlencoded))$/i;

const classifyBytes = (bytes) => {
  const magic = bytes.subarray(0, 4).toString("latin1");
  if (
    magic === "\x00\x01\x00\x00" ||
    ["OTTO", "ttcf", "true", "wOFF", "wOF2"].includes(magic)
  ) {
    return "font";
  }
  if (bytes.length >= 40 && bytes.subarray(36, 40).toString("latin1") === "acsp") {
    return "icc-profile";
  }
  if (
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ||
    magic.startsWith("GIF8") ||
    (magic === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
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

// Second line of defence next to the module inventory: fonts, color profiles
// and images embedded as data in the bundle, as data: URLs of any media type or
// as bare base64 string literals of any length. Each must match a reviewed
// asset; the reviewed ones come back with their license text.
export const detectEmbeddedAssets = async (bundle) => {
  const source = Buffer.isBuffer(bundle) ? bundle.toString("utf-8") : bundle;
  const found = new Map();
  const unreviewed = new Set();

  const review = (bytes, label) => {
    const kind = classifyBytes(bytes);
    if (!kind) return false;
    // Name tables and profile headers hold their strings as 8- or 16-bit text.
    const text = bytes.toString("latin1").replaceAll("\0", "");
    const asset = reviewedAssets.find(
      (candidate) => candidate.kind === kind && candidate.matches(text),
    );
    if (asset) {
      found.set(asset.id, asset);
    } else {
      unreviewed.add(
        `embedded ${kind} (${bytes.length} bytes${label}) is not covered by the reviewed third-party assets`,
      );
    }
    return true;
  };

  for (const match of source.matchAll(dataUrl)) {
    const [, mediaType, parameters, payload] = match;
    const bytes = parameters.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(
          decodeURIComponent(payload.replace(/%(?![0-9a-f]{2})/gi, "%25")),
          "latin1",
        );
    if (review(bytes, ` in a ${mediaType || "typeless"} data: URL`)) continue;
    if (!textMediaType.test(mediaType)) {
      unreviewed.add(
        `data: URL of media type ${mediaType || "(none)"} (${bytes.length} bytes) is not covered by the reviewed third-party assets`,
      );
    }
  }
  for (const match of source.matchAll(base64Literal)) {
    review(Buffer.from(match[1], "base64"), "");
  }

  const assets = [];
  for (const asset of [...found.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    assets.push({
      ...asset,
      text: await fs.readFile(path.join(thirdPartyDir, "assets", asset.textFile), "utf-8"),
    });
  }
  return { assets, problems: [...unreviewed] };
};

const componentHeading = (component) =>
  `### ${component.name}@${component.version ?? "unknown version"}`;

export const renderNotices = ({ converter, components, assets }) => {
  const rule = "=".repeat(78);
  const parts = [
    `THIRD-PARTY NOTICES

The vendored PDF converter (${converter.name} ${converter.version}, built from
${converter.source}@${converter.commit}) is a single ESM bundle that inlines
every module it imports, including prebuilt browser bundles that carry their
own dependencies. The converter's own license is in LICENSE next to this file.

Part 1 lists every package or component whose code the bundle contains, taken
from the build's source maps (and from the source map of each prebuilt input
that ships one). Part 2 lists the fonts and profiles embedded in the bundle.
Where a component is not installed, the license text is the reviewed copy
checked in with the converter's build scripts; its version is the one reviewed,
not necessarily the one inlined.`,
    `${rule}\nPART 1: BUNDLED CODE\n${rule}`,
  ];
  for (const component of [...components.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const lines = [
      componentHeading(component),
      `License: ${component.license ?? "not declared (see the license text below)"}`,
      `Included: ${[...component.origins].sort().join("; ")}`,
    ];
    if (component.source) lines.push(`Source: ${component.source}`);
    for (const { file, text } of component.texts) {
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
export const buildNotices = async ({ converterRoot, converter, bundle, mapPath }) => {
  const { components, problems } = await inventoryComponents({ converterRoot, mapPath });
  const embedded = await detectEmbeddedAssets(bundle);
  const allProblems = [...problems, ...embedded.problems];
  if (allProblems.length > 0) {
    throw new Error(
      `Cannot produce third-party notices:\n${allProblems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
  return {
    text: renderNotices({ converter, components, assets: embedded.assets }),
    components: [...components.values()].map(componentHeading).sort(),
  };
};

// Checks a notices file the way the prepack guard needs to: every component
// recorded at build time has a section with non-empty license text.
export const findNoticesProblems = (notices, componentHeadings) => {
  const problems = [];
  const sections = new Map();
  for (const block of notices.split(/^(?=### )/m)) {
    const heading = block.split("\n", 1)[0];
    if (heading.startsWith("### ")) sections.set(heading.trim(), block);
  }
  for (const heading of componentHeadings) {
    const block = sections.get(heading);
    if (!block) {
      problems.push(`${noticesFileName} has no section for ${heading.slice(4)}`);
      continue;
    }
    const license = block
      .split(/^--- .* ---$/m)
      .slice(1)
      .map((part) => part.split("\n----------")[0])
      .join("");
    if (license.trim().length === 0) {
      problems.push(`${noticesFileName} has no license text for ${heading.slice(4)}`);
    }
  }
  return problems;
};
