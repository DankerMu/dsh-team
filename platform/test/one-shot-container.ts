import type { AsyncDockerCommand, DockerCommand, DockerCommandResult } from './docker-command.ts';

type Call = readonly [args: readonly string[], timeout: number];
type Flow = Generator<Call, DockerCommandResult, DockerCommandResult>;

const failed = (result: DockerCommandResult) => result.status !== 0 || result.error !== undefined;

/** The first failed step as is, else the logs with the exit status `wait` printed. */
function* settle(name: string, timeoutMs: number): Flow {
  const start = yield [['start', name], 30_000];
  if (failed(start)) return start;
  const wait = yield [['wait', name], timeoutMs];
  if (failed(wait)) return wait;
  const logs = yield [['logs', name], 30_000];
  if (failed(logs)) return logs;
  const exit = wait.stdout.replace(/\r?\n$/, '');
  if (/^\d+$/.test(exit)) return { ...logs, status: Number(exit) };
  const error = new Error('One-shot container wait printed no exit status');
  return { ...logs, status: null, error };
}

/**
 * `create <args>`, start, bounded wait and logs, then `rm --force` before returning. Not a
 * foreground `run`: its CLI exit mirrors the container's, leaving a nonzero run unsettled.
 */
function* oneShot(args: readonly string[], timeoutMs: number): Flow {
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
  if (name === undefined) throw new Error('One-shot container arguments need --name');
  const create = yield [['create', ...args], 30_000];
  if (failed(create)) return create;
  let outcome: { result: DockerCommandResult } | { error: unknown };
  try {
    outcome = { result: yield* settle(name, timeoutMs) };
  } catch (error) {
    outcome = { error };
  }
  const removal = yield [['rm', '--force', name], 30_000];
  if (failed(removal)) {
    const status = `status ${String(removal.status)}, signal ${removal.signal ?? 'null'}`;
    const error = new Error(`One-shot container removal failed (${status})`);
    if (!('error' in outcome)) throw error;
    const message = `${String(outcome.error)}; rm: ${String(error)}`;
    throw new AggregateError([outcome.error, error], message);
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

export function runOneShot(command: DockerCommand, args: readonly string[], timeoutMs: number) {
  const flow = oneShot(args, timeoutMs);
  for (let step = flow.next(); ;) {
    if (step.done) return step.value;
    let result: DockerCommandResult;
    try {
      result = command(...step.value);
    } catch (error) {
      step = flow.throw(error);
      continue;
    }
    step = flow.next(result);
  }
}

export async function runOneShotAsync(
  command: AsyncDockerCommand,
  args: readonly string[],
  timeoutMs: number,
) {
  const flow = oneShot(args, timeoutMs);
  for (let step = flow.next(); ;) {
    if (step.done) return step.value;
    const call = step.value;
    // A synchronous throw is fed back like a rejection, so removal still runs.
    const settled = Promise.resolve().then(() => command(...call));
    step = await settled.then(
      (result) => flow.next(result),
      (e: unknown) => flow.throw(e),
    );
  }
}
