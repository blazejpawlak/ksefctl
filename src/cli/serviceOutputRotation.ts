import type { AppConfig } from "../config/schema.js";
import { resolveServiceOutputPath } from "../services/serviceInstaller.js";
import {
  applyCopyTruncateRotation,
  restrictLogFileMode,
} from "../utils/logger.js";
import { isManagedServiceMode } from "./serviceMode.js";

/**
 * Caps the launchd service's stdout and stderr files with the
 * logging.rotation limits. launchd never rotates them, and renaming them
 * (newsyslog) would leave the running service writing to the renamed file.
 * Also makes both files owner-only: launchd creates them 0644 before the
 * job's Umask applies, and they hold NIPs and invoice paths.
 * Outside managed service mode, or where the files do not exist (systemd
 * sends service output to journald), this does nothing. Never throws.
 */
export const rotateServiceOutput = async (config: AppConfig): Promise<void> => {
  if (!isManagedServiceMode()) return;
  for (const stream of ["stdout", "err"] as const) {
    const filePath = resolveServiceOutputPath(config.storage.root, stream);
    await applyCopyTruncateRotation(filePath, config.logging.rotation);
    await restrictLogFileMode(filePath);
  }
};
