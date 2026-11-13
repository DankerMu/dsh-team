import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { createDockerCommands } from './docker-command.ts';
import type { DockerCommand, DockerCommandResult, DockerCommands } from './docker-command.ts';
import { runOneShot, runOneShotAsync } from './one-shot-container.ts';

const ARGS = ['--name', 'probe', '--network', 'none', 'img', 'id'];
const LOGS = { status: 0, stdout: 'container out\n', stderr: 'container err\n' };
const ok = (stdout: string): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
const failed: DockerCommandResult = { status: 1, stdout: 'cli out', stderr: 'cli err' };
// The shape `createDockerCommands` settles a timed-out child with.
const error = Object.assign(new Error('Docker process failed: ETIMEDOUT'), { code: 'ETIMEDOUT' });
const timedOut: DockerCommandResult = { status: null, stdout: '', stderr: '', error };
const REMOVAL = new Error('One-shot container removal failed (status 1, signal null)');
const ALL = 'create start wait logs rm';

/** A Docker CLI stand-in answering per verb; an Error reply is thrown, not returned. */
function standIn(replies: Record<string, DockerCommandResult | Error> = {}) {
  const calls: [string[], number][] = [];
  const all = {
    create: ok('id\n'),
    start: ok(''),
    wait: ok('0\n'),
    logs: LOGS,
    rm: ok(''),
    ...replies,
  };
  const command: DockerCommand = (args, timeout) => {
    calls.push([[...args], timeout]);
    // A verb the table lacks answers undefined and fails the case.
    const reply = all[args[0] as keyof typeof all];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const commandAsync = (args: readonly string[], timeout: number) =>
    Promise.resolve().then(() => command(args, timeout));
  const verbs = () => calls.map(([args]) => args[0]).join(' ');
  return { calls, command, commands: { command, commandAsync }, verbs };
}

type Run = (commands: DockerCommands, args?: string[]) => Promise<DockerCommandResult>;
const sync: Run = (c, args = ARGS) =>
  Promise.resolve().then(() => runOneShot(c.command, args, 90_000));
const async: Run = (c, args = ARGS) => runOneShotAsync(c.commandAsync, args, 90_000);
// The pre-change foreground run, through the same mode's raw command.
const syncRun: Run = (c) => Promise.resolve().then(() => c.command(['run', ...ARGS], 90_000));
const asyncRun: Run = (c) => c.commandAsync(['run', ...ARGS], 90_000);

describe.each([
  ['sync', sync, syncRun],
  ['async', async, asyncRun],
])('%s one-shot container', (_, oneShot, foreground) => {
  it('creates, starts, boundedly waits, reads logs and removes the container before returning', async () => {
    const { calls, commands } = standIn();

    const result = await oneShot(commands);

    expect(result).toEqual(LOGS);
    expect(calls).toEqual([
      [['create', ...ARGS], 30_000],
      [['start', 'probe'], 30_000],
      [['wait', 'probe'], 90_000],
      [['logs', 'probe'], 30_000],
      [['rm', '--force', 'probe'], 30_000],
    ]);
  });

  it.each([
    ['the exit status wait printed', { wait: ok('3\n') }, { ...LOGS, status: 3 }, ALL],
    ['a failed create without removal', { create: failed }, failed, 'create'],
    ['a failed start', { start: failed }, failed, 'create start rm'],
    ['a timed-out wait', { wait: timedOut }, timedOut, 'create start wait rm'],
    ['failed logs', { logs: failed }, failed, ALL],
    [
      'no status for a non-decimal wait',
      { wait: ok('exited\n') },
      { ...LOGS, status: null, error: new Error('One-shot container wait printed no exit status') },
      ALL,
    ],
  ])('returns %s without throwing', async (_, replies, expected, verbs) => {
    const stand = standIn(replies);

    const result = await oneShot(stand.commands);

    expect(result).toEqual(expected);
    expect(stand.verbs()).toBe(verbs);
  });

  it.each([
    [
      'arguments without --name, before any call',
      {},
      ['--network', 'none', 'img'],
      new Error('One-shot container arguments need --name'),
      '',
    ],
    ['a removal failure without the container logs', { rm: failed }, ARGS, REMOVAL, ALL],
    [
      'a thrown step aggregated with the failed removal',
      { start: new Error('broke'), rm: failed },
      ARGS,
      new AggregateError([new Error('broke'), REMOVAL], `Error: broke; rm: ${String(REMOVAL)}`),
      'create start rm',
    ],
  ])('throws %s', async (_, replies, args, expected, verbs) => {
    const stand = standIn(replies);

    const result = oneShot(stand.commands, args);

    await expect(result).rejects.toStrictEqual(expected);
    expect(stand.verbs()).toBe(verbs);
  });

  it.each([
    [
      'settles every submission of a container that exits nonzero',
      oneShot,
      Array(3).fill(['submitted', 'settled']).flat(),
    ],
    ['leaves a foreground run of the same container unsettled', foreground, ['submitted']],
  ])('%s through the real bookkeeping', async (_, run, states) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-one-shot-')));
    const previous = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    onTestFinished(async () => {
      if (previous === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previous;
      await rm(directory, { recursive: true, force: true });
    });
    initializeVerificationSubmissions(directory);
    process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(directory, SUBMISSION_JOURNAL);
    const { command } = standIn({ wait: ok('3\n'), run: { ...LOGS, status: 3 } });

    const result = await run(createDockerCommands('unused', 'unused', true, command));

    expect(result.status).toBe(3);
    const journal = readFileSync(join(directory, SUBMISSION_JOURNAL), 'utf8').split('\n');
    // Journal rows are the storage module's own JSON objects, each with a state.
    expect(
      journal.filter(Boolean).map((row) => (JSON.parse(row) as { state: string }).state),
    ).toEqual(states);
    if (states.length === 1)
      expect(() => requireVerificationSubmissionsSettled(directory)).toThrow();
    else expect(() => requireVerificationSubmissionsSettled(directory)).not.toThrow();
  });
});
