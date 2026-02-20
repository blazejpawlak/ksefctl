import { describe, expect, it } from "vitest";
import {
  buildNodeOptionsWithLocalstorage,
  sanitizeNodeOptions,
} from "../../src/utils/nodeOptions";

describe("node options", () => {
  it("allowlists only localstorage option", () => {
    const tokens = sanitizeNodeOptions(
      "--max-old-space-size=4096 --localstorage-file=/tmp/store.json",
    );

    expect(tokens).toEqual(["--localstorage-file=/tmp/store.json"]);
  });

  it("builds localstorage option when missing", () => {
    const value = buildNodeOptionsWithLocalstorage(
      "--max-old-space-size=4096",
      "/tmp/localstorage.json",
    );

    expect(value).toBe("--localstorage-file=/tmp/localstorage.json");
  });

  it("preserves quoted localstorage path with spaces", () => {
    const value = buildNodeOptionsWithLocalstorage(
      "--localstorage-file=\"/tmp/my dir/store.json\"",
      "/tmp/localstorage.json",
    );

    expect(value).toBe("--localstorage-file=\"/tmp/my dir/store.json\"");
  });

  it("drops empty localstorage flags", () => {
    const tokens = sanitizeNodeOptions(
      "--localstorage-file= --localstorage-file",
    );

    expect(tokens).toEqual([]);
  });

  it("ignores localstorage when followed by another flag", () => {
    const tokens = sanitizeNodeOptions("--localstorage-file --trace-warnings");

    expect(tokens).toEqual([]);
  });

  it("keeps only valid localstorage among multiple options", () => {
    const tokens = sanitizeNodeOptions(
      "--localstorage-file=/tmp/a.json --localstorage-file --localstorage-file=/tmp/b.json",
    );

    expect(tokens).toEqual([
      "--localstorage-file=/tmp/a.json",
      "--localstorage-file=/tmp/b.json",
    ]);
  });

  it("builds localstorage option when value is whitespace", () => {
    const value = buildNodeOptionsWithLocalstorage("   ", "/tmp/ls.json");

    expect(value).toBe("--localstorage-file=/tmp/ls.json");
  });
});
