import { describe, expect, it } from "vitest";
import YAML from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { createContext } from "../../src/cli/context.js";
import { ConfigError } from "../../src/utils/errors.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("context", () => {
  it("rejects insecure apiBaseUrl without allowInsecureHttp", async () => {
    const tmpDir = await makeTempDir("ksef-context-");
    const configPath = path.join(tmpDir, "config.yaml");
    const configYaml = YAML.stringify({
      environment: "test",
      apiBaseUrl: "http://localhost",
      auth: {
        method: "ksefToken",
        keychainServiceName: "ksefctl-test",
      },
      organizations: [{ nip: "1234567890" }],
      pollingIntervalSeconds: 300,
      storage: { root: path.join(tmpDir, "storage") },
      notifications: { macosNotification: false, email: { enabled: false } },
      logging: {
        level: "info",
        file: path.join(tmpDir, "storage", "logs", "app.log"),
        pretty: false,
      },
      operational: {
        maxConcurrency: 2,
        timeoutSeconds: 60,
        pollIntervalSeconds: 10,
        allowInsecureHttp: false,
      },
      security: {
        tls: { enablePinning: false, pins: [], pinningHosts: [] },
        allowedHosts: [],
      },
      sync: { subjectTypes: ["Subject1"], includeMetadataHeader: true },
    });
    await fs.writeFile(configPath, configYaml, "utf-8");

    await expect(createContext(configPath)).rejects.toBeInstanceOf(ConfigError);
  });
});
