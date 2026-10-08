import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempTree } from "./tempDir.js";

// Node's own compile cache lands in `os.tmpdir()` too; it is not ours.
const ignoredEntries = new Set(["node-compile-cache"]);

let runDir: string | undefined;
let previousTmpdir: string | undefined;

/**
 * Point `os.tmpdir()` of the whole run (workers and child processes inherit
 * the environment) at a directory of its own. Everything the tests or the code
 * under test put in the temp directory then lands there, so teardown can tell
 * a leak from another process's files, such as a parallel vitest run.
 */
export const setup = async (): Promise<void> => {
  previousTmpdir = process.env.TMPDIR;
  runDir = await mkdtemp(path.join(os.tmpdir(), "ksefctl-vitest-"));
  process.env.TMPDIR = runDir;
};

/**
 * Fail the run if anything is left in the run directory. It is removed either
 * way, so a leak never accumulates in the real temp directory.
 */
export const teardown = async (): Promise<void> => {
  const dir = runDir;
  runDir = undefined;
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
  if (!dir) {
    return;
  }
  const leaked = (await readdir(dir)).filter(
    (name) => !ignoredEntries.has(name),
  );
  await removeTempTree(dir);
  if (leaked.length > 0) {
    throw new Error(
      `tests left ${leaked.length} entr${leaked.length === 1 ? "y" : "ies"} in the temp directory: ${leaked.join(", ")}. Create temp directories with makeTempDir() from tests/helpers/tempDir.ts.`,
    );
  }
};
