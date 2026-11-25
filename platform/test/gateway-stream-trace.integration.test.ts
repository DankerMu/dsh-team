import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import {
  failureReport,
  firstClose,
  traceTimeline,
  transferRecorder,
} from './gateway-stream-trace.ts';
import type { TransferTrace } from './gateway-stream-trace.ts';

type Event = TransferTrace['client']['events'][number];
const event = (seq: number, end: Event['end'], stream: Event['stream'], kind: Event['kind']) => ({
  seq,
  end,
  stream,
  kind,
  ms: 5,
});
function trace(events: Event[], child: Partial<TransferTrace['child']> = {}): TransferTrace {
  return {
    client: {
      written: 0,
      read: 0,
      status: null,
      events: events.filter((item) => item.end === 'client'),
    },
    upstream: { received: 0, sent: 0, events: events.filter((item) => item.end === 'upstream') },
    child: { exitCode: 0, signal: null, escalated: false, events: [], ...child },
  };
}

it('reports none for a trace whose every close follows its own finish or end', () => {
  const clean = trace([
    event(1, 'upstream', 'request', 'end'),
    event(2, 'upstream', 'response', 'finish'),
    event(3, 'client', 'request', 'finish'),
    event(4, 'client', 'response', 'end'),
    event(5, 'client', 'response', 'close'),
    event(6, 'upstream', 'response', 'close'),
    event(7, 'client', 'socket', 'end'),
    event(8, 'client', 'socket', 'close'),
  ]);

  expect(firstClose(clean)).toBe('none');
});

it('names the end with the earliest premature close, aborted or error event', () => {
  const upstreamFirst = trace([
    event(1, 'client', 'request', 'finish'),
    event(2, 'upstream', 'request', 'aborted'),
    event(3, 'client', 'response', 'close'),
  ]);
  const clientFirst = trace([
    event(1, 'upstream', 'request', 'end'),
    event(2, 'client', 'socket', 'error'),
    event(3, 'upstream', 'response', 'close'),
  ]);

  expect(firstClose(upstreamFirst)).toBe('upstream');
  expect(firstClose(clientFirst)).toBe('client');
});

it('ignores a close that follows its own stream completion', () => {
  const completed = trace([
    event(1, 'client', 'response', 'end'),
    event(2, 'client', 'response', 'close'),
    event(3, 'upstream', 'socket', 'close'),
  ]);

  expect(firstClose(completed)).toBe('upstream');
});

it('names the gateway for an abnormal unescalated child even after earlier premature events', () => {
  const premature = [
    event(1, 'client', 'socket', 'close'),
    event(2, 'upstream', 'request', 'aborted'),
  ];

  expect(firstClose(trace(premature, { signal: 'SIGKILL', exitCode: null }))).toBe('gateway');
  expect(firstClose(trace(premature, { exitCode: 1 }))).toBe('gateway');
});

it('does not name the gateway for the shutdown SIGKILL escalation', () => {
  const escalated = trace([event(4, 'upstream', 'socket', 'close')], {
    signal: 'SIGKILL',
    exitCode: null,
    escalated: true,
  });

  expect(firstClose(escalated)).toBe('upstream');
});

it('orders events with equal ms by seq', () => {
  const tied = trace([
    event(9, 'client', 'request', 'close'),
    event(8, 'upstream', 'socket', 'close'),
  ]);

  expect(tied.client.events[0]?.ms).toBe(tied.upstream.events[0]?.ms);
  expect(firstClose(tied)).toBe('upstream');
});

it('shares one seq across recorders and keeps only first occurrences', async () => {
  const timeline = traceTimeline();
  const upload = transferRecorder(timeline);
  const download = transferRecorder(timeline);
  const stream = new PassThrough();
  upload.observe('client', 'request', stream, ['finish', 'end', 'close']);

  const closed = once(stream, 'close');
  stream.end();
  stream.resume();
  await closed;
  upload.record('upstream', 'response', 'close');
  upload.record('upstream', 'response', 'close');
  download.record('upstream', 'response', 'close');
  upload.exited(null, 'SIGKILL');

  expect(upload.trace.client.events.map((item) => [item.seq, item.kind])).toEqual([
    [1, 'finish'],
    [2, 'end'],
    [3, 'close'],
  ]);
  expect(upload.trace.upstream.events.map((item) => item.seq)).toEqual([4]);
  expect(download.trace.upstream.events.map((item) => item.seq)).toEqual([5]);
  expect(upload.trace.child).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  expect(upload.trace.child.events).toMatchObject([{ seq: 6, end: 'child', kind: 'exit' }]);
});

it('observes errors without handling them and keeps only their code and name', () => {
  const recorder = transferRecorder(traceTimeline());
  const emitter = new EventEmitter();
  recorder.observe('upstream', 'socket', emitter, ['close']);
  const failure = Object.assign(new TypeError('dsh-auth=secret body'), { code: 'ECONNRESET' });

  const emitted = () => emitter.emit('error', failure);

  expect(emitted).toThrow(failure);
  const [observed, ...rest] = recorder.trace.upstream.events;
  expect(rest).toEqual([]);
  expect(observed).toMatchObject({ seq: 1, stream: 'socket', kind: 'error' });
  expect(observed).toMatchObject({ code: 'ECONNRESET', name: 'TypeError' });
  expect(Object.keys(observed ?? {}).sort()).toEqual(
    ['code', 'end', 'kind', 'ms', 'name', 'seq', 'stream'].sort(),
  );
  expect(JSON.stringify(recorder.trace)).not.toContain('secret');
});

it('reports the traces started so far with firstClose of the failing direction', () => {
  const timeline = traceTimeline();
  const upload = transferRecorder(timeline);
  const download = transferRecorder(timeline);
  upload.exited(null, 'SIGKILL');
  download.record('client', 'socket', 'close');

  const pipeline = failureReport('upstream-pipeline:upload', { upload, download });
  const stored = failureReport('stored', { upload });
  const cleanup = failureReport('payload-cleanup', { upload, download });
  const resources = failureReport('resources', {});

  expect(pipeline).toMatchObject({ phase: 'upstream-pipeline:upload', firstClose: 'gateway' });
  expect(JSON.parse(JSON.stringify(pipeline))).toEqual(pipeline);
  expect(Object.keys(pipeline.traces)).toEqual(['upload', 'download']);
  expect(stored).toMatchObject({ firstClose: 'gateway', traces: { upload: upload.trace } });
  expect(Object.keys(stored.traces)).toEqual(['upload']);
  expect(cleanup.firstClose).toBe('client');
  expect(failureReport('download', { upload, download }).firstClose).toBe('client');
  expect(resources).toEqual({ phase: 'resources', firstClose: 'none', traces: {} });
});
