import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readPackageVersion, readPdfBuilderInfo } from "../../src/cli/version.js";

describe("version helpers", () => {
  it("reads package version from project metadata", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };

    await expect(readPackageVersion()).resolves.toBe(parsed.version);
  });

  it("reads the pinned PDF builder from the vendored metadata", async () => {
    const root = process.cwd();
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf-8"),
    ) as { devDependencies?: Record<string, string> };
    const dependencySpec =
      parsed.devDependencies?.["@akmf/ksef-fe-invoice-converter"] ?? "";
    const expectedCommit = dependencySpec.split("#").at(-1) ?? null;
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(root, "vendor", "ksef-pdf-generator", "metadata.json"),
        "utf-8",
      ),
    ) as { version: string };

    await expect(readPdfBuilderInfo()).resolves.toMatchObject({
      name: "@akmf/ksef-fe-invoice-converter",
      version: metadata.version,
      source: "CIRFMF/ksef-pdf-generator",
      commit: expectedCommit,
    });
  });
});
