import path from "node:path";

type ResolveServiceLogPathsOptions = {
  appName: string;
  storageRoot: string;
  lifecycleLogPath: string;
  error?: boolean;
};

export const resolveServiceLogPaths = (
  options: ResolveServiceLogPathsOptions,
): string[] => {
  const errorLogPath = path.join(
    options.storageRoot,
    "logs",
    `${options.appName}.err.log`,
  );

  if (options.error) {
    return [errorLogPath];
  }

  return [options.lifecycleLogPath];
};
