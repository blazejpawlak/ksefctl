import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Named imports on purpose: tests spy on the default `fs` object (for example
// `vi.spyOn(fs, "open")`), and the helper must neither trip those spies nor be
// broken by them.

type Scope = "test" | "file";

const tempDirs: Record<Scope, Set<string>> = {
  test: new Set(),
  file: new Set(),
};

// Tests inside a file run one after another, so a single flag is enough to
// tell a directory made by a test (or its beforeEach) from one made by a
// beforeAll. `it.concurrent` would break that assumption; none is used.
let testRunning = false;

export const setTestRunning = (running: boolean): void => {
  testRunning = running;
};

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

// Tests chmod directories read-only on purpose; rm cannot unlink their
// children until the owner has write and search permission back.
const makeTreeWritable = async (target: string): Promise<void> => {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return;
  }
  await chmod(target, 0o700);
  for (const name of await readdir(target)) {
    await makeTreeWritable(path.join(target, name));
  }
};

export const removeTempTree = async (dir: string): Promise<void> => {
  const options = { recursive: true, force: true, maxRetries: 3 } as const;
  try {
    await rm(dir, options);
  } catch (error) {
    if (errorCode(error) !== "EACCES" && errorCode(error) !== "EPERM") {
      throw error;
    }
    await makeTreeWritable(dir);
    await rm(dir, options);
  }
};

/**
 * Create a temp directory under `os.tmpdir()` and register it for removal: at
 * the end of the current test, or at the end of the file when called from a
 * beforeAll. Keep a descriptive `prefix`, it shows which test left a directory
 * behind if the leak guard ever reports one.
 */
export const makeTempDir = async (prefix: string): Promise<string> => {
  const scope: Scope = testRunning ? "test" : "file";
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs[scope].add(dir);
  return dir;
};

export const cleanupTempDirs = async (scope: Scope | "all"): Promise<void> => {
  const scopes: Scope[] = scope === "all" ? ["test", "file"] : [scope];
  const dirs = scopes.flatMap((name) => {
    const registered = [...tempDirs[name]];
    tempDirs[name].clear();
    return registered;
  });
  const results = await Promise.allSettled(dirs.map(removeTempTree));
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to remove temp directories");
  }
};
