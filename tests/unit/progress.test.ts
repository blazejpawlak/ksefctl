import cliSpinners from "cli-spinners";
import ora from "ora";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgressRenderer } from "../../src/cli/progress";

type SpinnerStub = {
  text: string;
  isSpinning: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

type WritableStub = {
  isTTY?: boolean;
  writes: string[];
  write: (chunk: string) => boolean;
};

let spinner: SpinnerStub;

vi.mock("ora", () => ({
  __esModule: true,
  default: vi.fn(() => spinner),
}));

const createStream = (isTTY: boolean): WritableStub => {
  const stream: WritableStub = {
    isTTY,
    writes: [],
    write: (chunk: string) => {
      stream.writes.push(chunk);
      return true;
    },
  };
  return stream;
};

beforeEach(() => {
  spinner = {
    text: "",
    isSpinning: false,
    start: vi.fn(() => {
      spinner.isSpinning = true;
      return spinner;
    }),
    stop: vi.fn(() => {
      spinner.isSpinning = false;
      return spinner;
    }),
    render: vi.fn(() => spinner),
    clear: vi.fn(() => spinner),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("progress renderer", () => {
  it("writes plain lines when output is not a TTY", () => {
    const stream = createStream(false);
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
    });

    renderer.update("Progress: syncing");
    renderer.done();

    expect(stream.writes).toEqual(["Progress: syncing\n"]);
    expect(ora).not.toHaveBeenCalled();
  });

  it("starts and updates ora spinner for TTY", () => {
    const stream = createStream(true);
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
    });

    renderer.update("first");
    renderer.update("second");

    expect(ora).toHaveBeenCalledTimes(1);
    expect(ora).toHaveBeenCalledWith(
      expect.objectContaining({
        spinner: cliSpinners.dots8Bit,
        stream: stream as unknown as NodeJS.WriteStream,
        isEnabled: true,
      }),
    );
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spinner.render).toHaveBeenCalledTimes(1);
    expect(spinner.text).toBe("second");
  });

  it("uses configured spinner interval when provided", () => {
    const stream = createStream(true);
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
      spinnerIntervalMs: 42,
    });

    renderer.update("first");

    expect(ora).toHaveBeenCalledWith(
      expect.objectContaining({
        spinner: expect.objectContaining({
          frames: cliSpinners.dots8Bit.frames,
          interval: 42,
        }),
      }),
    );
  });

  it("stops and clears spinner on done", () => {
    const stream = createStream(true);
    const renderer = createProgressRenderer({
      stream: stream as unknown as NodeJS.WriteStream,
    });

    renderer.update("first");
    renderer.done();

    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.clear).toHaveBeenCalledTimes(1);
  });
});
