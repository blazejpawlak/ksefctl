import { afterEach, describe, expect, it, vi } from "vitest";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../src/utils/logger.js";
import {
  installServiceStopSignalLogging,
  installShutdownController,
  logServiceLifecycle,
  resolveServiceInitiator,
} from "../../src/utils/serviceLifecycle.js";

const originalEnv = {
  SUDO_USER: process.env.SUDO_USER,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
};

const setEnv = (values: {
  SUDO_USER?: string | undefined;
  USER?: string | undefined;
  LOGNAME?: string | undefined;
}): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

afterEach(() => {
  setEnv(originalEnv);
  vi.restoreAllMocks();
});

describe("serviceLifecycle", () => {
  it("prefers sudo user when resolving the lifecycle initiator", () => {
    setEnv({ SUDO_USER: "alice", USER: "root", LOGNAME: "root" });
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "root",
      uid: 0,
      gid: 0,
      shell: "/bin/zsh",
      homedir: "/var/root",
    });

    const initiator = resolveServiceInitiator();

    expect(initiator.initiatedBy).toBe("alice");
    expect(initiator.initiatorSource).toBe("sudo_user");
    expect(initiator.effectiveUser).toBe("root");
    expect(initiator.effectiveUid).toBe(process.getuid?.() ?? null);
  });

  it("falls back to unknown when no initiator details are available", () => {
    setEnv({ SUDO_USER: undefined, USER: undefined, LOGNAME: undefined });
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("user lookup failed");
    });

    const initiator = resolveServiceInitiator();

    expect(initiator).toEqual({
      initiatedBy: "unknown",
      initiatorSource: "unknown",
      effectiveUser: null,
      effectiveUid: process.getuid?.() ?? null,
    });
  });

  it("logs structured restart metadata", () => {
    setEnv({ SUDO_USER: "alice", USER: "root", LOGNAME: "root" });
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "root",
      uid: 0,
      gid: 0,
      shell: "/bin/zsh",
      homedir: "/var/root",
    });
    const info =
      vi.fn<(payload: Record<string, unknown>, message: string) => void>();
    const logger = { info };

    logServiceLifecycle(logger as never, {
      action: "restart",
      stage: "initiated",
      origin: "cli",
      reason: "service-restart",
      context: { serviceManager: "systemd" },
    });

    expect(info).toHaveBeenCalledOnce();
    const firstCall = info.mock.calls[0];

    expect(firstCall).toBeDefined();
    const [payload, message] = firstCall as [
      Record<string, unknown> & { lifecycleAt?: unknown },
      string,
    ];

    expect(message).toBe("Service restart initiated");
    expect(payload).toMatchObject({
      lifecycleAction: "restart",
      lifecycleStage: "initiated",
      lifecycleOrigin: "cli",
      initiatedBy: "alice",
      initiatorSource: "sudo_user",
      effectiveUser: "root",
      reason: "service-restart",
      serviceManager: "systemd",
    });
    expect(payload).toHaveProperty("lifecycleAt");
    expect(typeof payload.lifecycleAt).toBe("string");
  });

  it("logs stop signal metadata and re-sends the signal", async () => {
    setEnv({
      SUDO_USER: undefined,
      USER: "service-user",
      LOGNAME: "service-user",
    });
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "service-user",
      uid: 1000,
      gid: 1000,
      shell: "/bin/bash",
      homedir: "/home/service-user",
    });
    const logger = { info: vi.fn(), flush: vi.fn() };
    const handlers = new Map<string, () => void>();

    vi.spyOn(process, "on").mockImplementation(((
      event: string | symbol,
      listener: () => void,
    ) => {
      if (typeof event === "string") {
        handlers.set(event, listener);
      }
      return process;
    }) as typeof process.on);
    const offSpy = vi
      .spyOn(process, "off")
      .mockImplementation(
        ((_: string | symbol, __: () => void) => process) as typeof process.off,
      );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(
        ((_: number, __: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    installServiceStopSignalLogging(logger as never);
    handlers.get("SIGTERM")?.();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycleAction: "stop",
        lifecycleStage: "signal_received",
        lifecycleOrigin: "service",
        initiatedBy: "service-user",
        signal: "SIGTERM",
        reason: "process-signal",
      }),
      "Service stop signal received",
    );
    expect(logger.flush).toHaveBeenCalledOnce();
    expect(offSpy).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    });
  });

  it("writes the stop line to the log file before re-raising the signal", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ksef-lifecycle-"));
    const filePath = path.join(tmpDir, "ksefctl.log");
    const logger = await createLogger({
      level: "info",
      file: filePath,
      prettyConsole: false,
      suppressConsole: true,
      rotation: {
        enabled: false,
        maxFileMegabytes: 1,
        maxFiles: 1,
        maxAgeDays: 1,
      },
    });
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string | symbol,
      listener: () => void,
    ) => {
      if (typeof event === "string") {
        handlers.set(event, listener);
      }
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "off").mockImplementation(
      ((_: string | symbol, __: () => void) => process) as typeof process.off,
    );
    // Read synchronously at kill time: anything not on disk by then is lost.
    let contentAtKill: string | null = null;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      _: number,
      __: NodeJS.Signals | number,
    ) => {
      contentAtKill = fsSync.readFileSync(filePath, "utf-8");
      return true;
    }) as typeof process.kill);

    const controller = installShutdownController(logger);
    handlers.get("SIGTERM")?.();
    await controller.finalize();

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(contentAtKill).toContain("Service stop signal received");
  });
});
