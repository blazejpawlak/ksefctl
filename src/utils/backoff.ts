export type BackoffOptions = {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
};

export const calculateBackoff = ({
  attempt,
  baseDelayMs,
  maxDelayMs,
  jitter,
}: BackoffOptions): number => {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(attempt - 1, 0));
  const rand = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.floor(exp * rand));
};
