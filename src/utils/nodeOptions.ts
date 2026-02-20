const tokenPattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

export const parseNodeOptions = (value: string): string[] => {
  const matches = value.match(tokenPattern) ?? [];
  return matches.map((token) => {
    const first = token[0];
    const last = token[token.length - 1];
    if (first === undefined || last === undefined) return token;
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
    return token;
  });
};

export const quoteNodeOptionToken = (token: string): string => {
  if (!/[\s"]/g.test(token)) return token;
  const escaped = token.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"${escaped}"`;
};

export const sanitizeNodeOptions = (value?: string): string[] => {
  const tokens = value ? parseNodeOptions(value) : [];
  const sanitized: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--localstorage-file") {
      const next = tokens[index + 1];
      if (next && !next.startsWith("-")) {
        sanitized.push(token, next);
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--localstorage-file=")) {
      let pathValue = token.slice("--localstorage-file=".length);
      if (pathValue) {
        const first = pathValue[0];
        const last = pathValue[pathValue.length - 1];
        if (
          (first === "\"" && last === "\"") ||
          (first === "'" && last === "'")
        ) {
          pathValue = pathValue.slice(1, -1);
        }
        sanitized.push(`--localstorage-file=${pathValue}`);
      }
      continue;
    }
  }
  return sanitized;
};

export const buildNodeOptionsWithLocalstorage = (
  value: string | undefined,
  localstoragePath: string,
): string => {
  const sanitized = sanitizeNodeOptions(value);
  if (sanitized.length === 0) {
    sanitized.push(`--localstorage-file=${localstoragePath}`);
  }
  return sanitized
    .map((token) => {
      if (token.startsWith("--localstorage-file=")) {
        const pathValue = token.slice("--localstorage-file=".length);
        if (!pathValue) return token;
        if (!/[\s"]/g.test(pathValue)) return token;
        const escaped = pathValue.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        return `--localstorage-file="${escaped}"`;
      }
      return quoteNodeOptionToken(token);
    })
    .join(" ");
};
