export const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export { registerSystemNotifications } from "./commands/systemNotifications";
