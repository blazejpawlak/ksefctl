import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveServiceLogPaths } from "../../src/cli/serviceLogPaths";

describe("resolveServiceLogPaths", () => {
  it("returns only the lifecycle log path by default", () => {
    const storageRoot = "/tmp/ksefctl";
    const lifecycleLogPath = "/tmp/ksefctl/logs/ksefctl.log";

    expect(
      resolveServiceLogPaths({
        appName: "ksefctl",
        storageRoot,
        lifecycleLogPath,
      }),
    ).toEqual([lifecycleLogPath]);
  });

  it("returns only stderr path when error mode is requested", () => {
    const storageRoot = "/tmp/ksefctl";

    expect(
      resolveServiceLogPaths({
        appName: "ksefctl",
        storageRoot,
        lifecycleLogPath: "/tmp/ksefctl/logs/ksefctl.log",
        error: true,
      }),
    ).toEqual([path.join(storageRoot, "logs", "ksefctl.err.log")]);
  });

  it("preserves a custom lifecycle log path", () => {
    const customLifecycleLogPath = "/var/log/ksefctl/custom.log";

    expect(
      resolveServiceLogPaths({
        appName: "ksefctl",
        storageRoot: "/tmp/ksefctl",
        lifecycleLogPath: customLifecycleLogPath,
      }),
    ).toEqual([customLifecycleLogPath]);
  });
});
