export const KSEFCTL_SERVICE_MODE = "KSEFCTL_SERVICE_MODE";

export const isManagedServiceMode = (): boolean => {
  return process.env[KSEFCTL_SERVICE_MODE] === "1";
};
