import { describe, expect, it } from "vitest";
import { createProgressRenderer } from "../../src/cli/progress.js";

// Drives the progress renderer against the real `ora` and `cli-spinners`
// packages (no module mocks), so upgrades of either are exercised end to end.

// Matches CSI escape sequences (cursor movement, line clearing, cursor
// show/hide, synchronized output) emitted by a spinner.
const ESCAPE_SEQUENCE = /\u001b\[/;

type FakeStream = {
  isTTY: boolean;
  columns: number;
  rows: number;
  writes: string[];
  write: (chunk: string | Uint8Array) => boolean;
  cursorTo: () => boolean;
  moveCursor: () => boolean;
  clearLine: () => boolean;
  once: () => FakeStream;
  removeListener: () => FakeStream;
};

const createStream = (isTTY: boolean): FakeStream => {
  const stream: FakeStream = {
    isTTY,
    columns: 80,
    rows: 24,
    writes: [],
    write: (chunk) => {
      stream.writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    },
    cursorTo: () => stream.write("\u001b[G"),
    moveCursor: () => stream.write("\u001b[1A"),
    clearLine: () => stream.write("\u001b[2K"),
    once: () => stream,
    removeListener: () => stream,
  };
  return stream;
};

describe("progress renderer with real ora", () => {
  it("writes only plain lines without escape codes when not a TTY", () => {
    const stream = createStream(false);
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
    });

    renderer.update("Progress: syncing");
    renderer.update("Progress: retry in 5s");
    renderer.done();

    expect(stream.writes).toEqual([
      "Progress: syncing\n",
      "Progress: retry in 5s\n",
    ]);
    expect(stream.writes.join("")).not.toMatch(ESCAPE_SEQUENCE);
  });

  it("renders the dots spinner on a TTY and restores stdio on done", () => {
    const stream = createStream(true);
    const stdoutWrite: unknown = Reflect.get(process.stdout, "write");
    const stderrWrite: unknown = Reflect.get(process.stderr, "write");
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
    });

    renderer.update("first");
    renderer.update("second");
    const output = stream.writes.join("");
    renderer.done();

    expect(output).toContain("⠋");
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(Reflect.get(process.stdout, "write")).toBe(stdoutWrite);
    expect(Reflect.get(process.stderr, "write")).toBe(stderrWrite);
  });
});
