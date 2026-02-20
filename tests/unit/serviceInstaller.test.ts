import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceInstaller } from "../../src/services/serviceInstaller";

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      (callback as ExecCallback)(null, "", "");
    }
  }),
}));

const isDarwin = process.platform === "darwin";
const maybeIt = isDarwin ? it : it.skip;

describe("ServiceInstaller", () => {
  const originalHome = process.env.HOME;
  const originalNodeOptions = process.env.NODE_OPTIONS;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.NODE_OPTIONS = originalNodeOptions;
    vi.restoreAllMocks();
  });

  maybeIt("writes launchd plist with daemon output paths", async () => {
    // Arrange
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-service-"));
    const homeDir = path.join(tmpDir, "home");
    const storageRoot = path.join(tmpDir, "storage");
    process.env.HOME = homeDir;
    process.env.NODE_OPTIONS =
      "--localstorage-file \"/tmp/local storage.json\" --trace-warnings";
    if (process.getuid) {
      vi.spyOn(process, "getuid").mockReturnValue(501);
    }

    // Act
    const installer = new ServiceInstaller();
    const plistPath = await installer.install({
      configPath: "/tmp/ksefctl.yml",
      storageRoot,
      nodePath: "/usr/local/bin/node",
      cliPath: "/usr/local/bin/ksefctl",
    });
    const plist = await fs.readFile(plistPath, "utf-8");

    // Assert
    const outPath = path.join(storageRoot, "logs", "ksefctl.out.log");
    const errPath = path.join(storageRoot, "logs", "ksefctl.err.log");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain(
      `<key>StandardOutPath</key><string>${outPath}</string>`,
    );
    expect(plist).toContain(
      `<key>StandardErrorPath</key><string>${errPath}</string>`,
    );
    expect(plist).toContain(
      "<key>NODE_OPTIONS</key><string>--localstorage-file &quot;/tmp/local storage.json&quot;</string>",
    );
  });

  maybeIt(
    "escapes launchd plist values and omits NODE_OPTIONS when root",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-service-"));
      const homeDir = path.join(tmpDir, "home");
      const storageRoot = path.join(tmpDir, "storage & logs");
      process.env.HOME = homeDir;
      process.env.NODE_OPTIONS = "--localstorage-file=/tmp/local.json";
      if (process.getuid) {
        vi.spyOn(process, "getuid").mockReturnValue(0);
      }

      const installer = new ServiceInstaller();
      const plistPath = await installer.install({
        configPath: "/tmp/ksefctl&.yml",
        storageRoot,
        nodePath: "/usr/local/bin/node&",
        cliPath: "/usr/local/bin/ksefctl<",
      });
      const plist = await fs.readFile(plistPath, "utf-8");

      expect(plist).toContain("<string>/usr/local/bin/node&amp;</string>");
      expect(plist).toContain("<string>/usr/local/bin/ksefctl&lt;</string>");
      expect(plist).toContain("<string>/tmp/ksefctl&amp;.yml</string>");
      expect(plist).toContain(
        `<key>WorkingDirectory</key><string>${storageRoot.replace("&", "&amp;")}</string>`,
      );
      expect(plist).not.toContain("NODE_OPTIONS");
    },
  );
});
