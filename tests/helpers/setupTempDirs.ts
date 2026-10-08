import { afterAll, afterEach, beforeEach } from "vitest";
import { cleanupTempDirs, setTestRunning } from "./tempDir.js";

// Registered at the root of every test file. Vitest runs `after*` hooks in
// reverse order of registration, which puts this cleanup after each file's own
// hooks: logger, server and database handles are closed before their directory
// is removed. The hooks also run when a test fails or times out.
beforeEach(() => {
  setTestRunning(true);
});

afterEach(async () => {
  setTestRunning(false);
  await cleanupTempDirs("test");
});

afterAll(async () => {
  await cleanupTempDirs("all");
});
