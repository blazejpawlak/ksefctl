import type { Command } from "commander";

export const getCommandPath = (command: Command): string => {
  const names: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
};

export const sanitizeForTerminal = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export const printLabelValues = (
  entries: [string, string | number | null][],
): void => {
  for (const [key, value] of entries) {
    console.log(`${key}: ${value ?? "-"}`);
  }
};

export const collectLeafCommands = (command: Command): Command[] => {
  const children = command.commands.filter((child) => child.name() !== "help");
  if (children.length === 0) {
    return [command];
  }
  return children.flatMap((child) => collectLeafCommands(child));
};

export const formatCommandHelp = (command: Command): string => {
  const path = getCommandPath(command);
  if (!path) {
    return "";
  }
  const options = command.options;
  if (options.length === 0) {
    return "";
  }
  const header = `${path} [options]`;
  const lines = [`  ${header}`];
  for (const option of options) {
    const required = option.required ? " (required)" : "";
    const description = option.description ? `  ${option.description}` : "";
    lines.push(`    ${option.flags}${required}${description}`);
  }
  return lines.join("\n");
};
