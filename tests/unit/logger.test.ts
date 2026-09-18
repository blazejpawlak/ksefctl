import type { LogRotationOptions } from "../../src/utils/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyLogRotation, createLogger } from "../../src/utils/logger";

const MEGABYTE = 1024 * 1024;

const rotation = (
  overrides: Partial<LogRotationOptions> = {},
): LogRotationOptions => ({
  enabled: true,
  maxFileMegabytes: 1,
  maxFiles: 5,
  maxAgeDays: 30,
  ...overrides,
});

const listRotated = async (filePath: string): Promise<string[]> => {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const names = await fs.readdir(dir);
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name));
};

describe("log rotation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates the active log when it reaches the size threshold", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    const original = "x".repeat(MEGABYTE);
    await fs.writeFile(filePath, original, { mode: 0o600 });

    const rotated = await applyLogRotation(filePath, rotation());

    expect(rotated).toBe(true);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const rotatedFiles = await listRotated(filePath);
    expect(rotatedFiles).toHaveLength(1);
    const rotatedPath = rotatedFiles[0];
    if (!rotatedPath) {
      throw new Error("expected a rotated log file");
    }
    const rotatedContent = await fs.readFile(rotatedPath, "utf-8");
    expect(rotatedContent).toBe(original);
    expect((await fs.stat(rotatedPath)).mode & 0o777).toBe(0o600);
  });

  it("does not rotate a log below the size threshold", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    await fs.writeFile(filePath, "small", { mode: 0o600 });

    const rotated = await applyLogRotation(filePath, rotation());

    expect(rotated).toBe(false);
    expect(await fs.readFile(filePath, "utf-8")).toBe("small");
    expect(await listRotated(filePath)).toEqual([]);
  });

  it("prunes rotated files beyond maxFiles, keeping the newest", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    await fs.writeFile(filePath, "active", { mode: 0o600 });

    const oldest = `${filePath}.oldest`;
    const middle = `${filePath}.middle`;
    const newest = `${filePath}.newest`;
    await fs.writeFile(oldest, "1", { mode: 0o600 });
    await fs.writeFile(middle, "2", { mode: 0o600 });
    await fs.writeFile(newest, "3", { mode: 0o600 });
    const now = Date.now();
    await fs.utimes(oldest, new Date(now - 30_000), new Date(now - 30_000));
    await fs.utimes(middle, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(newest, new Date(now - 10_000), new Date(now - 10_000));

    const rotated = await applyLogRotation(
      filePath,
      rotation({ maxFiles: 2 }),
    );

    expect(rotated).toBe(false);
    const remaining = (await listRotated(filePath)).sort();
    expect(remaining).toEqual([middle, newest].sort());
    expect(await fs.readFile(filePath, "utf-8")).toBe("active");
  });

  it("prunes rotated files older than maxAgeDays", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    await fs.writeFile(filePath, "active", { mode: 0o600 });
    const stalePath = `${filePath}.stale`;
    const freshPath = `${filePath}.fresh`;
    await fs.writeFile(stalePath, "old", { mode: 0o600 });
    await fs.writeFile(freshPath, "new", { mode: 0o600 });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await fs.utimes(stalePath, new Date(twoDaysAgo), new Date(twoDaysAgo));

    await applyLogRotation(filePath, rotation({ maxAgeDays: 1 }));

    const remaining = (await listRotated(filePath)).sort();
    expect(remaining).toEqual([freshPath]);
  });

  it("does not prune service stdio logs that share the directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    const stdoutPath = path.join(tmpDir, "ksefctl.stdout.log");
    await fs.writeFile(filePath, "active", { mode: 0o600 });
    await fs.writeFile(stdoutPath, "stdout", { mode: 0o600 });
    await fs.writeFile(`${filePath}.1`, "rotated", { mode: 0o600 });

    await applyLogRotation(filePath, rotation({ maxFiles: 0 }));

    expect(await fs.readFile(stdoutPath, "utf-8")).toBe("stdout");
  });

  it("keeps writing to the current file when rotation fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    const original = "x".repeat(MEGABYTE);
    await fs.writeFile(filePath, original, { mode: 0o600 });
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("EIO"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      applyLogRotation(filePath, rotation()),
    ).resolves.toBe(false);

    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
    expect(await listRotated(filePath)).toEqual([]);
  });

  it("createLogger rotates on open and never throws when rotation fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    await fs.writeFile(filePath, "x".repeat(MEGABYTE), { mode: 0o600 });

    const logger = await createLogger({
      level: "info",
      file: filePath,
      prettyConsole: false,
      suppressConsole: true,
      rotation: rotation(),
    });
    logger.info({ event: "after-rotate" }, "hello");
    await new Promise<void>((resolve, reject) => {
      logger.flush((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const rotatedFiles = await listRotated(filePath);
    expect(rotatedFiles).toHaveLength(1);
    const current = await fs.readFile(filePath, "utf-8");
    expect(current).toContain("after-rotate");
    expect(current.length).toBeLessThan(MEGABYTE);

    vi.spyOn(fs, "rename").mockRejectedValue(new Error("EIO"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const oversizedPath = path.join(tmpDir, "ksefctl-fail.log");
    await fs.writeFile(oversizedPath, "y".repeat(MEGABYTE), { mode: 0o600 });
    const failingLogger = await createLogger({
      level: "info",
      file: oversizedPath,
      prettyConsole: false,
      suppressConsole: true,
      rotation: rotation(),
    });
    failingLogger.info({ event: "still-writing" }, "kept going");
    await new Promise<void>((resolve, reject) => {
      failingLogger.flush((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    const failedFile = await fs.readFile(oversizedPath, "utf-8");
    expect(failedFile.startsWith("y")).toBe(true);
    expect(failedFile).toContain("still-writing");
  });

  it("skips rotation when it is disabled", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-logrot-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    const original = "x".repeat(MEGABYTE);
    await fs.writeFile(filePath, original, { mode: 0o600 });

    const rotated = await applyLogRotation(
      filePath,
      rotation({ enabled: false }),
    );

    expect(rotated).toBe(false);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });
});
