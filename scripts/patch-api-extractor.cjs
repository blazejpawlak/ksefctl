const fs = require("node:fs/promises");
const path = require("node:path");

const converterNodeModules = path.join(
  __dirname,
  "..",
  "node_modules",
  "@akmf",
  "ksef-fe-invoice-converter",
  "node_modules",
);

const targetDirs = [
  path.join(
    converterNodeModules,
    "@microsoft",
    "api-extractor",
    "lib-esm",
  ),
  path.join(
    converterNodeModules,
    "@microsoft",
    "api-extractor-model",
    "lib-esm",
  ),
];

const shouldPatchSpecifier = (specifier) => {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return true;
  }
  return (
    specifier.includes("/lib-commonjs/") ||
    specifier.includes("/lib-esm/")
  );
};

const addJsExtension = (specifier) => {
  if (!shouldPatchSpecifier(specifier)) {
    return specifier;
  }
  if (path.extname(specifier)) {
    return specifier;
  }
  return `${specifier}.js`;
};

const patchFile = async (targetPath) => {
  let content;
  try {
    content = await fs.readFile(targetPath, "utf-8");
  } catch (error) {
    const err = error;
    if (err && typeof err === "object" && err.code === "ENOENT") {
      throw new Error(
        `ESM entry not found at ${targetPath}. Install dependencies first.`,
      );
    }
    throw error;
  }

  let patched = content.replace(
    /from ['"]([^'"]+)['"]/g,
    (match, specifier) => match.replace(specifier, addJsExtension(specifier)),
  );
  patched = patched.replace(
    /import ['"]([^'"]+)['"]/g,
    (match, specifier) => match.replace(specifier, addJsExtension(specifier)),
  );
  patched = patched.replace(
    /from ['"]([^'"]+\.json)['"](?!\s*(?:assert|with))/g,
    (match, specifier) =>
      `from "${specifier}" with { type: "json" }`,
  );
  patched = patched.replace(
    /import ['"]([^'"]+\.json)['"](?!\s*(?:assert|with))/g,
    (match, specifier) =>
      `import "${specifier}" with { type: "json" }`,
  );
  patched = patched.replace(
    /assert \{ type: "json" \}/g,
    "with { type: \"json\" }",
  );
  patched = patched.replace(
    /import \* as fsx from ['"]fs-extra['"];?/g,
    "import fsx from \"fs-extra\";",
  );
  patched = patched.replace(
    /import \* as jju from ['"]jju['"];?/g,
    "import jju from \"jju\";",
  );
  patched = addDirnameShim(patched);

  if (patched === content) {
    return;
  }

  await fs.writeFile(targetPath, patched, "utf-8");
};

const addDirnameShim = (source) => {
  if (!source.includes("__dirname")) {
    return source;
  }
  if (/\b__dirname\s*=/.test(source)) {
    return source;
  }

  const shimLines = [
    'import { fileURLToPath } from "node:url";',
    'import { dirname as pathDirname } from "node:path";',
    "const __filename = fileURLToPath(import.meta.url);",
    "const __dirname = pathDirname(__filename);",
  ];

  const lines = source.split("\n");
  let insertIndex = 0;
  while (insertIndex < lines.length) {
    const line = lines[insertIndex];
    if (!line.startsWith("import ")) {
      break;
    }
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, ...shimLines, "");
  return lines.join("\n");
};

const collectJsFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childFiles = await collectJsFiles(fullPath);
      files.push(...childFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
};

const collectRushstackTargets = async () => {
  const rushstackDir = path.join(converterNodeModules, "@rushstack");
  let entries;
  try {
    entries = await fs.readdir(rushstackDir, { withFileTypes: true });
  } catch (error) {
    const err = error;
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rushstackTargets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const libEsmDir = path.join(rushstackDir, entry.name, "lib-esm");
    try {
      const stats = await fs.stat(libEsmDir);
      if (stats.isDirectory()) {
        rushstackTargets.push(libEsmDir);
      }
    } catch (error) {
      const err = error;
      if (err && typeof err === "object" && err.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return rushstackTargets;
};

const collectMicrosoftTargets = async () => {
  const microsoftDir = path.join(converterNodeModules, "@microsoft");
  let entries;
  try {
    entries = await fs.readdir(microsoftDir, { withFileTypes: true });
  } catch (error) {
    const err = error;
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const microsoftTargets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const libEsmDir = path.join(microsoftDir, entry.name, "lib-esm");
    try {
      const stats = await fs.stat(libEsmDir);
      if (stats.isDirectory()) {
        microsoftTargets.push(libEsmDir);
      }
    } catch (error) {
      const err = error;
      if (err && typeof err === "object" && err.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return microsoftTargets;
};

const run = async () => {
  const allTargets = [
    ...targetDirs,
    ...(await collectRushstackTargets()),
    ...(await collectMicrosoftTargets()),
  ];
  for (const targetDir of allTargets) {
    const jsFiles = await collectJsFiles(targetDir);
    for (const targetPath of jsFiles) {
      await patchFile(targetPath);
    }
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
