import readline from "node:readline";
import { Writable } from "node:stream";

class MuteStream extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

export const promptText = async (question: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(question, (value) => resolve(value)),
  );
  rl.close();
  return answer.trim();
};

export const promptHidden = async (question: string): Promise<string> => {
  const mute = new MuteStream();
  process.stdout.write(question);
  const rl = readline.createInterface({
    input: process.stdin,
    output: mute,
    terminal: true,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question("", (value) => resolve(value)),
  );
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
};
