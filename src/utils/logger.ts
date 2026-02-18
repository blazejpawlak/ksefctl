import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir } from "./paths";

export type LoggerOptions = {
  level: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file: string;
  pretty: boolean;
  suppressConsole?: boolean;
};

const redactions = {
  paths: [
    "auth.keychainServiceName",
    "notifications.email.smtp.pass",
    "notifications.email.smtp.user",
    "notifications.email.smtp.from",
    "notifications.email.smtp.to",
    "headers.authorization",
    "headers.Authorization",
    "req.headers.authorization",
    "req.headers.Authorization",
    "authorization",
    "Authorization",
    "*.accessToken",
    "*.refreshToken",
    "*.ksefToken",
  ],
  censor: "***",
};

export const createLogger = async (options: LoggerOptions): Promise<Logger> => {
  await ensureDir(path.dirname(options.file));
  await fs.open(options.file, "a", 0o600).then((handle) => handle.close());
  await fs.chmod(options.file, 0o600);

  const fileStream = pino.destination({ dest: options.file, sync: false });
  const streams: pino.StreamEntry[] = [
    { level: options.level, stream: fileStream },
  ];

  if (!options.suppressConsole) {
    if (options.pretty) {
      const transport = pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      });
      streams.push({ level: options.level, stream: transport });
    } else {
      streams.push({ level: options.level, stream: process.stdout });
    }
  }

  return pino(
    { level: options.level, redact: redactions },
    pino.multistream(streams),
  );
};
