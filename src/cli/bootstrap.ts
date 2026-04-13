import fs from "node:fs/promises";
import { resolveConfigPath } from "../config/loadConfig";
import { updateConfigFile } from "../config/saveConfig";
import { ConfigError } from "../utils/errors";
import { createContext } from "./context";
import { initConfig } from "./init";
import { promptHidden, promptText } from "./prompt";

const PROD_URL = "https://api.ksef.mf.gov.pl/v2";
const TEST_URL = "https://api-test.ksef.mf.gov.pl/v2";

const isValidNip = (value: string): boolean => /^\d{10}$/.test(value);

const promptEnvironment = async (
  current?: string,
): Promise<"prod" | "test"> => {
  const defaultChoice = current === "test" ? "2" : "1";
  while (true) {
    console.log("Select environment:");
    console.log(`1) Production (${PROD_URL})`);
    console.log(`2) Test (${TEST_URL})`);
    const answer = await promptText(`Choice [${defaultChoice}]: `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === "") {
      return defaultChoice === "2" ? "test" : "prod";
    }
    if (normalized === "2" || normalized === "test") return "test";
    if (
      normalized === "1" ||
      normalized === "prod" ||
      normalized === "production"
    ) {
      return "prod";
    }
    console.log("Invalid choice. Please select 1 or 2.");
  }
};

export const getInitializationStatus = async (configPathOverride?: string) => {
  const configPath = resolveConfigPath(configPathOverride);
  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return { initialized: false, configPath, missingNips: [] as string[] };
  }
  const ctx = await createContext(configPathOverride);
  const nips = ctx.config.organizations.map((org) => org.nip);
  if (nips.length === 0) {
    return { initialized: false, configPath, missingNips: [] as string[] };
  }
  const missingNips: string[] = [];
  for (const nip of nips) {
    const present = await ctx.keychain.hasEntry(ctx.config.environment, nip);
    if (!present) missingNips.push(nip);
  }
  return { initialized: missingNips.length === 0, configPath, missingNips };
};

export const ensureInitialized = async (configPathOverride?: string) => {
  const status = await getInitializationStatus(configPathOverride);
  if (!status.initialized) {
    if (status.missingNips.length > 0) {
      throw new ConfigError(
        `Missing keychain token for NIP(s): ${status.missingNips.join(", ")}. Run "ksefctl system secret set".`,
      );
    }
    throw new ConfigError("System not initialized. Run \"ksefctl system init\".");
  }
  return status;
};

export const bootstrapInteractive = async (
  configPathOverride?: string,
): Promise<void> => {
  if (!process.stdin.isTTY) {
    throw new ConfigError("Bootstrap requires an interactive terminal");
  }
  const configPath = await initConfig(configPathOverride, false);
  const ctx = await createContext(configPath);

  const selectedEnv = await promptEnvironment(ctx.config.environment);
  await updateConfigFile(configPath, (current) => ({
    ...current,
    environment: selectedEnv,
  }));

  const organizations = [...ctx.config.organizations];
  for (const org of organizations) {
    const present = await ctx.keychain.hasEntry(selectedEnv, org.nip);
    if (!present) {
      const token = await promptHidden(`KSeF token for NIP ${org.nip}: `);
      if (!token) {
        throw new ConfigError("KSeF token is required");
      }
      await ctx.keychain.setKsefToken(selectedEnv, org.nip, token);
    }
  }

  const addNipFlow = async () => {
    const nip = await promptText("NIP (10 digits): ");
    if (!isValidNip(nip)) {
      throw new ConfigError("Invalid NIP format (expected 10 digits)");
    }
    const token = await promptHidden(`KSeF token for NIP ${nip}: `);
    if (!token) {
      throw new ConfigError("KSeF token is required");
    }
    await ctx.keychain.setKsefToken(selectedEnv, nip, token);
    if (!organizations.find((org) => org.nip === nip)) {
      organizations.push({ nip });
    }
  };

  if (organizations.length === 0) {
    await addNipFlow();
  }

  while (true) {
    const addMore = await promptText("Add another NIP? (y/N): ");
    if (!addMore || !/^y(es)?$/i.test(addMore.trim())) break;
    await addNipFlow();
  }

  if (organizations.length === 0) {
    throw new ConfigError("At least one NIP is required to initialize");
  }

  await updateConfigFile(configPath, (current) => ({
    ...current,
    environment: selectedEnv,
    organizations,
  }));
};

export const resetAndBootstrap = async (
  configPathOverride?: string,
): Promise<void> => {
  const configPath = resolveConfigPath(configPathOverride);
  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    const ctx = await createContext(configPathOverride);
    await ctx.keychain.clearAll();
    await fs.rm(configPath, { force: true });
  }
  await bootstrapInteractive(configPathOverride);
};
