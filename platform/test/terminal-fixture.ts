import { PassThrough } from 'node:stream';

class TerminalStream extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

/** Drives supported readline input only after an actual prompt is written. */
export function terminalStreams(responses: readonly string[], wasRaw = false) {
  const input = new TerminalStream();
  input.isRaw = wasRaw;
  input.pause();
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const pending = [...responses];
  let written = '';
  output.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    written += text;
    if (text.endsWith(': ')) {
      const response = pending.shift();
      if (response !== undefined) {
        input.write(`${response}\r`);
      }
    }
  });
  return { input, output, written: () => written };
}
