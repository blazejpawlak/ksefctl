const sanitizeHttpErrorMessage = (message: string): string => {
  const withRequestId =
    /^(HTTP \d{3} [A-Z]+ \S+)(?:: [\s\S]*?)?( \(requestId=[^)]+\))$/.exec(
      message,
    );
  if (withRequestId) {
    return `${withRequestId[1]}${withRequestId[2] ?? ""}`;
  }

  const withoutRequestId = /^(HTTP \d{3} [A-Z]+ \S+)(?:: [\s\S]*)$/.exec(
    message,
  );
  if (withoutRequestId) {
    return withoutRequestId[1] ?? message;
  }

  return message;
};

export const sanitizeErrorMessage = (message: string): string => {
  const networkFailurePrefix = "Network failure: ";
  if (message.startsWith(networkFailurePrefix)) {
    const sanitized = sanitizeHttpErrorMessage(
      message.slice(networkFailurePrefix.length),
    );
    return `${networkFailurePrefix}${sanitized}`;
  }
  return sanitizeHttpErrorMessage(message);
};

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
