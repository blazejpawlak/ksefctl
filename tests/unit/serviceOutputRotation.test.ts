import type { AppConfig } from "../../src/config/schema.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { KSEFCTL_SERVICE_MODE } from "../../src/cli/serviceMode.js";
import { rotateServiceOutput } from "../../src/cli/serviceOutputRotation.js";
import { makeTempDir } from "../helpers/tempDir.js";

const MEGABYTE = 1024 * 1024;

const configFor = (root: string): AppConfig =>
  ({
    storage: { root },
    logging: {
      rotation: { enabled: true, maxFileMegabytes: 1, maxFiles: 5, maxAgeDays: 30 },
    },
  }) as AppConfig;

const setUp = async () => {
  const root = await makeTempDir("ksef-svcout-");
  const logs = path.join(root, "logs");
  await fs.mkdir(logs);
  const stdout = path.join(logs, "ksefctl.stdout.log");
  const err = path.join(logs, "ksefctl.err.log");
  await fs.writeFile(stdout, "o".repeat(MEGABYTE));
  await fs.writeFile(err, "e".repeat(MEGABYTE));
  return { root, logs, stdout, err };
};

describe("rotateServiceOutput", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rotates the service stdout and stderr files in managed service mode", async () => {
    vi.stubEnv(KSEFCTL_SERVICE_MODE, "1");
    const { root, logs, stdout, err } = await setUp();

    await rotateServiceOutput(configFor(root));

    expect((await fs.stat(stdout)).size).toBe(0);
    expect((await fs.stat(err)).size).toBe(0);
    const names = await fs.readdir(logs);
    expect(names.filter((name) => name.startsWith("ksefctl.stdout.log."))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("ksefctl.err.log."))).toHaveLength(1);
  });

  it("does nothing outside managed service mode", async () => {
    vi.stubEnv(KSEFCTL_SERVICE_MODE, "");
    const { root, logs, stdout } = await setUp();

    await rotateServiceOutput(configFor(root));

    expect((await fs.stat(stdout)).size).toBe(MEGABYTE);
    expect(await fs.readdir(logs)).toHaveLength(2);
  });
});
