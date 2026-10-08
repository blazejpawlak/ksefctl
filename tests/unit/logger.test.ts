import type { LogRotationOptions } from "../../src/utils/logger.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyLogRotation,
  closeLogger,
  createLogger,
} from "../../src/utils/logger.js";
import { makeTempDir } from "../helpers/tempDir.js";

const MEGABYTE = 1024 * 1024;

/**
 * Compare multi-megabyte log contents by length and digest. A failing
 * toBe/toContain on the raw string makes Vitest print the whole value, and in
 * CI its github-actions reporter repeats it as a single ~1 MiB `::error`
 * workflow-command line, which can stall the Actions runner indefinitely.
 */
const summarize = (content: string): { length: number; sha256: string } => ({
  length: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
});

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
    const tmpDir = await makeTempDir("ksef-logrot-");
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
    expect(summarize(rotatedContent)).toEqual(summarize(original));
    expect((await fs.stat(rotatedPath)).mode & 0o777).toBe(0o600);
  });

  it("does not rotate a log below the size threshold", async () => {
    const tmpDir = await makeTempDir("ksef-logrot-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    await fs.writeFile(filePath, "small", { mode: 0o600 });

    const rotated = await applyLogRotation(filePath, rotation());

    expect(rotated).toBe(false);
    expect(await fs.readFile(filePath, "utf-8")).toBe("small");
    expect(await listRotated(filePath)).toEqual([]);
  });

  it("prunes rotated files beyond maxFiles, keeping the newest", async () => {
    const tmpDir = await makeTempDir("ksef-logrot-");
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
    const tmpDir = await makeTempDir("ksef-logrot-");
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
    const tmpDir = await makeTempDir("ksef-logrot-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const stdoutPath = path.join(tmpDir, "ksefctl.stdout.log");
    await fs.writeFile(filePath, "active", { mode: 0o600 });
    await fs.writeFile(stdoutPath, "stdout", { mode: 0o600 });
    await fs.writeFile(`${filePath}.1`, "rotated", { mode: 0o600 });

    await applyLogRotation(filePath, rotation({ maxFiles: 0 }));

    expect(await fs.readFile(stdoutPath, "utf-8")).toBe("stdout");
  });

  it("keeps writing to the current file when rotation fails", async () => {
    const tmpDir = await makeTempDir("ksef-logrot-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const original = "x".repeat(MEGABYTE);
    await fs.writeFile(filePath, original, { mode: 0o600 });
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("EIO"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      applyLogRotation(filePath, rotation()),
    ).resolves.toBe(false);

    expect(summarize(await fs.readFile(filePath, "utf-8"))).toEqual(
      summarize(original),
    );
    expect(await listRotated(filePath)).toEqual([]);
  });

  it("createLogger rotates on open and never throws when rotation fails", async () => {
    const tmpDir = await makeTempDir("ksef-logrot-");
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
    await closeLogger(logger);

    const rotatedFiles = await listRotated(filePath);
    expect(rotatedFiles).toHaveLength(1);
    const current = await fs.readFile(filePath, "utf-8");
    // Length first: if rotation did not happen, toContain would print 1 MiB.
    expect(current.length).toBeLessThan(MEGABYTE);
    expect(current).toContain("after-rotate");

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
    await closeLogger(failingLogger);
    const failedFile = await fs.readFile(oversizedPath, "utf-8");
    expect(summarize(failedFile.slice(0, MEGABYTE))).toEqual(
      summarize("y".repeat(MEGABYTE)),
    );
    // Only the appended tail: a failure must not print the 1 MiB prefix.
    expect(failedFile.slice(MEGABYTE)).toContain("still-writing");
  });

  it("skips rotation when it is disabled", async () => {
    const tmpDir = await makeTempDir("ksef-logrot-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const original = "x".repeat(MEGABYTE);
    await fs.writeFile(filePath, original, { mode: 0o600 });

    const rotated = await applyLogRotation(
      filePath,
      rotation({ enabled: false }),
    );

    expect(rotated).toBe(false);
    expect(summarize(await fs.readFile(filePath, "utf-8"))).toEqual(
      summarize(original),
    );
  });
});

describe("createLogger file output", () => {
  it("writes redacted JSON lines to a 0600 file and honours the level", async () => {
    const tmpDir = await makeTempDir("ksef-logout-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const logger = await createLogger({
      level: "info",
      file: filePath,
      prettyConsole: false,
      suppressConsole: true,
      rotation: rotation({ enabled: false }),
    });

    logger.debug({ event: "below-level" }, "dropped");
    logger.info(
      {
        event: "redaction",
        headers: { authorization: "Bearer secret-a" },
        req: { headers: { Authorization: "Bearer secret-b" } },
        Authorization: "Bearer secret-c",
        session: { accessToken: "secret-d", refreshToken: "secret-e" },
        notifications: { email: { smtp: { pass: "secret-f" } } },
      },
      "redacted",
    );

    // Poll instead of flush(): the async destination may not have opened yet.
    const content = await vi.waitFor(
      async () => {
        const text = await fs.readFile(filePath, "utf-8");
        if (!text.includes("redaction")) {
          throw new Error("log line not written yet");
        }
        return text;
      },
      { timeout: 5000, interval: 20 },
    );

    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 30,
      msg: "redacted",
      event: "redaction",
      headers: { authorization: "***" },
      req: { headers: { Authorization: "***" } },
      Authorization: "***",
      session: { accessToken: "***", refreshToken: "***" },
      notifications: { email: { smtp: { pass: "***" } } },
    });
    expect(content).not.toContain("secret-");
    expect(content).not.toContain("below-level");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});

/**
 * Hold every SonicBoom write in flight for delayMs (or forever), standing in
 * for a slow disk. sonic-boom calls fs.write through the shared node:fs module.
 */
const delayFileWrites = (delayMs: number | null): void => {
  const original = fsSync.write;
  vi.spyOn(fsSync, "write").mockImplementation((...args: unknown[]) => {
    if (delayMs === null) {
      return;
    }
    setTimeout(() => {
      Reflect.apply(original, fsSync, args);
    }, delayMs);
  });
};

const createTestLogger = async (
  filePath: string,
  suppressConsole = true,
): Promise<Awaited<ReturnType<typeof createLogger>>> =>
  createLogger({
    level: "info",
    file: filePath,
    prettyConsole: false,
    suppressConsole,
    rotation: rotation({ enabled: false }),
  });

describe("closeLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the final line on disk where logger.flush() did not", async () => {
    const tmpDir = await makeTempDir("ksef-logclose-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    delayFileWrites(250);
    const logger = await createTestLogger(filePath);

    logger.info({ lifecycleStage: "signal_received" }, "final stop line");
    await new Promise<void>((resolve) => {
      logger.flush(() => resolve());
    });
    // The old shutdown path re-raised the signal here; the line was not
    // written yet.
    expect(await fs.readFile(filePath, "utf-8")).toBe("");

    await closeLogger(logger);

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      msg: "final stop line",
      lifecycleStage: "signal_received",
    });
  });

  it("drains a line logged before the destination has opened", async () => {
    const tmpDir = await makeTempDir("ksef-logclose-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const logger = await createTestLogger(filePath);

    logger.info("logged before open");
    await closeLogger(logger);

    expect(await fs.readFile(filePath, "utf-8")).toContain(
      "logged before open",
    );
  });

  it("keeps logging safe after close and leaves stdout open", async () => {
    const tmpDir = await makeTempDir("ksef-logclose-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const endSpy = vi.spyOn(process.stdout, "end");
    const logger = await createTestLogger(filePath, false);

    logger.info("before close");
    await closeLogger(logger);

    expect(() => logger.info("after close")).not.toThrow();
    await expect(closeLogger(logger)).resolves.toBeUndefined();
    expect(endSpy).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining("after close"),
    );
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("before close");
    expect(content).not.toContain("after close");
  });

  it("gives up after the timeout when a destination never drains", async () => {
    const tmpDir = await makeTempDir("ksef-logclose-");
    const filePath = path.join(tmpDir, "ksefctl.log");
    const logger = await createTestLogger(filePath);
    // Let the destination open, then make every write hang.
    logger.info("opened");
    await vi.waitFor(
      async () => {
        expect(await fs.readFile(filePath, "utf-8")).toContain("opened");
      },
      { timeout: 5000, interval: 20 },
    );
    delayFileWrites(null);
    logger.info("stuck");

    const startedAt = Date.now();
    await closeLogger(logger, 50);

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("falls back to logger.flush() for loggers without a multistream", async () => {
    const logger = { flush: vi.fn() };

    await closeLogger(logger as never);

    expect(logger.flush).toHaveBeenCalledOnce();
  });
});
