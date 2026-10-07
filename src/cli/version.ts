import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildNodeOptionsWithLocalstorage } from "../utils/nodeOptions.js";
import { defaultDataRoot, ensureDir } from "../utils/paths.js";
import { pdfConverterMetadataPath } from "../utils/pdfConverter.js";

// Module-level result caches — persist across calls within a process lifetime
let packageVersionPromise: Promise<string> | null = null;
let versionOutputPromise: Promise<string> | null = null;

export type BuildDependencyInfo = {
  name: string;
  version: string;
  source: string;
  commit: string | null;
};

export const resolveLocalstoragePath = (): string =>
  path.join(defaultDataRoot(), "localstorage.json");

const execFileAsync = promisify(execFile);

const PackageVersionPathCandidates = [
  path.join(import.meta.dirname, "..", "..", "package.json"),
  path.join(import.meta.dirname, "..", "package.json"),
];

const PdfBuilderPackageName = "@akmf/ksef-fe-invoice-converter";
const PdfBuilderSource = "CIRFMF/ksef-pdf-generator";

const shortenCommit = (commit: string | null): string | null =>
  commit ? commit.slice(0, 8) : null;

export const formatVersionOutput = (
  version: string,
  commit: string,
  pdfBuilder?: BuildDependencyInfo | null,
): string => {
  const appVersion = `${version} (${commit})`;
  if (!pdfBuilder) {
    return appVersion;
  }

  const commitInfo = shortenCommit(pdfBuilder.commit);
  const sourceInfo = commitInfo
    ? `${pdfBuilder.source}@${commitInfo}`
    : pdfBuilder.source;

  return [
    appVersion,
    `pdf-builder: ${pdfBuilder.name} ${pdfBuilder.version} (${sourceInfo}; check upstream releases for newer versions)`,
  ].join("\n");
};

export const readPackageVersion = async (): Promise<string> => {
  packageVersionPromise ??= (async () => {
    for (const packageVersionPath of PackageVersionPathCandidates) {
      try {
        const raw = await fs.readFile(packageVersionPath, "utf-8");
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (
          typeof parsed.version === "string" &&
          parsed.version.trim().length > 0
        ) {
          return parsed.version;
        }
      } catch {
        // Try the next candidate path.
      }
    }

    return "unknown";
  })();

  return packageVersionPromise;
};

// The converter ships prebuilt in the package; its name, version and source
// commit are recorded in the metadata written when it was vendored.
export const readPdfBuilderInfo =
  async (): Promise<BuildDependencyInfo | null> => {
    try {
      const raw = await fs.readFile(pdfConverterMetadataPath(), "utf-8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        commit?: unknown;
      };
      return {
        name: PdfBuilderPackageName,
        version:
          typeof parsed.version === "string" ? parsed.version : "unknown",
        source: PdfBuilderSource,
        commit: typeof parsed.commit === "string" ? parsed.commit : null,
      };
    } catch {
      return {
        name: PdfBuilderPackageName,
        version: "unavailable",
        source: PdfBuilderSource,
        commit: null,
      };
    }
  };

export const readShortCommit = async (): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--short", "HEAD"],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
      },
    );
    const commit = stdout.trim();
    return commit.length > 0 ? commit : "unknown";
  } catch {
    return "unknown";
  }
};

export const readVersionOutput = async (): Promise<string> => {
  versionOutputPromise ??= Promise.all([
    readPackageVersion(),
    readShortCommit(),
    readPdfBuilderInfo(),
  ]).then(([version, commit, pdfBuilder]) =>
    formatVersionOutput(version, commit, pdfBuilder),
  );

  return versionOutputPromise;
};

export const printVersion = async (): Promise<void> => {
  console.log(await readVersionOutput());
};

export const ensureLocalstorageNodeOption = async (): Promise<void> => {
  const localstoragePath = resolveLocalstoragePath();
  await ensureDir(path.dirname(localstoragePath));
  process.env.NODE_OPTIONS = buildNodeOptionsWithLocalstorage(
    process.env.NODE_OPTIONS,
    localstoragePath,
  );
};
