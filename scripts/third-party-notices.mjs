import { createHash } from "node:crypto";
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

// Bump when the generator's output or checks change, so vendor directories
// produced by an older generator are rebuilt by prepare and rejected by the
// prepack guard even though the converter pin did not change.
export const noticesGeneratorVersion = 1;

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

// Reviewed data in scripts/third-party/inventory.json:
//  - components: name -> { license, version, source, file, note? }: license
//    texts for components that are bundled but not installed (or installed
//    without a license file);
//  - headerAllowlist: [{ component, contains, reason }]: file-level license
//    headers reviewed as already covered;
//  - headerLicenses: [{ component, contains, license, file, source, reason }]:
//    file-level headers that name no usable license; `file` (under
//    scripts/third-party/) is the reviewed license text that applies to them;
//  - prebuiltInputs: "<package>/<path>" -> { sha256, components }: the
//    components of a prebuilt input whose own source map is unavailable, bound
//    to that exact file's sha256.
const loadInventory = async () => {
  try {
    const inventory = await readJson(path.join(thirdPartyDir, "inventory.json"));
    return {
      components: inventory.components ?? {},
      headerAllowlist: inventory.headerAllowlist ?? [],
      headerLicenses: inventory.headerLicenses ?? [],
      prebuiltInputs: inventory.prebuiltInputs ?? {},
    };
  } catch {
    return { components: {}, headerAllowlist: [], headerLicenses: [], prebuiltInputs: {} };
  }
};

export const collapse = (text) => text.replace(/\s+/g, " ").trim();

// Reviewed full license texts by SPDX id, for licenses that file-level headers
// invoke but the component's own license does not carry.
export const readThirdPartyText = async (relativePath) => {
  const file = path.resolve(thirdPartyDir, relativePath);
  if (!file.startsWith(`${thirdPartyDir}${path.sep}`)) return null;
  try {
    const text = await fs.readFile(file, "utf-8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
};

export const spdxFile = (id) => (/^[A-Za-z0-9.+-]+$/.test(id) ? `spdx/${id}.txt` : null);

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

const sha256Hex = (content) => createHash("sha256").update(content).digest("hex");

// An input that is itself a bundle: its inner modules need their own map.
const prebuiltMarkers =
  /\/\/# sourceMappingURL=|__webpack_require__|webpackUniversalModuleDefinition|webpackBootstrap/;

const shippedMarkers = {
  "BSD-3-Clause": /Redistribution and use in source and binary forms[\s\S]{0,1500}Neither the name/i,
  "BSD-2-Clause": /Redistribution and use in source and binary forms[\s\S]{0,1200}THIS SOFTWARE IS PROVIDED/i,
  "Apache-2.0": /Apache License,?\s+Version 2\.0/i,
  MIT: /Permission is hereby granted, free of charge/i,
  ISC: /Permission to use, copy, modify, and\/or distribute/i,
};

// File-level license headers: comments that carry a copyright line, a license
// tag, an SPDX identifier, license wording or a /*! banner. Comments come from
// a real JavaScript tokenizer, so string literals that merely look like
// comments are not headers; the triggers are case-insensitive.
const isLicenseHeader = (comment, banner) =>
  banner ||
  /copyright\s*(?:\(c\)|©)/i.test(comment) ||
  /copyright\s+\d{4}/i.test(comment) ||
  /Copyright\s+[A-Z]/.test(comment) ||
  /@license|@preserve|spdx-license-identifier|licensed under|permission is hereby granted/i.test(
    comment,
  );

// The comments of a module, with consecutive line comments joined, taken from
// the TypeScript compiler's parser (already a devDependency; it reads plain
// JavaScript, TypeScript and decorator syntax alike). Every comment is leading
// trivia of exactly one token, so walking the tokens finds each comment once
// and never mistakes the inside of a string, template or regular expression for
// one. JSON has no comments.
const extractComments = async (content, name) => {
  if (/\.json$/i.test(name)) return [];
  const { default: ts } = await import("typescript");
  const kind = /\.tsx$/i.test(name)
    ? ts.ScriptKind.TSX
    : /\.(?:[cm]?ts)$/i.test(name)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, false, kind);
  const seen = new Set();
  const comments = [];
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    for (const range of ts.getLeadingCommentRanges(content, node.pos) ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const block = range.kind === ts.SyntaxKind.MultiLineCommentTrivia;
      comments.push({
        block,
        text: content.slice(range.pos + 2, block ? range.end - 2 : range.end),
        start: range.pos,
        end: range.end,
      });
    }
  };
  visit(sourceFile);
  comments.sort((a, b) => a.start - b.start);
  const groups = [];
  for (const comment of comments) {
    const previous = groups[groups.length - 1];
    if (
      !comment.block &&
      previous &&
      !previous.block &&
      /^[ \t]*\r?\n[ \t]*$/.test(content.slice(previous.end, comment.start))
    ) {
      previous.text += `\n${comment.text}`;
      previous.end = comment.end;
    } else {
      groups.push({ ...comment });
    }
  }
  return groups;
};

const extractHeaders = async (content, name) => {
  const comments = await extractComments(content, name);
  const headers = [];
  for (const comment of comments) {
    const banner = comment.block && comment.text.startsWith("!");
    const text = comment.text
      .split("\n")
      .map((line) => (comment.block ? line.replace(/^\s*\*(?!\/)[ \t]?/, "") : line.replace(/^ /, "")))
      .join("\n")
      .replace(/^!/, "")
      .trim();
    if (text && isLicenseHeader(text, banner)) headers.push(text);
  }
  return headers;
};

// Parses a complete SPDX license expression (AND, OR, WITH, parentheses) and
// returns every license and exception id in it; throws on anything it cannot
// parse, so an expression is never reduced to its first token.
const parseSpdxExpression = (expression) => {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+:-]+/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error(`unsupported characters in license expression "${expression}"`);
  }
  const ids = new Set();
  let position = 0;
  const operators = new Set(["AND", "OR", "WITH"]);
  const identifier = () => {
    const token = tokens[position];
    if (token === undefined || token === "(" || token === ")" || operators.has(token)) {
      throw new Error(`expected a license id in "${expression}"`);
    }
    position += 1;
    return token;
  };
  const primary = () => {
    if (tokens[position] === "(") {
      position += 1;
      or();
      if (tokens[position] !== ")") throw new Error(`unbalanced parentheses in "${expression}"`);
      position += 1;
      return;
    }
    ids.add(identifier());
    if (tokens[position] === "WITH") {
      position += 1;
      ids.add(identifier());
    }
  };
  const and = () => {
    primary();
    while (tokens[position] === "AND") {
      position += 1;
      primary();
    }
  };
  const or = () => {
    and();
    while (tokens[position] === "OR") {
      position += 1;
      and();
    }
  };
  if (tokens.length === 0) throw new Error("empty license expression");
  or();
  if (position !== tokens.length) throw new Error(`trailing tokens in "${expression}"`);
  return [...ids].sort();
};

// The license(s) a header invokes: { expression, ids }, { error } for an
// expression that cannot be parsed, or null when it names none.
const detectLicenses = (text) => {
  const tagged =
    text.match(/SPDX-License-Identifier:[ \t]*([^\n]*)/i)?.[1] ??
    text.match(/@license[ \t]+([^\n,;]*?)(?=\s@|[,;]|\n|$)/i)?.[1];
  if (tagged !== undefined && tagged.trim() !== "" && !/^copyright$/i.test(tagged.trim())) {
    try {
      return { expression: tagged.trim(), ids: parseSpdxExpression(tagged.trim()) };
    } catch (error) {
      return { error: error.message };
    }
  }
  const single = (id) => ({ expression: id, ids: [id] });
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return single("Apache-2.0");
  const named = text.match(/\b(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause)\b/);
  if (named) return single(named[1]);
  if (/Permission is hereby granted, free of charge/i.test(text)) return single("MIT");
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return single("ISC");
  if (/Redistribution and use in source and binary forms/i.test(text)) return single("BSD");
  return null;
};

const headerHolders = (text) => {
  const raw = [];
  for (const match of text.matchAll(
    /Copyright\s*(?:\(c\)|©)?\s*(?:\d{4}(?:\s*[-–,]\s*(?:\d{4}|present))*\s*,?\s*)*([^\n]*)/gi,
  )) {
    raw.push(match[1]);
  }
  for (const match of text.matchAll(/\(c\)\s*(?:\d{4}(?:\s*[-–,]\s*\d{4})*\s*)?([^\n]*)/gi)) {
    raw.push(match[1]);
  }
  for (const match of text.matchAll(/@(?:author|copyright)[ \t]+([^\n]*)/gi)) {
    raw.push(match[1]);
  }
  return raw;
};

const words = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>|\([^)]*\)/g, " ")
    .replace(/all rights reserved/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !/^\d+$/.test(word));

// A holder is covered when its first two words appear in a row in the texts.
const holderKeys = (text) =>
  headerHolders(text)
    .map((holder) => words(holder).slice(0, 2).join(" "))
    .filter(Boolean);

const isCovered = (header, component, inventory) =>
  inventory.headerAllowlist.some(
    (entry) =>
      entry.component === component.name &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== "" &&
      header.includes(entry.contains),
  );

// Collects the components of the bundle: a map of component name to
// { name, version, license, source, origins, texts, headers, fileNotices,
// extraLicenses }, and the problems found.
export const inventoryComponents = async ({ converterRoot, mapPath }) => {
  const inventory = await loadInventory();
  const components = new Map();
  const problems = [];
  const distDir = path.dirname(mapPath);

  const add = async (name, { dir, origin, extraTexts, version, license }) => {
    let component = components.get(name);
    if (!component) {
      component = {
        name,
        version: null,
        license: null,
        source: null,
        origins: new Set(),
        texts: [],
        headers: new Map(),
        fileNotices: [],
        extraLicenses: new Map(),
      };
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
      const reviewed = inventory.components[name];
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

  // Records the license headers found in a bundled module's source.
  const inspect = async (name, content, label) => {
    if (content === null || content === undefined) {
      problems.push(`${label} has no source content, so its license headers cannot be checked`);
      return;
    }
    const headers = await extractHeaders(content, label);
    const component = components.get(name);
    for (const header of headers) {
      component.headers.set(collapse(header), header);
    }
  };

  // Expands a prebuilt input that ships its own source map.
  const expand = async (file, hostName, hostDir) => {
    const prebuilt = await readJson(`${file}.map`);
    const origin = `inside ${hostName}'s prebuilt ${path.basename(file)}`;
    const contents = prebuilt.sourcesContent ?? [];
    for (const [index, rawSource] of prebuilt.sources.entries()) {
      const source = stripWebpackPrefix(rawSource);
      const owner = packageOfPath(source);
      const label = `${origin}: ${rawSource}`;
      if (owner) {
        await add(owner.name, {
          dir: await installedDir(owner.name, hostDir, converterRoot),
          origin,
        });
        await inspect(owner.name, contents[index], label);
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
        await inspect("svg-to-pdfkit", contents[index], label);
      } else if (source.startsWith("./src/")) {
        await add(hostName, { dir: hostDir, origin });
        await inspect(hostName, contents[index], label);
      } else if (source.startsWith("webpack/")) {
        await add("webpack", { dir: null, origin });
        await inspect("webpack", contents[index], label);
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
  for (const [index, rawSource] of map.sources.entries()) {
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
      const content =
        map.sourcesContent?.[index] ?? (await fs.readFile(file, "utf-8").catch(() => null));
      const inPackage = path.relative(dir, file).split(path.sep).join("/");
      const reviewedInput = inventory.prebuiltInputs[`${owner.name}/${inPackage}`];
      if (await exists(`${file}.map`)) {
        const pkg = await readJson(path.join(dir, "package.json"));
        await expand(file, pkg.name ?? owner.name, dir);
      } else if (reviewedInput || (content !== null && prebuiltMarkers.test(content))) {
        // A bundle whose inner modules cannot be enumerated is only accepted
        // through a reviewed entry bound to this exact file.
        const bytes = await fs.readFile(file).catch(() => null);
        const digest = bytes ? sha256Hex(bytes) : null;
        if (
          reviewedInput &&
          digest !== null &&
          reviewedInput.sha256 === digest &&
          Array.isArray(reviewedInput.components) &&
          reviewedInput.components.length > 0
        ) {
          for (const name of reviewedInput.components) {
            await add(name, {
              dir: await installedDir(name, dir, converterRoot),
              origin: `listed by the reviewed entry for ${owner.name}/${inPackage}`,
            });
          }
          await inspect(owner.name, content, rawSource);
        } else {
          problems.push(
            `${rawSource} is itself a prebuilt bundle but its source map ${path.basename(file)}.map is missing and no reviewed prebuiltInputs entry in scripts/third-party/inventory.json matches its sha256 (${digest ?? "file unreadable"})`,
          );
        }
      } else {
        await inspect(owner.name, content, rawSource);
      }
    }
  }

  // Headers whose holder or license the component's own notice does not carry
  // must appear in the notices, with the full text of every license not shipped
  // there. Everything is visited in sorted order so the output does not depend
  // on the order the maps list their modules.
  for (const component of components.values()) {
    const shipped = component.texts.map(({ text }) => text).join("\n");
    const shippedWords = ` ${words(shipped).join(" ")} `;
    const headers = [...component.headers.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, header]) => header);
    for (const header of headers) {
      if (isCovered(header, component, inventory)) continue;
      const where = `${component.name}: license header "${collapse(header).slice(0, 90)}"`;
      const reviewed = inventory.headerLicenses.find(
        (entry) =>
          entry.component === component.name &&
          header.includes(entry.contains) &&
          typeof entry.reason === "string" &&
          entry.reason.trim() !== "",
      );
      if (reviewed) {
        // A header that names no usable license: the reviewed text applies.
        const text = await readThirdPartyText(reviewed.file);
        if (text === null) {
          problems.push(`${where}: the reviewed license text ${reviewed.file} is missing or blank`);
          continue;
        }
        component.fileNotices.push({ text: header, license: reviewed.license });
        component.extraLicenses.set(reviewed.file, { license: reviewed.license, text });
        continue;
      }
      const detected = detectLicenses(header);
      if (detected?.error) {
        problems.push(`${where} has a license expression this build cannot parse (${detected.error})`);
        continue;
      }
      const ids = detected?.ids ?? [];
      const keys = holderKeys(header);
      if (ids.length === 0 && keys.length === 0) {
        problems.push(
          `${where} names neither a holder nor a license; review it and add a headerLicenses or headerAllowlist entry with a reason`,
        );
        continue;
      }
      const holdersCovered = keys.every((key) => shippedWords.includes(` ${key} `));
      const missing = ids.filter((id) => !(shippedMarkers[id]?.test(shipped) ?? false));
      if (holdersCovered && missing.length === 0) {
        if (ids.length === 0) {
          problems.push(
            `${where} names a holder but no license terms; review it and add a headerLicenses or headerAllowlist entry with a reason`,
          );
        }
        continue;
      }
      if (ids.length === 0) {
        problems.push(
          `${where} names a holder the component's notice does not carry and no license terms; review it and add a headerLicenses or headerAllowlist entry with a reason`,
        );
        continue;
      }
      component.fileNotices.push({ text: header, license: detected.expression });
      for (const id of missing) {
        const file = spdxFile(id);
        const text = file ? await readThirdPartyText(file) : null;
        if (text === null) {
          problems.push(
            `${where} invokes license ${id}, which the component's notice does not carry and scripts/third-party/spdx/ has no reviewed text for`,
          );
        } else {
          component.extraLicenses.set(file, { license: id, text });
        }
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
  const problems = [...unreviewed];
  for (const asset of [...found.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const text = await fs
      .readFile(path.join(thirdPartyDir, "assets", asset.textFile), "utf-8")
      .catch(() => "");
    if (text.trim().length === 0) {
      problems.push(`the reviewed license text for embedded ${asset.id} is missing or blank`);
    }
    assets.push({ ...asset, text });
  }
  return { assets, problems };
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
    if (component.fileNotices.length > 0) {
      lines.push("", "--- File-level license notices inside bundled modules ---");
      const byText = [...component.fileNotices].sort((a, b) => {
        const [x, y] = [collapse(a.text), collapse(b.text)];
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const { text } of byText) {
        lines.push(text.trimEnd(), "");
      }
      const byFile = [...component.extraLicenses.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const [, { license, text }] of byFile) {
        lines.push(
          `--- ${license} (full text; applies to the file-level notices above) ---`,
          text.trimEnd(),
        );
      }
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
    extraLicenses: [...components.values()]
      .flatMap((component) =>
        [...component.extraLicenses.entries()].map(([file, { license }]) => ({
          component: componentHeading(component),
          license,
          file,
        })),
      )
      .sort((a, b) => `${a.component}${a.file}`.localeCompare(`${b.component}${b.file}`)),
  };
};

// Checks a notices file the way the prepack guard needs to: every component
// recorded at build time has a section with non-empty license text, and every
// full license text the build added for file-level notices is still there.
export const findNoticesProblems = async (notices, componentHeadings, extraLicenses = []) => {
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
  for (const { component, license, file } of extraLicenses) {
    const block = sections.get(component) ?? "";
    const reviewed = await readThirdPartyText(file);
    if (
      reviewed === null ||
      !block.includes(`--- ${license} (full text`) ||
      !collapse(block).includes(collapse(reviewed))
    ) {
      problems.push(
        `${noticesFileName} lacks the full ${license} text for the file-level notices of ${component.slice(4)}`,
      );
    }
  }
  return problems;
};
