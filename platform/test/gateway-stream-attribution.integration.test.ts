import { existsSync, unlinkSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { runLargeTransfer } from './gateway-stream-fixture.ts';
import type { FailureReport } from './gateway-stream-trace.ts';

const PREFIX = 'Gateway stream failure ';
const STREAM_BYTES = 209_715_200;
// Every key the attribution may carry: counters, lifecycle facts and Node error code/name only.
const REPORT_KEYS = new Set([
  ...['phase', 'firstClose', 'traces', 'upload', 'download', 'client', 'upstream', 'child'],
  ...['written', 'read', 'status', 'received', 'sent', 'exitCode', 'signal', 'escalated'],
  ...['events', 'seq', 'end', 'stream', 'kind', 'ms', 'code', 'name'],
]);

interface Probe {
  phases: string[];
  children: ChildProcess[];
  directory?: string;
  port?: number;
}
function observer(probe: Probe, act?: (phase: string, file: string, probe: Probe) => void) {
  return (event: {
    phase: string;
    directory: string;
    file: string;
    child?: ChildProcess;
    port?: number;
  }) => {
    probe.phases.push(event.phase);
    probe.directory = event.directory;
    if (event.port !== undefined) probe.port = event.port;
    if (event.phase === 'child' && event.child !== undefined) probe.children.push(event.child);
    act?.(event.phase, event.file, probe);
  };
}
function keys(value: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, found);
  else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keys(item, found);
    }
  else if (typeof value === 'string') expect(value).toMatch(/^[\w:-]+$/);
  return found;
}
async function attributed(run: Promise<unknown>, probe: Probe) {
  const error = await run.then(
    () => new Error('Expected the large transfer to fail'),
    (failure: unknown) => failure,
  );

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(AggregateError);
  if (!(error instanceof Error)) throw new Error('Expected a plain Error');
  expect(error.message).toMatch(/^Gateway stream failure \{/);
  // The fixture serializes failureReport(); the field assertions of each probe fail on any gap.
  const report = JSON.parse(error.message.slice(PREFIX.length)) as FailureReport;
  expect(probe.port).toBeTypeOf('number');
  for (const secret of ['dsh-auth', 'platform_session', `test-${String(probe.port)}`, 'cookie'])
    expect(error.message).not.toContain(secret);
  expect([...keys(report, new Set())].filter((key) => !REPORT_KEYS.has(key))).toEqual([]);
  expect(probe.phases.at(-1)).toBe('cleaned');
  expect(probe.directory !== undefined && existsSync(probe.directory)).toBe(false);
  return { error, report };
}

it('attributes an upstream download pipeline rejection after both directions succeeded', async ({
  signal,
}) => {
  const probe: Probe = { phases: [], children: [] };

  const { error, report } = await attributed(
    runLargeTransfer('stream', 'src', {
      signal,
      fault: 'download-pipeline',
      observe: observer(probe),
    }),
    probe,
  );

  expect(report.phase).toBe('upstream-pipeline:download');
  expect(error.cause).toBeInstanceOf(AggregateError);
  // Checked by the instanceof assertion above; expect() does not narrow.
  expect((error.cause as AggregateError).errors).toHaveLength(1);
  const upstream = report.traces.download?.upstream.events ?? [];
  const finish = upstream.find((event) => event.stream === 'response' && event.kind === 'finish');
  const rejected = upstream.find((event) => event.stream === 'response' && event.kind === 'error');
  expect(finish?.seq).toBeLessThan(rejected?.seq ?? -1);
  expect(report.traces.upload?.client.status).toBe(201);
  expect(report.traces.download?.client.status).toBe(200);
  expect(report.traces.download?.client.read).toBe(STREAM_BYTES);
}, 60_000); // Real 400MiB traffic plus child startup, as in gateway-stream.integration.test.ts.

it('attributes a gateway child SIGKILLed mid-upload to the gateway', async ({ signal }) => {
  const probe: Probe = { phases: [], children: [] };
  const kill = (phase: string, _file: string, owned: Probe) => {
    if (phase === 'upload') owned.children[0]?.kill('SIGKILL');
  };

  const { report } = await attributed(
    runLargeTransfer('stream', 'src', { signal, observe: observer(probe, kill) }),
    probe,
  );

  expect(report.phase).toBe('upload');
  expect(report.firstClose).toBe('gateway');
  expect(report.traces.upload?.child).toMatchObject({ signal: 'SIGKILL', escalated: false });
  expect(report.traces.upload?.client.written).toBeGreaterThan(0);
  expect(report.traces.upload?.client.written).toBeLessThan(STREAM_BYTES);
}, 60_000); // One partial upload plus child startup and settlement.

it('attributes an upstream that destroys its incoming upload to the upstream', async ({
  signal,
}) => {
  const probe: Probe = { phases: [], children: [] };

  const { report } = await attributed(
    runLargeTransfer('stream', 'src', {
      signal,
      fault: 'upload-incoming',
      observe: observer(probe),
    }),
    probe,
  );

  expect(report.phase).toBe('upload');
  expect(report.firstClose).toBe('upstream');
  expect(report.traces.upload?.upstream.received).toBeGreaterThan(0);
  expect(report.traces.upload?.upstream.received).toBeLessThan(STREAM_BYTES);
  expect(report.traces.upload?.client.written).toBeLessThan(STREAM_BYTES);
  expect(Object.keys(report.traces.upload?.child ?? {})).toEqual(
    expect.arrayContaining(['exitCode', 'signal', 'escalated']),
  );
}, 60_000); // One partial upload plus child startup and settlement.

it('attributes a stored payload read failure between the directions', async ({ signal }) => {
  const probe: Probe = { phases: [], children: [] };
  let unlinked = false;
  const unlink = (phase: string, file: string) => {
    if (phase !== 'child-settled' || unlinked) return;
    unlinked = true;
    unlinkSync(file);
  };

  const { error, report } = await attributed(
    runLargeTransfer('stream', 'src', { signal, observe: observer(probe, unlink) }),
    probe,
  );

  expect(report.phase).toBe('stored');
  expect(error.cause).toMatchObject({ code: 'ENOENT' });
  expect(probe.children).toHaveLength(1);
}, 60_000); // One complete 200MiB upload plus child startup and settlement.
