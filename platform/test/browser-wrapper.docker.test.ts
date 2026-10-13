import { expect, it } from 'vitest';
import { interruptWrapper } from './browser-wrapper-docker-fixture.ts';

interface SignalCase {
  readonly signal: 'SIGTERM' | 'SIGINT';
  readonly expected: number;
}
const signals: SignalCase[] = [
  { signal: 'SIGTERM', expected: 143 },
  { signal: 'SIGINT', expected: 130 },
];

it.each(signals)(
  'does not launch verification after $signal during runtime receipt publication',
  async ({ signal, expected }) => {
    const outcome = await interruptWrapper({
      boundary: 'publication',
      mode: signal === 'SIGTERM' ? 'docker' : 'first-run',
      signal,
    });

    // These are independent daemon/filesystem observations taken before fallback fixture cleanup.
    expect(outcome.inventory).toEqual({ containers: [], networks: [], images: [], sockets: [] });
    expect({
      code: outcome.code,
      signal: outcome.signal,
      started: outcome.childStarted,
      published: outcome.publicationObserved,
    }).toEqual({
      code: expected,
      signal: null,
      started: false,
      published: true,
    });
  },
);

it.each(signals)(
  'keeps $signal status when the already-started real verification child exits zero',
  async ({ signal, expected }) => {
    const outcome = await interruptWrapper({
      boundary: 'running-child',
      mode: signal === 'SIGTERM' ? 'first-run' : 'dsh-api',
      signal,
    });

    expect(outcome.inventory).toEqual({ containers: [], networks: [], images: [], sockets: [] });
    expect(outcome.childStarted).toBe(true);
    expect(outcome.childSignal).toBe(signal);
    expect(outcome.childExitCode).toBe(0);
    expect(outcome.publicationObserved).toBe(true);
    expect({ code: outcome.code, signal: outcome.signal }).toEqual({
      code: expected,
      signal: null,
    });
  },
);

it.each(signals)(
  'keeps $signal status for an already-started help child that exits zero',
  async ({ signal, expected }) => {
    const outcome = await interruptWrapper({
      boundary: 'help-child',
      mode: signal === 'SIGTERM' ? 'docker' : 'dsh-api',
      signal,
    });

    expect(outcome.inventory).toEqual({ containers: [], networks: [], images: [], sockets: [] });
    expect(outcome.publicationObserved).toBe(false);
    expect(outcome.childStarted).toBe(true);
    expect(outcome.childSignal).toBe(signal);
    expect(outcome.childExitCode).toBe(0);
    expect({ code: outcome.code, signal: outcome.signal }).toEqual({
      code: expected,
      signal: null,
    });
  },
);
