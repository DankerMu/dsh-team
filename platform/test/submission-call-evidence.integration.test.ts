import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { runDockerCommand } from '../../scripts/docker-command.mjs';
import {
  readVerificationSubmissionsForCleanup,
  readVerificationWritersBeforeRetirement,
} from '../../scripts/verification-submission-assessment.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import {
  beginVerificationSubmission,
  trackVerificationDockerClient,
} from '../../scripts/verification-submissions.mjs';
import { DockerHttpError, type DockerClient } from '../src/orchestrator/index.ts';
import { awaitedMutation, forwardingJson, trackedFromTimer } from './submission-call-fixture.ts';
import { freshSubmissionAssessment, ordinarySubmission } from './trusted-docker-audit-fixture.ts';

const SELF = 'submission-call-evidence.integration.test.ts';
const FIXTURE = 'submission-call-fixture.ts';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KILL = { transport: 'http', operation: 'POST /containers/{id}/kill', caller: SELF };

/** Restored when the test finishes, so no named helper of this file stays on a later stack. */
async function openJournal(): Promise<{ directory: string; journal: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-call-')));
  const previous = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previous;
    await rm(directory, { recursive: true, force: true });
  });
  initializeVerificationSubmissions(directory);
  process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(directory, SUBMISSION_JOURNAL);
  return { directory, journal: join(directory, SUBMISSION_JOURNAL) };
}

async function withJournal(run: (directory: string, journal: string) => Promise<void> | void) {
  const { directory, journal } = await openJournal();
  await run(directory, journal);
}

function rows(journal: string): Record<string, unknown>[] {
  return readFileSync(journal, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lines(...values: object[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function pair(call?: object, id = randomUUID()): string {
  return lines(
    { version: 1, id, state: 'submitted', ...(call === undefined ? {} : { call }) },
    { version: 1, id, state: 'settled' },
  );
}

function engine(json: DockerClient['json']): DockerClient {
  return {
    json,
    logs: () => {
      throw new Error('Logs are not part of this transport');
    },
  };
}

it('records an unresolved CLI mutation with its closed label and keeps cleanup unconfirmed', async () => {
  await withJournal((directory, journal) => {
    const result = runDockerCommand({ file: 'docker', args: ['rm', '-f', 'x'] }, () => ({
      status: 1,
    }));

    expect(result).toEqual({ status: 1 });
    expect(rows(journal)).toEqual([
      {
        version: 1,
        id: expect.stringMatching(ID) as unknown,
        state: 'submitted',
        call: { transport: 'cli', operation: 'rm', caller: SELF },
      },
    ]);
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
  });
});

it('labels a settled CLI group subcommand without changing settlement', async () => {
  await withJournal((directory, journal) => {
    runDockerCommand({ file: 'docker', args: ['network', 'connect', 'n', 'c'] }, () => ({
      status: 0,
    }));

    const [submitted, settled] = rows(journal);
    expect(submitted).toEqual({
      version: 1,
      id: settled?.id,
      state: 'submitted',
      call: { transport: 'cli', operation: 'network connect', caller: SELF },
    });
    expect(settled).toEqual({ version: 1, id: submitted?.id, state: 'settled' });
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"confirmed"}\n');
  });
});

it('labels a wrapper-only CLI process caller as unknown', async () => {
  await withJournal((directory, journal) => {
    const resources = join(directory, 'resources.jsonl');
    writeFileSync(resources, '', { mode: 0o600 });
    const writer = ordinarySubmission(resources, true);

    expect(writer.status, writer.stderr).toBe(0);
    expect(rows(journal)).toEqual([
      {
        version: 1,
        id: expect.stringMatching(ID) as unknown,
        state: 'submitted',
        call: { transport: 'cli', operation: 'network create', caller: 'unknown' },
      },
    ]);
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
  });
});

it('writes only the validated own label values, not an inherited serialization', async () => {
  await withJournal((_directory, journal) => {
    const forged = { ...KILL, caller: 'forged.test.ts', args: ['dsh-team-secret'] };
    const call = Object.assign(Object.create({ toJSON: () => forged }) as object, {
      ...KILL,
      transport: 'http' as const,
    });

    beginVerificationSubmission(call);
    expect(rows(journal)).toEqual([
      { version: 1, id: expect.stringMatching(ID) as unknown, state: 'submitted', call: KILL },
    ]);
  });
});

it('omits the label from a direct no-argument submission', async () => {
  await withJournal((_directory, journal) => {
    beginVerificationSubmission()();
    const [submitted] = rows(journal);
    expect(submitted).toEqual({
      version: 1,
      id: expect.stringMatching(ID) as unknown,
      state: 'submitted',
    });
  });
});

it('names the awaiting test through an awaited fixture chain, not the construction point', async () => {
  await withJournal(async (directory, journal) => {
    const client = await trackedFromTimer(engine(() => Promise.reject(new DockerHttpError(409))));

    // The test itself awaits the fixture, as an issuing test does; `expect().rejects` would
    // make the assertion library the awaiter instead.
    let failure: unknown;
    try {
      await awaitedMutation(client, '/containers/abc123/kill');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ statusCode: 409 });

    expect(rows(journal)).toEqual([
      { version: 1, id: expect.stringMatching(ID) as unknown, state: 'submitted', call: KILL },
    ]);
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
  });
});

it('names an anonymous awaiting test callback with no named helper of this file between', async () => {
  const { directory, journal } = await openJournal();
  const client = await trackedFromTimer(engine(() => Promise.reject(new DockerHttpError(409))));

  // Vitest's source-map formatter drops V8's `async` frame prefix; observe V8's own format.
  const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  Reflect.deleteProperty(Error, 'prepareStackTrace');
  let failure: unknown;
  try {
    await awaitedMutation(client, '/containers/abc123/kill');
  } catch (error) {
    failure = error;
  } finally {
    if (prepare !== undefined) Object.defineProperty(Error, 'prepareStackTrace', prepare);
  }
  expect(failure).toMatchObject({ statusCode: 409 });

  expect(rows(journal)).toEqual([
    { version: 1, id: expect.stringMatching(ID) as unknown, state: 'submitted', call: KILL },
  ]);
  expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
});

const tracked = (raw: DockerClient) => trackVerificationDockerClient(raw, DockerHttpError);

it.each([
  ['a timer-constructed client', FIXTURE, trackedFromTimer],
  ['a test-constructed client', SELF, tracked],
  // A fixture json wrapper is the only call-time frame; the test file constructed the client.
  [
    'a test-constructed client behind a fixture wrapper',
    SELF,
    (raw: DockerClient) => forwardingJson(tracked(raw)),
  ],
])('falls back to the construction point of %s inside a queue', async (_name, caller, build) => {
  await withJournal(async (_directory, journal) => {
    const dispatched = Promise.withResolvers<undefined>();
    const raw = engine(() => {
      dispatched.resolve(undefined);
      // The transport never answers: the submission stays unresolved by construction.
      return new Promise<never>(() => undefined);
    });
    const client = await build(raw);

    // The event loop applies the bound method directly: no test frame is on its stack.
    setImmediate(Reflect.apply, client.json.bind(client), undefined, [
      'POST',
      '/networks/owned-network/connect',
    ]);
    await dispatched.promise;

    expect(rows(journal)).toEqual([
      {
        version: 1,
        id: expect.stringMatching(ID) as unknown,
        state: 'submitted',
        call: { transport: 'http', operation: 'POST /networks/{id}/connect', caller },
      },
    ]);
  });
});

it('leaves a supplied observer submission unlabelled', async () => {
  const received: unknown[][] = [];
  const client = trackVerificationDockerClient(
    engine(() => Promise.resolve({})),
    DockerHttpError,
    (...args: unknown[]) => {
      received.push(args);
      return () => undefined;
    },
  );

  expect(await client.json('POST', '/containers/abc/kill')).toEqual({});
  expect(received).toEqual([[]]);
});

it.each([
  ['labelled rows', pair({ transport: 'cli', operation: 'rm', caller: SELF })],
  ['an unknown caller', pair({ transport: 'http', operation: 'other', caller: 'unknown' })],
  ['older rows without a label', pair()],
  [
    'a mixed older and labelled journal',
    pair() +
      pair(KILL) +
      pair() +
      pair({ transport: 'cli', operation: 'compose', caller: 'x.mjs' }),
  ],
])('accepts and confirms %s', async (_name, text) => {
  await withJournal((directory, journal) => {
    appendFileSync(journal, text);
    expect(readVerificationSubmissionsForCleanup(directory)).toEqual({
      writers: [],
      browserExec: [],
    });
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"confirmed"}\n');
  });
});

it('assesses a mixed journal with an unresolved older row exactly as before', async () => {
  await withJournal((directory, journal) => {
    const id = randomUUID();
    appendFileSync(journal, pair(KILL) + lines({ version: 1, id, state: 'submitted' }) + pair());
    expect(() => readVerificationSubmissionsForCleanup(directory)).toThrow(
      'Verification submission settlement unconfirmed',
    );
    expect(readVerificationWritersBeforeRetirement(directory, new Set())).toEqual([]);
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
  });
});

it('keeps unchanged browser exec submitted rows valid', async () => {
  await withJournal((directory, journal) => {
    const id = randomUUID();
    appendFileSync(
      journal,
      lines({ version: 1, id, state: 'submitted', browserExec: 'a'.repeat(64) }),
    );
    expect(readVerificationWritersBeforeRetirement(directory, new Set())).toEqual([]);
  });
});

const submitted = (id: string, detail: object) => ({
  version: 1,
  id,
  state: 'submitted',
  ...detail,
});

it.each([
  [
    'a label on settled',
    (id: string) => lines(submitted(id, {}), { version: 1, id, state: 'settled', call: KILL }),
  ],
  [
    'a label on client-closed-unknown',
    (id: string) =>
      lines(submitted(id, { browserExec: 'a'.repeat(64) }), {
        version: 1,
        id,
        state: 'client-closed-unknown',
        client: { exitCode: 1, signal: null, failure: 'exit' },
        call: KILL,
      }),
  ],
  [
    'a label with browser exec',
    (id: string) => lines(submitted(id, { browserExec: 'a'.repeat(64), call: KILL })),
  ],
  ['a null label', (id: string) => lines(submitted(id, { call: null }))],
  [
    'a missing label key',
    (id: string) => lines(submitted(id, { call: { transport: 'cli', operation: 'rm' } })),
  ],
  ['an extra label key', (id: string) => lines(submitted(id, { call: { ...KILL, args: [] } }))],
  [
    'an unknown transport',
    (id: string) => lines(submitted(id, { call: { ...KILL, transport: 'ssh' } })),
  ],
  [
    'an operation outside the whitelist',
    (id: string) =>
      lines(submitted(id, { call: { ...KILL, operation: 'POST /containers/abc/kill' } })),
  ],
  [
    'a CLI operation outside the enum',
    (id: string) =>
      lines(submitted(id, { call: { transport: 'cli', operation: 'rm -f', caller: SELF } })),
  ],
  [
    'a caller path',
    (id: string) => lines(submitted(id, { call: { ...KILL, caller: '/repo/x.test.ts' } })),
  ],
])('rejects %s as malformed evidence', async (_name, text) => {
  await withJournal((directory, journal) => {
    appendFileSync(journal, pair(KILL) + text(randomUUID()));
    expect(() => readVerificationWritersBeforeRetirement(directory, new Set())).toThrow(
      /malformed/i,
    );
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
  });
});

it('parses a labelled journal near the existing 8 MiB bound and rejects one beyond it', async () => {
  await withJournal((directory, journal) => {
    const limit = 8 * 1024 * 1024;
    const call = { transport: 'http', operation: 'POST /networks/{id}/disconnect', caller: SELF };
    const unit = pair(call).length;
    const count = Math.floor(limit / unit);
    const text = Array.from({ length: count }, () => pair(call)).join('');
    expect(text.length).toBeGreaterThan(limit - unit);
    appendFileSync(journal, text);
    expect(readVerificationSubmissionsForCleanup(directory)).toEqual({
      writers: [],
      browserExec: [],
    });

    appendFileSync(journal, pair(call));
    expect(() => readVerificationSubmissionsForCleanup(directory)).toThrow(
      'Verification submission evidence exceeds bound',
    );
  });
});
