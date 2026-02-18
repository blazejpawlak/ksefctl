import cliSpinners from "cli-spinners";
import ora, { type Ora } from "ora";

type ProgressRenderer = {
  update: (message: string) => void;
  done: () => void;
};

type ProgressRendererOptions = {
  stream?: NodeJS.WriteStream;
  spinnerIntervalMs?: number;
};

export const createProgressRenderer = (
  options?: ProgressRendererOptions,
): ProgressRenderer => {
  const stream = options?.stream ?? process.stderr;
  const isTty = stream.isTTY;
  let spinner: Ora | null = null;
  let lastMessage = "";

  const resolveSpinner = () => {
    if (spinner) return spinner;
    const baseSpinner = cliSpinners.dots;
    const spinnerConfig = options?.spinnerIntervalMs
      ? { frames: baseSpinner.frames, interval: options.spinnerIntervalMs }
      : baseSpinner;
    spinner = ora({
      text: lastMessage,
      spinner: spinnerConfig,
      stream,
      isEnabled: isTty,
      discardStdin: false,
    });
    return spinner;
  };

  const update = (message: string) => {
    if (!isTty) {
      stream.write(`${message}\n`);
      return;
    }
    lastMessage = message;
    const activeSpinner = resolveSpinner();
    activeSpinner.text = message;
    if (!activeSpinner.isSpinning) {
      activeSpinner.start();
    } else {
      activeSpinner.render();
    }
  };

  const done = () => {
    if (!spinner) return;
    if (spinner.isSpinning) {
      spinner.stop();
    }
    spinner.clear();
    spinner = null;
    lastMessage = "";
  };

  return { update, done };
};
