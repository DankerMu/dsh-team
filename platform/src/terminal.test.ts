import { describe, expect, it } from 'vitest';
import { terminalStreams } from '../test/terminal-fixture.ts';
import { createTerminal, TerminalInputError } from './terminal.ts';

function terminalFixture(responses: readonly string[], wasRaw = false) {
  const streams = terminalStreams(responses, wasRaw);
  const cancellation = new AbortController();
  const session = createTerminal(streams.input, streams.output, cancellation);
  return { ...streams, cancellation, session };
}

describe('hidden administrator terminal input', () => {
  it('preserves Unicode and whitespace while hiding both password entries', async () => {
    const password = ' 空格😀密码 ';
    const fixture = terminalFixture([password, password]);
    try {
      const result = await fixture.session.readPassword(false);

      expect(result).toBe(password);
      expect(fixture.written()).not.toContain(password);
    } finally {
      fixture.session.close();
      fixture.input.destroy();
      fixture.output.destroy();
    }
  });

  it('does not lose matching confirmation when both password lines arrive in one chunk', async () => {
    const password = ' pasted 😀 password ';
    const fixture = terminalFixture([]);
    fixture.output.on('data', (chunk: Buffer) => {
      if (chunk.toString() === 'Password: ') {
        fixture.input.write(`${password}\r${password}\r`);
      }
    });
    try {
      const result = await fixture.session.readPassword(false);

      expect(result).toBe(password);
      expect(fixture.written()).not.toContain(password);
    } finally {
      fixture.session.close();
      fixture.input.destroy();
      fixture.output.destroy();
    }
  });

  it('cancels excess pasted lines instead of silently losing input or retaining password history', async () => {
    const fixture = terminalFixture([]);
    fixture.output.on('data', (chunk: Buffer) => {
      if (chunk.toString() === 'Password: ') {
        fixture.input.write('first secret\rsecond secret\rthird secret\r');
      }
    });
    try {
      await expect(fixture.session.readPassword(false)).rejects.toThrow();

      expect(fixture.cancellation.signal.aborted).toBe(true);
      expect(fixture.written()).not.toContain('secret');
    } finally {
      fixture.session.close();
      fixture.input.destroy();
      fixture.output.destroy();
    }
  });

  it.each(['', 'n', 'N'])(
    'defaults an existing account to no password reset for answer %j',
    async (answer) => {
      const fixture = terminalFixture([answer]);
      try {
        const result = await fixture.session.readPassword(true);

        expect(result).toBeNull();
        expect(fixture.written()).not.toMatch(/confirm password/i);
      } finally {
        fixture.session.close();
        fixture.input.destroy();
        fixture.output.destroy();
      }
    },
  );

  it('asks for matching hidden passwords after an explicit reset choice', async () => {
    const fixture = terminalFixture(['YES', 'replacement password', 'replacement password']);
    try {
      const result = await fixture.session.readPassword(true);

      expect(result).toBe('replacement password');
      expect(fixture.written()).not.toContain('replacement password');
    } finally {
      fixture.session.close();
      fixture.input.destroy();
      fixture.output.destroy();
    }
  });

  it('rejects a mismatched confirmation without disclosing either password', async () => {
    const fixture = terminalFixture(['first secret', 'second secret']);
    try {
      await expect(fixture.session.readPassword(false)).rejects.toBeInstanceOf(TerminalInputError);

      expect(fixture.written()).not.toContain('first secret');
      expect(fixture.written()).not.toContain('second secret');
    } finally {
      fixture.session.close();
      fixture.input.destroy();
      fixture.output.destroy();
    }
  });

  it.each(['Ctrl-C', 'EOF', 'abort', 'input error', 'output error'])(
    'cancels pending input on %s and restores terminal state',
    async (reason) => {
      const fixture = terminalFixture([]);
      const pending = fixture.session.readPassword(false);
      const rejected = expect(pending).rejects.toThrow('Administrator operation cancelled');
      try {
        expect(fixture.input.isRaw).toBe(true);
        if (reason === 'Ctrl-C') {
          fixture.input.write('\x03');
        } else if (reason === 'EOF') {
          fixture.input.write('\x04');
        } else if (reason === 'abort') {
          fixture.cancellation.abort();
        } else if (reason === 'input error') {
          fixture.input.emit('error', new Error('secret input error'));
        } else {
          fixture.output.emit('error', new Error('secret output error'));
        }
        await rejected;
        fixture.session.close();

        expect(fixture.cancellation.signal.aborted).toBe(true);
        expect(fixture.input.isRaw).toBe(false);
        expect(fixture.input.isPaused()).toBe(true);
        expect(fixture.input.listenerCount('error')).toBe(0);
        expect(fixture.input.listenerCount('keypress')).toBe(0);
        expect(fixture.output.listenerCount('error')).toBe(0);
        expect(fixture.written()).not.toContain('secret');
      } finally {
        fixture.session.close();
        fixture.input.destroy();
        fixture.output.destroy();
        await Promise.allSettled([pending, rejected]);
      }
    },
  );

  it.each([false, true])(
    'restores the original raw mode %s and allows repeated cleanup',
    async (wasRaw) => {
      const fixture = terminalFixture(['matching password', 'matching password'], wasRaw);
      try {
        await fixture.session.readPassword(false);
        fixture.session.close();
        fixture.session.close();

        expect(fixture.input.isRaw).toBe(wasRaw);
        expect(fixture.input.isPaused()).toBe(true);
        expect(fixture.input.listenerCount('keypress')).toBe(0);
        expect(fixture.input.listenerCount('error')).toBe(0);
      } finally {
        fixture.input.destroy();
        fixture.output.destroy();
      }
    },
  );

  it('restores terminal state and owned listeners if readline setup throws', () => {
    const streams = terminalStreams([]);
    const cancellation = new AbortController();
    const events = ['data', 'end', 'keypress', 'newListener', 'error'] as const;
    const listeners = events.map((event) => streams.input.rawListeners(event));
    streams.input.setRawMode = (mode: boolean) => {
      streams.input.isRaw = mode;
      if (mode) {
        throw new Error('terminal setup failure sentinel');
      }
      return streams.input;
    };
    try {
      expect(() => createTerminal(streams.input, streams.output, cancellation)).toThrow(
        'terminal setup failure sentinel',
      );

      expect(streams.input.isRaw).toBe(false);
      expect(streams.input.isPaused()).toBe(true);
      expect(events.map((event) => streams.input.rawListeners(event))).toEqual(listeners);
    } finally {
      streams.input.destroy();
      streams.output.destroy();
    }
  });
});
