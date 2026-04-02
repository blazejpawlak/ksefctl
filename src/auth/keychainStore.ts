import type { AppConfig } from "../config/schema";
import type { Logger } from "pino";

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(
    service: string,
  ): Promise<{ account: string; password: string }[]>;
};

let keytarModulePromise: Promise<KeytarModule> | undefined;

const loadKeytar = async (): Promise<KeytarModule> => {
  keytarModulePromise ??= import("keytar").then((module) => {
    const keytar = "default" in module ? module.default : module;
    return keytar as KeytarModule;
  });
  return keytarModulePromise;
};

export type KeychainEntry = {
  ksefToken: string;
  accessToken?: string;
  accessTokenValidUntil?: string;
  refreshToken?: string;
  refreshTokenValidUntil?: string;
};

export class KeychainStore {
  private service: string;
  private logger: Logger;

  constructor(service: string, logger: Logger) {
    this.service = service;
    this.logger = logger;
  }

  static fromConfig(config: AppConfig, logger: Logger): KeychainStore {
    const service = config.auth.keychainServiceName ?? "ksefctl";
    return new KeychainStore(service, logger);
  }

  buildAccount(environment: string, nip: string): string {
    return `${environment}:nip:${nip}`;
  }

  private getEnvAliases(environment: string): string[] {
    if (environment === "prod") return ["production"];
    if (environment === "test") return ["integ", "demo", "test"];
    return [];
  }

  async getEntry(
    environment: string,
    nip: string,
  ): Promise<KeychainEntry | null> {
    const keytar = await loadKeytar();
    const account = this.buildAccount(environment, nip);
    const raw = await keytar.getPassword(this.service, account);
    const parseEntry = (value: string | null): KeychainEntry | null => {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value) as KeychainEntry;
        if (
          !parsed ||
          typeof parsed.ksefToken !== "string" ||
          parsed.ksefToken.length === 0
        ) {
          return null;
        }
        return parsed;
      } catch (error) {
        this.logger.warn(
          { err: (error as Error).message },
          "Failed to parse keychain entry",
        );
        return null;
      }
    };

    const parsed = parseEntry(raw);
    if (parsed) return parsed;

    for (const alias of this.getEnvAliases(environment)) {
      const aliasAccount = this.buildAccount(alias, nip);
      const aliasRaw = await keytar.getPassword(this.service, aliasAccount);
      const aliasParsed = parseEntry(aliasRaw);
      if (aliasParsed) {
        await this.setEntry(environment, nip, aliasParsed);
        await keytar.deletePassword(this.service, aliasAccount);
        return aliasParsed;
      }
    }
    return null;
  }

  async setEntry(
    environment: string,
    nip: string,
    entry: KeychainEntry,
  ): Promise<void> {
    const keytar = await loadKeytar();
    const account = this.buildAccount(environment, nip);
    await keytar.setPassword(this.service, account, JSON.stringify(entry));
  }

  async setKsefToken(
    environment: string,
    nip: string,
    token: string,
  ): Promise<void> {
    const existing = (await this.getEntry(environment, nip)) ?? {
      ksefToken: token,
    };
    await this.setEntry(environment, nip, { ...existing, ksefToken: token });
  }

  async setTokens(
    environment: string,
    nip: string,
    tokens: Pick<
      KeychainEntry,
      | "accessToken"
      | "accessTokenValidUntil"
      | "refreshToken"
      | "refreshTokenValidUntil"
    >,
  ): Promise<void> {
    const existing = await this.getEntry(environment, nip);
    if (!existing?.ksefToken) {
      throw new Error("Missing KSeF token in keychain");
    }
    await this.setEntry(environment, nip, { ...existing, ...tokens });
  }

  async hasEntry(environment: string, nip: string): Promise<boolean> {
    const entry = await this.getEntry(environment, nip);
    return Boolean(entry?.ksefToken);
  }

  async clear(environment: string, nip: string): Promise<void> {
    const keytar = await loadKeytar();
    const account = this.buildAccount(environment, nip);
    await keytar.deletePassword(this.service, account);
  }

  async clearAll(): Promise<void> {
    const keytar = await loadKeytar();
    const credentials = await keytar.findCredentials(this.service);
    for (const credential of credentials) {
      await keytar.deletePassword(this.service, credential.account);
    }
  }
}
