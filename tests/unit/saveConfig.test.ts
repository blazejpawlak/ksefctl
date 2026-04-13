import { describe, expect, it } from "vitest";
import YAML from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateConfigFile } from "../../src/config/saveConfig";

const writeYaml = async (
  filePath: string,
  content: Record<string, unknown>,
): Promise<void> => {
  await fs.writeFile(filePath, YAML.stringify(content), {
    encoding: "utf-8",
    mode: 0o600,
  });
};

describe("updateConfigFile", () => {
  it("writes updated config atomically with 0600 permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    await writeYaml(configPath, { environment: "test", version: 1 });

    await updateConfigFile(configPath, (current) => ({
      ...current,
      version: 2,
    }));

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    const stats = await fs.stat(configPath);

    expect(parsed.version).toBe(2);
    expect(parsed.environment).toBe("test");
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent updates — no interleaving or lost writes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    await writeYaml(configPath, { counter: 0 });

    // Launch 10 concurrent increments; without a lock these would race
    const increments = 10;
    await Promise.all(
      Array.from({ length: increments }, () =>
        updateConfigFile(configPath, (current) => ({
          ...current,
          counter: ((current.counter as number) ?? 0) + 1,
        })),
      ),
    );

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    expect(parsed.counter).toBe(increments);
  });

  it("enforces 0600 even when overwriting a pre-existing 0644 config", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    await fs.writeFile(configPath, YAML.stringify({ key: "value" }), {
      encoding: "utf-8",
      mode: 0o644,
    });

    await updateConfigFile(configPath, (c) => ({ ...c, updated: true }));

    const stats = await fs.stat(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
