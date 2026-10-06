import type { Logger } from "pino";
import pino from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./paths.js";

export type LogRotationOptions = {
  enabled: boolean;
  maxFileMegabytes: number;
  maxFiles: number;
  maxAgeDays: number;
};

export type LoggerOptions = {
  level: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file: string;
  prettyConsole: boolean;
  suppressConsole?: boolean;
  rotation?: LogRotationOptions;
};

const LOG_FILE_MODE = 0o600;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LOG_ROTATION_CHECK_INTERVAL_MS = 30_000;
// Upper bound for closeLogger so a stuck destination can never hang shutdown.
export const LOG_CLOSE_TIMEOUT_MS = 2_000;

// Matches src/config/schema.ts logging.rotation defaults. Callers should pass
// config.logging.rotation when available so user overrides take effect.
export const DEFAULT_LOG_ROTATION: LogRotationOptions = {
  enabled: true,
  maxFileMegabytes: 16,
  maxFiles: 5,
  maxAgeDays: 30,
};

const redactions = {
  paths: [
    "auth.keychainServiceName",
    "notifications.email.smtp.pass",
    "notifications.email.smtp.user",
    "notifications.email.smtp.from",
    "notifications.email.smtp.to",
    "headers.authorization",
    "headers.Authorization",
    "req.headers.authorization",
    "req.headers.Authorization",
    "authorization",
    "Authorization",
    "*.accessToken",
    "*.refreshToken",
    "*.ksefToken",
  ],
  censor: "***",
};

const writeRotationWarning = (filePath: string, error: unknown): void => {
  try {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `ksefctl: log rotation failed for ${filePath}: ${message}\n`,
    );
  } catch {
    // Rotation must never crash the process, including warning output.
  }
};

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const listRotatedLogFiles = async (filePath: string): Promise<string[]> => {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => path.join(dir, entry.name));
};

const pruneRotatedFiles = async (
  filePath: string,
  rotation: LogRotationOptions,
): Promise<void> => {
  const rotatedPaths = await listRotatedLogFiles(filePath);
  if (rotatedPaths.length === 0) {
    return;
  }

  const now = Date.now();
  const maxAgeMs = rotation.maxAgeDays * MS_PER_DAY;
  const withStats: { rotatedPath: string; mtimeMs: number }[] = [];
  for (const rotatedPath of rotatedPaths) {
    try {
      const stat = await fs.stat(rotatedPath);
      withStats.push({ rotatedPath, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (!isEnoent(error)) {
        writeRotationWarning(rotatedPath, error);
      }
    }
  }

  const tooOld = withStats.filter((item) => now - item.mtimeMs > maxAgeMs);
  const remaining = withStats
    .filter((item) => now - item.mtimeMs <= maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  // maxFiles caps retained rotated files; the active log is extra.
  const overCount = remaining.slice(rotation.maxFiles);
  const seen = new Set<string>();
  for (const item of [...tooOld, ...overCount]) {
    if (seen.has(item.rotatedPath)) {
      continue;
    }
    seen.add(item.rotatedPath);
    try {
      await fs.unlink(item.rotatedPath);
    } catch (error) {
      if (!isEnoent(error)) {
        writeRotationWarning(item.rotatedPath, error);
      }
    }
  }
};

const rotateIfOversized = async (
  filePath: string,
  rotation: LogRotationOptions,
): Promise<boolean> => {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
  if (!stat.isFile()) {
    return false;
  }
  const maxBytes = rotation.maxFileMegabytes * BYTES_PER_MEGABYTE;
  if (stat.size < maxBytes) {
    return false;
  }

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const rotatedPath = `${filePath}.${stamp}`;
  await fs.rename(filePath, rotatedPath);
  try {
    await fs.chmod(rotatedPath, LOG_FILE_MODE);
  } catch (error) {
    writeRotationWarning(rotatedPath, error);
  }
  return true;
};

export const applyLogRotation = async (
  filePath: string,
  rotation: LogRotationOptions,
): Promise<boolean> => {
  if (!rotation.enabled) {
    return false;
  }

  let rotated = false;
  try {
    rotated = await rotateIfOversized(filePath, rotation);
  } catch (error) {
    writeRotationWarning(filePath, error);
    return false;
  }

  try {
    await pruneRotatedFiles(filePath, rotation);
  } catch (error) {
    writeRotationWarning(filePath, error);
  }

  return rotated;
};

const scheduleRotationChecks = (
  filePath: string,
  rotation: LogRotationOptions,
  fileStream: ReturnType<typeof pino.destination>,
): void => {
  let rotating = false;
  const run = (): void => {
    if (rotating) {
      return;
    }
    rotating = true;
    void (async () => {
      try {
        try {
          fileStream.flushSync();
        } catch {
          // Destination may already be closed; size check can still proceed.
        }
        const rotated = await applyLogRotation(filePath, rotation);
        if (!rotated) {
          return;
        }
        try {
          fileStream.reopen();
          await fs.chmod(filePath, LOG_FILE_MODE);
        } catch (error) {
          writeRotationWarning(filePath, error);
        }
      } catch (error) {
        writeRotationWarning(filePath, error);
      } finally {
        rotating = false;
      }
    })();
  };

  const timer = setInterval(run, LOG_ROTATION_CHECK_INTERVAL_MS);
  timer.unref();
  fileStream.once("close", () => clearInterval(timer));
};

export const createPrettyLogStream = (): pino.DestinationStream =>
  pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  });

export const createLogger = async (options: LoggerOptions): Promise<Logger> => {
  const rotation = options.rotation ?? DEFAULT_LOG_ROTATION;

  await ensureDir(path.dirname(options.file));
  if (rotation.enabled) {
    await applyLogRotation(options.file, rotation);
  }
  const handle = await fs.open(options.file, "a", LOG_FILE_MODE);
  await handle.close();
  await fs.chmod(options.file, LOG_FILE_MODE);

  const fileStream = pino.destination({
    dest: options.file,
    sync: false,
    mode: LOG_FILE_MODE,
  });
  if (rotation.enabled) {
    scheduleRotationChecks(options.file, rotation, fileStream);
  }

  const streams: pino.StreamEntry[] = [
    { level: options.level, stream: fileStream },
  ];

  if (!options.suppressConsole) {
    if (options.prettyConsole) {
      streams.push({ level: options.level, stream: createPrettyLogStream() });
    } else {
      streams.push({ level: options.level, stream: process.stdout });
    }
  }

  return pino(
    { level: options.level, redact: redactions },
    pino.multistream(streams),
  );
};

type ClosableStream = {
  end: () => void;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const isClosableStream = (stream: unknown): stream is ClosableStream =>
  typeof stream === "object" &&
  stream !== null &&
  stream !== process.stdout &&
  stream !== process.stderr &&
  typeof (stream as Partial<ClosableStream>).end === "function" &&
  typeof (stream as Partial<ClosableStream>).once === "function";

const isMultiStream = (stream: unknown): stream is pino.MultiStreamRes =>
  typeof stream === "object" &&
  stream !== null &&
  Array.isArray((stream as Partial<pino.MultiStreamRes>).streams);

const waitForClose = (
  stream: ClosableStream,
  timeoutMs: number,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // A destination that fails while closing has nothing left to deliver;
    // shutdown must proceed either way.
    stream.once("close", done);
    stream.once("error", done);
    try {
      stream.end();
    } catch {
      done();
    }
  });

/**
 * Drain and close the logger's own destinations before the process exits.
 *
 * logger.flush() is not enough for a logger from createLogger: the file
 * destination is an async pino.destination (SonicBoom) behind
 * pino.multistream, which has no flush(), so pino calls back immediately and
 * SonicBoom.flush() is a no-op at minLength 0. A line written just before the
 * process is killed (or before the file has even been opened) can be lost.
 * Ending the destination waits for the async open and any in-flight write,
 * writes the remaining buffer and emits "close" once the fd is closed.
 *
 * The closed destinations are detached from the multistream first, so logging
 * after closeLogger never throws; those lines are dropped. process.stdout and
 * process.stderr are flushed by Node itself and are never ended. The wait is
 * bounded by timeoutMs per call, and the returned promise never rejects.
 */
export const closeLogger = async (
  logger: Logger,
  timeoutMs: number = LOG_CLOSE_TIMEOUT_MS,
): Promise<void> => {
  const stream = (logger as unknown as Record<symbol, unknown>)[
    pino.symbols.streamSym
  ];
  if (!isMultiStream(stream)) {
    logger.flush?.();
    return;
  }

  const closable: ClosableStream[] = [];
  for (let index = stream.streams.length - 1; index >= 0; index -= 1) {
    const entry = stream.streams[index];
    if (entry && isClosableStream(entry.stream)) {
      closable.push(entry.stream);
      stream.streams.splice(index, 1);
    }
  }
  if (closable.length === 0) {
    return;
  }

  await Promise.all(
    closable.map((destination) => waitForClose(destination, timeoutMs)),
  );
};
