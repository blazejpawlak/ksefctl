import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptsSource = path.join(import.meta.dirname, "..", "..", "scripts");
const pinnedCommit = "f59fc4e2addcf42c74b1674e7c1d534085bc3a84";
const bundle = "export const built = true;\n";
const component = "### dep-a@1.0.0";
const notices = `THIRD-PARTY NOTICES

${component}
License: MIT

--- LICENSE ---
License text of dep-a
`;
// A one-pixel PNG: far below any size threshold, and not a font or profile.
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const robotoBundle = `export const font = "${Buffer.concat([
  Buffer.from([0, 1, 0, 0]),
  Buffer.from(
    `Copyright 2011 The Roboto Project Authors SIL Open Font License, Version 1.1.${"x".repeat(600)}`,
    "latin1",
  ),
]).toString("base64")}";\n`;

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
        noticesSha256: createHash("sha256").update(notices).digest("hex"),
        components: [component],
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

  const runGuard = (root = pkg) =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts", "check-vendored-converter.mjs")],
      { encoding: "utf-8" },
    );

  // Replaces the bundle (and its recorded checksum), optionally with notices.
  const writeBundle = async (content: string, noticesText = notices) => {
    await fs.writeFile(path.join(vendorDir, "ksef-fe-invoice-converter.js"), content);
    await fs.writeFile(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"), noticesText);
    await writeMetadata({
      bundleSha256: createHash("sha256").update(content).digest("hex"),
      noticesSha256: createHash("sha256").update(noticesText).digest("hex"),
    });
  };

  const writeInstalledLock = async (commit: string) => {
    await fs.mkdir(path.join(pkg, "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(pkg, "node_modules", ".package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@akmf/ksef-fe-invoice-converter": {
            resolved: `git+ssh://git@github.com/CIRFMF/ksef-pdf-generator.git#${commit}`,
          },
        },
      }),
    );
  };

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
      "third-party-notices.mjs",
    ]) {
      await fs.copyFile(
        path.join(scriptsSource, name),
        path.join(pkg, "scripts", name),
      );
    }
    await fs.cp(
      path.join(scriptsSource, "third-party"),
      path.join(pkg, "scripts", "third-party"),
      { recursive: true },
    );
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
    await fs.writeFile(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"), notices);
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

  it("fails when the third-party notices file is missing", async () => {
    await fs.rm(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("THIRD_PARTY_NOTICES.txt is missing");
  });

  it("fails when the third-party notices file is empty", async () => {
    await fs.writeFile(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"), "");

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("THIRD_PARTY_NOTICES.txt is empty");
  });

  it("fails when the notices do not match their recorded checksum", async () => {
    await fs.writeFile(
      path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"),
      "edited notices\n",
    );

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("THIRD_PARTY_NOTICES.txt does not match the checksum");
  });

  it("fails when the bundle embeds a font the notices do not cover", async () => {
    await writeBundle(robotoBundle);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no notice for embedded Roboto");
  });

  it("passes when the notices cover the embedded font", async () => {
    await writeBundle(
      robotoBundle,
      `${notices}\nRoboto fonts (pdfmake's built-in virtual file system)\n`,
    );

    const result = runGuard();

    expect(result.status, result.stderr).toBe(0);
  });

  it("fails when the installed converter is not the pinned commit", async () => {
    await writeInstalledLock("3".repeat(40));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the installed converter is at ${"3".repeat(40)}`);
    expect(result.stderr).toContain("run npm ci");
  });

  it("passes when the installed converter is the pinned commit", async () => {
    await writeInstalledLock(pinnedCommit);

    const result = runGuard();

    expect(result.status, result.stderr).toBe(0);
  });

  const writeNotices = async (text: string, components = [component]) => {
    await fs.writeFile(path.join(vendorDir, "THIRD_PARTY_NOTICES.txt"), text);
    await writeMetadata({
      noticesSha256: createHash("sha256").update(text).digest("hex"),
      components,
    });
  };

  it("fails when a recorded component's license section is empty", async () => {
    await writeNotices(`THIRD-PARTY NOTICES\n\n${component}\nLicense: MIT\n\n--- LICENSE ---\n   \n`);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no license text for dep-a@1.0.0");
  });

  it("fails when a component the build recorded has no section in the notices", async () => {
    await writeNotices(notices, [component, "### unlisted-package@3.0.0"]);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no section for unlisted-package@3.0.0");
  });

  it("fails when the metadata records no bundled components", async () => {
    await writeNotices(notices, []);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("records no bundled components");
  });

  it.each([
    ["a data: URL image", `export const a = "data:image/png;base64,${tinyPng}";\n`, "embedded image"],
    ["a bare base64 image", `export const a = "${tinyPng}";\n`, "embedded image"],
    [
      "an opaque data: URL",
      "export const a = \"data:application/octet-stream;base64,AAECAwQFBgcICQ==\";\n",
      "data: URL of media type application/octet-stream",
    ],
  ])("fails when the bundle embeds %s no notice covers", async (_label, content, expected) => {
    await writeBundle(content);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it("names the holders of code pre-bundled inside pdfmake in the repository's notices", async () => {
    const vendored = await fs.readFile(
      path.join(import.meta.dirname, "..", "..", "vendor", "ksef-pdf-generator", "THIRD_PARTY_NOTICES.txt"),
      "utf-8",
    );

    for (const expected of [
      "### core-js@",
      "Denis Pushkarev",
      "### file-saver@",
      "Eli Grey",
      "### svg-to-pdfkit@",
      "SVG-to-PDFKit contributors",
      "### pdfkit@",
      "Devon Govett",
      "### pdfmake@",
      "bpampuch",
      "Roboto Project Authors",
      "International Color Consortium",
    ]) {
      expect(vendored).toContain(expected);
    }
    expect(vendored).not.toMatch(/License: UNKNOWN/);
  });

  it("accepts the repository's own vendored converter", () => {
    const result = runGuard(path.join(import.meta.dirname, "..", ".."));

    expect(result.status, result.stderr).toBe(0);
  });
});
