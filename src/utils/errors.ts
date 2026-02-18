export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export const exitCodeFromError = (error: unknown): number => {
  if (error instanceof ConfigError) return 4;
  if (error instanceof AuthError) return 2;
  if (error instanceof NetworkError) return 3;
  return 5;
};
