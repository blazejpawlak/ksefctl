import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptsSource = path.join(import.meta.dirname, "..", "..", "scripts");
const pinnedCommit = "f59fc4e2addcf42c74b1674e7c1d534085bc3a84";
const bundle = "export const built = true;\n";

describe("check-vendored-converter (prepack guard)", () => {
  let pkg: string;
  let vendorDir: string;

  const writeMetadata = async (overrides: Record<string, unknown> = {}) => {
    await fs.writeFile(
      path.join(vendorDir, "metadata.json"),
      JSON.stringify({
        name: "@akmf/ksef-fe-invoice-converter",
        version: "1.2.3",
        source: "CIRFMF/ksef-pdf-generator",
        commit: pinnedCommit,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
        ...overrides,
      }),
    );
  };

  const writeLock = (version: string, commit: string) =>
    fs.writeFile(
      path.join(pkg, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@akmf/ksef-fe-invoice-converter": {
            version,
            resolved: `git+ssh://git@github.com/CIRFMF/ksef-pdf-generator.git#${commit}`,
          },
        },
      }),
    );

  const runGuard = () =>
    spawnSync(
      process.execPath,
      [path.join(pkg, "scripts", "check-vendored-converter.mjs")],
      { encoding: "utf-8" },
    );

  beforeEach(async () => {
    pkg = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ksefctl-guard-")),
    );
    vendorDir = path.join(pkg, "vendor", "ksef-pdf-generator");
    await fs.mkdir(vendorDir, { recursive: true });
    await fs.mkdir(path.join(pkg, "scripts"));
    for (const name of [
      "check-vendored-converter.mjs",
      "vendored-converter.mjs",
    ]) {
      await fs.copyFile(
        path.join(scriptsSource, name),
        path.join(pkg, "scripts", name),
      );
    }
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@akmf/ksef-fe-invoice-converter": `github:CIRFMF/ksef-pdf-generator#${pinnedCommit}`,
        },
      }),
    );
    await fs.writeFile(path.join(vendorDir, "ksef-fe-invoice-converter.js"), bundle);
    await fs.writeFile(path.join(vendorDir, "LICENSE"), "MIT License\n");
    await writeMetadata();
    await writeLock("1.2.3", pinnedCommit);
  });

  afterEach(async () => {
    await fs.rm(pkg, { recursive: true, force: true });
  });

  it("passes when the vendored converter matches the pin and the lockfile", () => {
    const result = runGuard();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails when the vendored bundle is missing", async () => {
    await fs.rm(path.join(vendorDir, "ksef-fe-invoice-converter.js"));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to pack");
    expect(result.stderr).toContain("ksef-fe-invoice-converter.js is missing");
  });

  it("fails when the upstream license is missing", async () => {
    await fs.rm(path.join(vendorDir, "LICENSE"));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LICENSE is missing");
  });

  it("fails when the whole vendor directory is missing", async () => {
    await fs.rm(path.join(pkg, "vendor"), { recursive: true });

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("metadata.json is missing");
  });

  it("fails when the vendored commit is stale against the devDependency pin", async () => {
    await writeMetadata({ commit: "0".repeat(40) });

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the devDependency pin");
  });

  it("fails when the vendored version differs from the lockfile", async () => {
    await writeLock("9.9.9", pinnedCommit);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match package-lock.json");
  });

  it("fails when the lockfile resolves a different commit than the pin", async () => {
    await writeLock("1.2.3", "1".repeat(40));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the devDependency pin");
  });

  it("fails when the bundle does not match its recorded checksum", async () => {
    await fs.writeFile(
      path.join(vendorDir, "ksef-fe-invoice-converter.js"),
      "export const tampered = true;\n",
    );

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum");
  });

  it("fails when the devDependency is no longer a commit-pinned git spec", async () => {
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        devDependencies: { "@akmf/ksef-fe-invoice-converter": "^1.1.40" },
      }),
    );

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commit-pinned");
  });
});
