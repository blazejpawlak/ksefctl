import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readPackageVersion } from "../../src/cli/version";

describe("version helpers", () => {
  it("reads package version from project metadata", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };

    await expect(readPackageVersion()).resolves.toBe(parsed.version);
  });
});
