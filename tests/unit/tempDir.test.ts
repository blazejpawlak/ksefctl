import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupTempDirs, makeTempDir } from "../helpers/tempDir.js";

const isRoot = process.getuid?.() === 0;

const exists = (target: string): Promise<boolean> =>
  fs.stat(target).then(
    () => true,
    () => false,
  );

describe("makeTempDir", () => {
  it("creates a directory under the temp directory with the given prefix", async () => {
    const dir = await makeTempDir("ksef-helper-");

    expect(path.dirname(dir)).toBe(os.tmpdir());
    expect(path.basename(dir)).toMatch(/^ksef-helper-/);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("removes the directory and its contents on cleanup", async () => {
    const dir = await makeTempDir("ksef-helper-");
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "nested", "file.txt"), "data");

    await cleanupTempDirs("test");

    expect(await exists(dir)).toBe(false);
  });

  it.skipIf(isRoot)("removes directories a test left read-only", async () => {
    const dir = await makeTempDir("ksef-helper-");
    const dbDir = path.join(dir, "db");
    await fs.mkdir(dbDir);
    await fs.writeFile(path.join(dbDir, "state.sqlite"), "data");
    await fs.chmod(path.join(dbDir, "state.sqlite"), 0o400);
    await fs.chmod(dbDir, 0o500);

    await cleanupTempDirs("test");

    expect(await exists(dir)).toBe(false);
  });

  it("tolerates a directory the test already removed", async () => {
    const dir = await makeTempDir("ksef-helper-");
    await fs.rm(dir, { recursive: true });

    await expect(cleanupTempDirs("test")).resolves.toBeUndefined();
  });
});

describe("makeTempDir in beforeAll", () => {
  let shared: string;

  beforeAll(async () => {
    shared = await makeTempDir("ksef-helper-shared-");
  });

  it("keeps a file-scoped directory when a test's own directories are cleaned", async () => {
    const own = await makeTempDir("ksef-helper-");

    await cleanupTempDirs("test");

    expect(await exists(own)).toBe(false);
    expect(await exists(shared)).toBe(true);
  });

  it("keeps the file-scoped directory for the next test", async () => {
    expect(await exists(shared)).toBe(true);
  });
});
