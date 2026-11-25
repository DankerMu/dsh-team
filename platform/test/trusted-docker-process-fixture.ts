import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPresent } from './case-budget-fixture.ts';
import type { CaseBudget } from './case-budget-fixture.ts';
import { groupIsAbsent } from '../../scripts/trusted-docker-record.mjs';

const birthModule = new URL('../../scripts/probe-browser-native.mjs', import.meta.url).href;

const errorCode = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined;

export function fixtureProcessCustody(
  environment: NodeJS.ProcessEnv,
  directory: string,
  budget: CaseBudget,
) {
  const closures = new Map<number, { closed: boolean }>();
  const observeProcess = (pid: number): string | null => {
    const source = `import {liveProcessBirth} from ${JSON.stringify(birthModule)};process.stdout.write(JSON.stringify(await liveProcessBirth(Number(process.argv[1]))));`;
    const args = ['--input-type=module', '-e', source, String(pid)];
    const result = budget.run('process observation', process.execPath, args, {
      env: { ...environment, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65_536,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Fixture process observation unavailable: pid=${String(pid)} present=${String(ownerPresent(pid))}`,
      );
    const value: unknown = JSON.parse(result.stdout);
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid fixture process observation');
    return value;
  };
  const identityLive = (identity: Readonly<Record<string, unknown>>) => {
    const pid = identity.pid;
    if (typeof pid !== 'number' || typeof identity.birth !== 'string')
      throw new Error('Invalid owned fixture identity');
    const current = observeProcess(pid);
    if (current !== null && current !== identity.birth)
      throw new Error('Fixture identity changed; retaining authority');
    return current !== null;
  };
  const settle = async (
    identity: Record<string, unknown>,
    group: boolean,
    signal: NodeJS.Signals = 'SIGKILL',
  ) => {
    const live = () => identityLive(identity);
    const pid = Number(identity.pid);
    const phase = 'Owned custody fixture process did not retire';
    // `denied` is the last group EPERM, seeded by the group kill: the stalled error's cause.
    const waitForAbsence = async (denied?: unknown) => {
      const since = Date.now();
      const until = since + budget.limit('process retirement', 5000);
      for (;;) {
        // A synchronous observer can see Darwin ESRCH while this parent's child is still
        // unreaped. Its group, unreaped orphan zombies, answers EPERM until it is reaped: that
        // is still retiring and observed again; a probe without EPERM drops the last one.
        if (!live() && closures.get(pid)?.closed !== false)
          try {
            if (!group || groupIsAbsent(pid)) return;
            denied = undefined;
          } catch (error) {
            if (errorCode(error) !== 'EPERM') throw error;
            denied = error;
          }
        if (Date.now() >= until) throw budget.stalled(phase, since, pid, group, denied);
        await delay(20);
      }
    };
    if (!live()) return waitForAbsence();
    if (group) {
      const observed = budget.run('process group', '/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65_536,
      });
      if (!live()) return waitForAbsence();
      if (observed.status !== 0 || observed.stdout.trim() !== String(pid))
        throw new Error('Owned fixture process group identity changed');
    }
    try {
      process.kill(group ? -pid : pid, signal);
    } catch (error) {
      // A retiring zombie group answers EPERM too; a single process still tolerates only ESRCH.
      if (group && errorCode(error) === 'EPERM') return waitForAbsence(error);
      if (errorCode(error) !== 'ESRCH') throw error;
    }
    await waitForAbsence();
  };
  const groups: Record<string, unknown>[] = [];
  const track = async (child: ChildProcess) => {
    const closure = { closed: false };
    child.once('close', () => {
      closure.closed = true;
    });
    await once(child, 'spawn');
    try {
      if (child.pid === undefined) throw new Error('Missing owned fixture process');
      closures.set(child.pid, closure);
      const birth = observeProcess(child.pid);
      if (birth === null) throw new Error('Owned fixture process exited before registration');
      const identity = Object.freeze({ pid: child.pid, birth });
      groups.push(identity);
      writeFileSync(join(directory, 'fixture-processes.json'), JSON.stringify(groups), {
        mode: 0o600,
      });
      return identity;
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      throw error;
    }
  };
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const identity of groups) {
      try {
        await settle(identity, true);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Owned fixture observers did not retire');
  };
  return { observeProcess, identityLive, settle, track, cleanup };
}
