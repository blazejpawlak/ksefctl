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

  it("reads pinned PDF builder build information", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };
    const dependencySpec =
      parsed.dependencies?.["@akmf/ksef-fe-invoice-converter"] ?? "";
    const expectedCommit = dependencySpec.split("#").at(-1) ?? null;
    const installed = JSON.parse(
      await fs.readFile(
        path.join(
          process.cwd(),
          "node_modules",
          "@akmf",
          "ksef-fe-invoice-converter",
          "package.json",
        ),
        "utf-8",
      ),
    ) as { version: string };

    await expect(readPdfBuilderInfo()).resolves.toMatchObject({
      name: "@akmf/ksef-fe-invoice-converter",
      version: installed.version,
      source: "CIRFMF/ksef-pdf-generator",
      commit: expectedCommit,
    });
  });
});
