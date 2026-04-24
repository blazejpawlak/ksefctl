import { afterEach, describe, expect, it } from "vitest";
import {
  isManagedServiceMode,
  KSEFCTL_SERVICE_MODE,
} from "../../src/cli/serviceMode";

describe("isManagedServiceMode", () => {
  const originalValue = process.env[KSEFCTL_SERVICE_MODE];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[KSEFCTL_SERVICE_MODE];
      return;
    }

    process.env[KSEFCTL_SERVICE_MODE] = originalValue;
  });

  it("returns true when the service mode env var is enabled", () => {
    process.env[KSEFCTL_SERVICE_MODE] = "1";

    expect(isManagedServiceMode()).toBe(true);
  });

  it("returns false when the service mode env var is absent", () => {
    delete process.env[KSEFCTL_SERVICE_MODE];

    expect(isManagedServiceMode()).toBe(false);
  });
});
