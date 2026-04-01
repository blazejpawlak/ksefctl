import { describe, expect, it } from "vitest";
import { formatCliError } from "../../src/cli";

describe("cli error formatting", () => {
  it("sanitizes terminal-facing CLI errors", () => {
    expect(
      formatCliError(
        new Error(
          "HTTP 500 GET /invoices/exports: token=secret request failed (requestId=req-1)",
        ),
      ),
    ).toBe("HTTP 500 GET /invoices/exports (requestId=req-1)");
  });

  it("removes terminal control characters from CLI errors", () => {
    expect(formatCliError(new Error("bad\u0000value\nnext line"))).toBe(
      "badvaluenext line",
    );
  });
});
