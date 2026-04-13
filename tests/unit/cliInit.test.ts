import { describe, expect, it } from "vitest";
import YAML from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initConfig } from "../../src/cli/init";

describe("initConfig", () => {
  it("writes a config template with 0600 permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-init-"));
    const configPath = path.join(tmpDir, "config.yaml");

    await initConfig(configPath);

    const stats = await fs.stat(configPath);
    expect(stats.mode & 0o777).toBe(0o600);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    expect(parsed.environment).toBe("prod");
    expect(Array.isArray(parsed.organizations)).toBe(true);
  });

  it("does not overwrite existing config when force=false", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-init-"));
    const configPath = path.join(tmpDir, "config.yaml");
    await fs.writeFile(configPath, "environment: test\n", {
      encoding: "utf-8",
      mode: 0o600,
    });

    await initConfig(configPath, false);

    const raw = await fs.readFile(configPath, "utf-8");
    expect(raw.trim()).toBe("environment: test");
  });

  it("overwrites existing config when force=true", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-init-"));
    const configPath = path.join(tmpDir, "config.yaml");
    await fs.writeFile(configPath, "environment: test\n", {
      encoding: "utf-8",
      mode: 0o600,
    });

    await initConfig(configPath, true);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    // Template sets environment to "prod"
    expect(parsed.environment).toBe("prod");
  });

  it("returns the resolved config path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-init-"));
    const configPath = path.join(tmpDir, "config.yaml");

    const returned = await initConfig(configPath);

    expect(returned).toBe(configPath);
  });

  it("creates intermediate directories when they are absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-init-"));
    const configPath = path.join(tmpDir, "nested", "dir", "config.yaml");

    await initConfig(configPath);

    const stats = await fs.stat(configPath);
    expect(stats.isFile()).toBe(true);
  });
});
