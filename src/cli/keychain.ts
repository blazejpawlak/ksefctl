import fs from "node:fs/promises";
import { resolveConfigPath } from "../config/loadConfig";
import { updateConfigFile } from "../config/saveConfig";
import { ConfigError } from "../utils/errors";
import { createContext } from "./context";
import { promptHidden, promptText } from "./prompt";

export const isValidNip = (value: string): boolean => /^\d{10}$/.test(value);

const ensureConfigExists = async (
  configPathOverride?: string,
): Promise<string> => {
  const configPath = resolveConfigPath(configPathOverride);
  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new ConfigError("System not initialized. Run 'ksefctl system init'.");
  }
  return configPath;
};

const addOrganization = async (
  configPath: string,
  nip: string,
): Promise<void> => {
  await updateConfigFile(configPath, (current) => {
    const organizations =
      (current.organizations as { nip: string; label?: string }[]) ?? [];
    if (!organizations.find((org) => org.nip === nip)) {
      organizations.push({ nip });
    }
    return { ...current, organizations };
  });
};

export const setSecret = async (
  configPathOverride?: string,
  nipArg?: string,
  tokenArg?: string,
  tokenFromStdin = false,
): Promise<{ nip: string }> => {
  const configPath = await ensureConfigExists(configPathOverride);
  const ctx = await createContext(configPath);

  const nipInput = nipArg ?? (await promptText("NIP (10 digits): "));
  if (!isValidNip(nipInput)) {
    throw new ConfigError("Invalid NIP format (expected 10 digits)");
  }
  let tokenInput = tokenArg ?? "";
  if (!tokenInput && tokenFromStdin) {
    const stdin = await readStdin();
    tokenInput = stdin.trim();
  }
  if (!tokenInput && !process.stdin.isTTY && !tokenFromStdin) {
    throw new ConfigError("Non-interactive mode requires --token-stdin");
  }
  if (!tokenInput) {
    tokenInput = await promptHidden("KSeF token: ");
  }
  if (!tokenInput) {
    throw new ConfigError("KSeF token is required");
  }

  await ctx.keychain.setKsefToken(ctx.config.environment, nipInput, tokenInput);
  await addOrganization(configPath, nipInput);

  return { nip: nipInput };
};

export const showSecrets = async (
  configPathOverride?: string,
): Promise<{ nip: string; present: boolean }[]> => {
  const configPath = await ensureConfigExists(configPathOverride);
  const ctx = await createContext(configPath);
  const entries = await Promise.all(
    ctx.config.organizations.map(async (org) => ({
      nip: org.nip,
      present: await ctx.keychain.hasEntry(ctx.config.environment, org.nip),
    })),
  );
  return entries;
};

export const clearSecret = async (
  configPathOverride: string | undefined,
  nip: string,
): Promise<void> => {
  if (!isValidNip(nip)) {
    throw new ConfigError("Invalid NIP format (expected 10 digits)");
  }
  const configPath = await ensureConfigExists(configPathOverride);
  const ctx = await createContext(configPath);
  await ctx.keychain.clear(ctx.config.environment, nip);
};

export const ensureSecretsForNips = async (
  configPathOverride: string | undefined,
  nips: string[],
  allowPrompt = true,
): Promise<void> => {
  const configPath = await ensureConfigExists(configPathOverride);
  const ctx = await createContext(configPath);
  if (!process.stdin.isTTY || !allowPrompt) {
    const missing = [] as string[];
    for (const nip of nips) {
      const present = await ctx.keychain.hasEntry(ctx.config.environment, nip);
      if (!present) missing.push(nip);
    }
    if (missing.length > 0) {
      throw new ConfigError(
        `Missing keychain token for NIP(s): ${missing.join(", ")}. Run 'ksefctl system secret set' interactively.`,
      );
    }
    return;
  }

  for (const nip of nips) {
    const present = await ctx.keychain.hasEntry(ctx.config.environment, nip);
    if (!present) {
      await setSecret(configPathOverride, nip);
    }
  }
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (Buffer.isBuffer(value)) {
      chunks.push(value);
      continue;
    }
    if (typeof value === "string") {
      chunks.push(Buffer.from(value, "utf-8"));
      continue;
    }
    if (value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
      continue;
    }
    throw new ConfigError("Unsupported stdin chunk type");
  }
  return Buffer.concat(chunks).toString("utf-8");
};
