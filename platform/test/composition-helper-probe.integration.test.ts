import { expect, it } from 'vitest';
import { awaitHelperWaitingForPartner } from './composition-helper-probe.ts';

const WCHAN = ['exec', 'h', 'cat', '/proc/1/wchan'];

/** Stub probe that replays scripted inspect/exec outcomes and records the call order. */
function scriptedProbe(
  inspects: (() => Promise<Record<string, unknown>>)[],
  execs: (() => Promise<string>)[],
) {
  const calls: string[] = [];
  const execArgs: string[][] = [];
  const next = <T>(script: (() => Promise<T>)[], index: number) =>
    (script[Math.min(index, script.length - 1)] as () => Promise<T>)();
  const probe = {
    inspect: (id: string) => {
      calls.push(`inspect:${id}`);
      return next(inspects, calls.filter((call) => call.startsWith('inspect')).length - 1);
    },
    exec: (args: string[]) => {
      calls.push('exec');
      execArgs.push(args);
      return next(execs, execArgs.length - 1);
    },
  };
  return { probe, calls, execArgs };
}

const running = (value: boolean) => () => Promise.resolve({ State: { Running: value } });
const wchan = (value: string) => () => Promise.resolve(value);

it('rejects with the first failed exec instead of retrying it', async () => {
  const { probe, execArgs } = scriptedProbe(
    [running(true)],
    [
      () => Promise.reject(new Error('docker exec h cat /proc/1/wchan failed (1)')),
      wchan('wait_for_partner\n'),
    ],
  );

  await expect(awaitHelperWaitingForPartner(probe, 'h', 500, 10)).rejects.toThrow('failed (1)');
  expect(execArgs).toEqual([WCHAN]);
});

it('execs only after Running and re-observes wchan between successful execs', async () => {
  const { probe, calls, execArgs } = scriptedProbe(
    [running(false), running(false), running(true)],
    [wchan('do_wait\n'), wchan('wait_for_partner\n')],
  );

  await awaitHelperWaitingForPartner(probe, 'h', 500, 10);
  expect(calls.slice(0, 4)).toEqual(['inspect:h', 'inspect:h', 'inspect:h', 'exec']);
  expect(execArgs).toEqual([WCHAN, WCHAN]);
});

it('fails at the deadline without exec while the helper never runs', async () => {
  const { probe, execArgs } = scriptedProbe([running(false)], [wchan('wait_for_partner\n')]);

  await expect(awaitHelperWaitingForPartner(probe, 'h', 120, 10)).rejects.toThrow(
    'Composition helper did not reach wait_for_partner',
  );
  expect(execArgs).toEqual([]);
});

it('propagates an inspect failure immediately without exec', async () => {
  const failure = new Error('No such container');
  const { probe, calls } = scriptedProbe(
    [() => Promise.reject(failure)],
    [wchan('wait_for_partner\n')],
  );

  await expect(awaitHelperWaitingForPartner(probe, 'h', 500, 10)).rejects.toBe(failure);
  expect(calls).toEqual(['inspect:h']);
});
