const secretKeyPattern =
  /(\b(?:access[_-]?token|api[_-]?key|authorization|passwd|password|refresh[_-]?token|secret|sig(?:nature)?|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;#&]+(?:\s+[^\s,;#&]+)?)/gi;

const secretQueryParamPattern =
  /([?&](?:access[_-]?token|api[_-]?key|authorization|passwd|password|refresh[_-]?token|secret|sig(?:nature)?|token)=)[^&#\s]+/gi;

const bearerTokenPattern = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/g;
const urlUserInfoPattern = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const maxSanitizedMessageLength = 500;

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

const truncateErrorMessage = (message: string): string => {
  if (message.length <= maxSanitizedMessageLength) {
    return message;
  }
  return `${message.slice(0, maxSanitizedMessageLength - 3)}...`;
};

const sanitizeGenericErrorMessage = (message: string): string =>
  truncateErrorMessage(
    message
      .replace(urlUserInfoPattern, "$1[REDACTED]@")
      .replace(bearerTokenPattern, "$1 [REDACTED]")
      .replace(secretQueryParamPattern, "$1[REDACTED]")
      .replace(secretKeyPattern, "$1[REDACTED]"),
  );

export const sanitizeErrorMessage = (message: string): string => {
  const networkFailurePrefix = "Network failure: ";
  if (message.startsWith(networkFailurePrefix)) {
    const sanitized = sanitizeGenericErrorMessage(
      sanitizeHttpErrorMessage(message.slice(networkFailurePrefix.length)),
    );
    return `${networkFailurePrefix}${sanitized}`;
  }
  return sanitizeGenericErrorMessage(sanitizeHttpErrorMessage(message));
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
