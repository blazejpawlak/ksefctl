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

  const allowPrivilegedPaths = (allowedPaths: string[]) => {
    const originalLstat = fs.lstat.bind(fs);
    return vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
      if (typeof filePath === "string" && allowedPaths.includes(filePath)) {
        return {
          isSymbolicLink: () => false,
          mode: 0o100600,
          uid: 0,
        } as Awaited<ReturnType<typeof fs.lstat>>;
      }
      return originalLstat(filePath);
    });
  };

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
    process.env.NODE_OPTIONS = [
      "--localstorage-file",
      JSON.stringify("/tmp/local storage.json"),
      "--trace-warnings",
    ].join(" ");
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
      const privilegedPathSpy = allowPrivilegedPaths([
        "/usr/local/bin/node&",
        "/usr/local/bin/ksefctl<",
        "/tmp/ksefctl&.yml",
        storageRoot,
      ]);

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
      privilegedPathSpy.mockRestore();
    },
  );

  maybeIt(
    "rejects root installs when execution paths are not root-owned",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-service-"));
      const homeDir = path.join(tmpDir, "home");
      const storageRoot = path.join(tmpDir, "storage");
      const nodePath = path.join(tmpDir, "node");
      const cliPath = path.join(tmpDir, "ksefctl");
      const configPath = path.join(tmpDir, "ksefctl.yml");
      process.env.HOME = homeDir;
      await fs.mkdir(homeDir, { recursive: true });
      await fs.writeFile(nodePath, "node", "utf-8");
      await fs.writeFile(cliPath, "cli", "utf-8");
      await fs.writeFile(configPath, "config", "utf-8");
      if (process.getuid) {
        vi.spyOn(process, "getuid").mockReturnValue(0);
      }

      const installer = new ServiceInstaller();

      await expect(
        installer.install({
          configPath,
          storageRoot,
          nodePath,
          cliPath,
        }),
      ).rejects.toThrow("nodePath must be owned by root");
    },
  );

  maybeIt(
    "rejects root installs when storageRoot is not root-owned",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-service-"));
      const homeDir = path.join(tmpDir, "home");
      const storageRoot = path.join(tmpDir, "storage");
      const nodePath = "/usr/local/bin/node";
      const cliPath = "/usr/local/bin/ksefctl";
      const configPath = "/tmp/ksefctl.yml";
      process.env.HOME = homeDir;
      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(storageRoot, { recursive: true });
      if (process.getuid) {
        vi.spyOn(process, "getuid").mockReturnValue(0);
      }
      allowPrivilegedPaths([nodePath, cliPath, configPath]);

      const installer = new ServiceInstaller();

      await expect(
        installer.install({
          configPath,
          storageRoot,
          nodePath,
          cliPath,
        }),
      ).rejects.toThrow("storageRoot must be owned by root");
    },
  );

  maybeIt("refuses to overwrite a symlinked launchd plist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-service-"));
    const homeDir = path.join(tmpDir, "home");
    const storageRoot = path.join(tmpDir, "storage");
    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    const plistPath = path.join(launchAgentsDir, "com.ksefctl.plist");
    const targetPath = path.join(tmpDir, "other.plist");
    process.env.HOME = homeDir;
    await fs.mkdir(launchAgentsDir, { recursive: true });
    await fs.writeFile(targetPath, "target", "utf-8");
    await fs.symlink(targetPath, plistPath);
    if (process.getuid) {
      vi.spyOn(process, "getuid").mockReturnValue(501);
    }

    const installer = new ServiceInstaller();

    await expect(
      installer.install({
        configPath: "/tmp/ksefctl.yml",
        storageRoot,
        nodePath: "/usr/local/bin/node",
        cliPath: "/usr/local/bin/ksefctl",
      }),
    ).rejects.toThrow("Refusing to modify symlinked service file");
  });
});
