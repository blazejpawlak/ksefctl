export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const sleepWithCountdown = async (
  durationMs: number,
  intervalSeconds: number,
  onTick?: (remainingMs: number) => void,
): Promise<void> => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const intervalMs = Math.max(1000, intervalSeconds * 1000);
  let remaining = durationMs;
  while (remaining > 0) {
    const step = Math.min(intervalMs, remaining);
    await sleep(step);
    remaining -= step;
    if (remaining > 0) {
      onTick?.(remaining);
    }
  }
};
