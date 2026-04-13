import { describe, expect, it, vi } from "vitest";
import { logUnexpectedError } from "../../src/cli";
import {
  AuthError,
  ConfigError,
  NetworkError,
} from "../../src/utils/errors";

const makeLogger = () => ({
  error: vi.fn(),
});

describe("logUnexpectedError", () => {
  it("logs full error to pino and returns logFile hint for unknown errors", () => {
    const logger = makeLogger();
    const err = new TypeError("something broke internally");

    const hint = logUnexpectedError(err, logger as never, "/var/log/ksefctl.log");

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err },
      "Unexpected error in command handler",
    );
    expect(hint).toContain("/var/log/ksefctl.log");
  });

  it("does not log or hint for ConfigError", () => {
    const logger = makeLogger();
    const hint = logUnexpectedError(
      new ConfigError("bad config"),
      logger as never,
      "/log",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(hint).toBe("");
  });

  it("does not log or hint for AuthError", () => {
    const logger = makeLogger();
    const hint = logUnexpectedError(
      new AuthError("auth failed"),
      logger as never,
      "/log",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(hint).toBe("");
  });

  it("does not log or hint for NetworkError", () => {
    const logger = makeLogger();
    const hint = logUnexpectedError(
      new NetworkError("connection refused"),
      logger as never,
      "/log",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(hint).toBe("");
  });

  it("returns empty hint when logFile is null, even for unknown errors", () => {
    const logger = makeLogger();
    const hint = logUnexpectedError(new TypeError("oops"), logger as never, null);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(hint).toBe("");
  });

  it("skips pino call when no logger is available", () => {
    const hint = logUnexpectedError(new TypeError("oops"), null, "/log");
    expect(hint).toContain("/log");
  });
});
