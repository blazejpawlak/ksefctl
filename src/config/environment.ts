export type EnvironmentName = "prod" | "test";

export const resolveBaseUrl = (environment: EnvironmentName): string => {
  switch (environment) {
    case "prod":
      return "https://api.ksef.mf.gov.pl/v2";
    case "test":
    default:
      return "https://api-test.ksef.mf.gov.pl/v2";
  }
};
