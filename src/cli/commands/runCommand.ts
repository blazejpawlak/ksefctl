import type { Logger } from "pino";
import {
  AuthError,
  ConfigError,
  NetworkError,
  exitCodeFromError,
  formatConfigErrorMessage,
  formatErrorMessage,
} from "../../utils/errors.js";
import { sanitizeForTerminal } from "../commandTree.js";

export type RootOptions = {
  config?: string;
  verbose?: boolean;
  firstRun?: boolean;
};

const isKnownError = (error: unknown): boolean =>
  error instanceof ConfigError ||
  error instanceof AuthError ||
  error instanceof NetworkError;

// Config diagnostics are a multi-line list of violations: keep the line breaks
// (and the full list) instead of the single-line 500-character form.
export const formatCliError = (error: unknown): string =>
  error instanceof ConfigError
    ? formatConfigErrorMessage(error.message)
    : sanitizeForTerminal(formatErrorMessage(error));

export const logUnexpectedError = (
  error: unknown,
  logger: Logger | null | undefined,
  logFile: string | null | undefined,
): string => {
  if (!isKnownError(error) && logger) {
    logger.error({ err: error }, "Unexpected error in command handler");
  }
  return !isKnownError(error) && logFile
    ? `\nCheck log for details: ${logFile}`
    : "";
};

export const runCommand =
  <TArgs extends unknown[]>(fn: (...args: TArgs) => Promise<void>) =>
  async (...args: TArgs): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = exitCodeFromError(error);
    }
  };
