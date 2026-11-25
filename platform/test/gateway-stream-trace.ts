import { errorMonitor } from 'node:events';
import type { EventEmitter } from 'node:events';

export type StreamDirection = 'upload' | 'download';
export type FailurePhase =
  | 'resources'
  | StreamDirection
  | 'stored'
  | 'upstream-cleanup'
  | `upstream-pipeline:${StreamDirection}`
  | 'payload-cleanup';
type TraceEnd = 'client' | 'upstream' | 'child';
type TraceStream = 'request' | 'response' | 'socket' | 'process';
type LifecycleKind = 'finish' | 'end' | 'close' | 'aborted';
type TraceKind = LifecycleKind | 'error' | 'exit';
interface TraceEvent {
  seq: number;
  end: TraceEnd;
  stream: TraceStream;
  kind: TraceKind;
  ms: number;
  code?: string;
  name?: string;
}
// Counters and lifecycle facts only: no header, cookie, URL, body or error message is ever kept.
export interface TransferTrace {
  client: { written: number; read: number; status: number | null; events: TraceEvent[] };
  upstream: { received: number; sent: number; events: TraceEvent[] };
  child: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    escalated: boolean;
    events: TraceEvent[];
  };
}
export interface TransferRecorder {
  readonly trace: TransferTrace;
  observe(
    end: 'client' | 'upstream',
    stream: Exclude<TraceStream, 'process'>,
    emitter: EventEmitter,
    kinds: readonly LifecycleKind[],
  ): void;
  record(end: TraceEnd, stream: TraceStream, kind: TraceKind, error?: unknown): void;
  exited(exitCode: number | null, signal: NodeJS.Signals | null): void;
}
type FirstClose = 'gateway' | 'client' | 'upstream' | 'none';
export interface FailureReport {
  phase: FailurePhase;
  firstClose: FirstClose;
  traces: Partial<Record<StreamDirection, TransferTrace>>;
}

/** One sequence shared by every end of one runLargeTransfer: order is decided by seq, never by ms. */
export function traceTimeline(): { seq: number } {
  return { seq: 0 };
}

export function transferRecorder(timeline: { seq: number }): TransferRecorder {
  const start = performance.now();
  const trace: TransferTrace = {
    client: { written: 0, read: 0, status: null, events: [] },
    upstream: { received: 0, sent: 0, events: [] },
    child: { exitCode: null, signal: null, escalated: false, events: [] },
  };
  // First occurrence per (end, stream, kind) bounds each end to 4x6=24 events, inside the 32 cap.
  const record = (end: TraceEnd, stream: TraceStream, kind: TraceKind, error?: unknown) => {
    const events = trace[end].events;
    if (events.some((event) => event.stream === stream && event.kind === kind)) return;
    timeline.seq += 1;
    const event: TraceEvent = {
      seq: timeline.seq,
      end,
      stream,
      kind,
      ms: Math.round((performance.now() - start) * 10) / 10,
    };
    if (typeof error === 'object' && error !== null) {
      if ('code' in error && typeof error.code === 'string') event.code = error.code;
      if (error instanceof Error) event.name = error.name;
    }
    events.push(event);
  };
  return {
    trace,
    observe(end, stream, emitter, kinds) {
      for (const kind of kinds)
        emitter.once(kind, () => {
          record(end, stream, kind);
        });
      // errorMonitor observes without handling: an unhandled error still throws as before.
      emitter.once(errorMonitor, (error: unknown) => {
        record(end, stream, 'error', error);
      });
    },
    record,
    exited(exitCode, signal) {
      trace.child.exitCode = exitCode;
      trace.child.signal = signal;
      record('child', 'process', 'exit');
    },
  };
}

function earliestPremature(events: readonly TraceEvent[]): number {
  let earliest = Infinity;
  for (const event of events) {
    if (event.kind !== 'close' && event.kind !== 'aborted' && event.kind !== 'error') continue;
    const completed = events.some(
      (other) =>
        other.stream === event.stream &&
        (other.kind === 'finish' || other.kind === 'end') &&
        other.seq < event.seq,
    );
    if (!completed) earliest = Math.min(earliest, event.seq);
  }
  return earliest;
}

/**
 * The gateway wins whenever its child ended abnormally outside the shutdown escalation: a
 * SIGKILL's exit notice and the sockets' close notices reach the parent in no fixed order.
 */
export function firstClose(trace: TransferTrace): FirstClose {
  const { child } = trace;
  if (!child.escalated && (child.signal !== null || (child.exitCode ?? 0) !== 0)) return 'gateway';
  const client = earliestPremature(trace.client.events);
  const upstream = earliestPremature(trace.upstream.events);
  if (client === Infinity && upstream === Infinity) return 'none';
  return client < upstream ? 'client' : 'upstream';
}

/** firstClose follows the phase's direction; other phases use the latest started direction. */
export function failureReport(
  phase: FailurePhase,
  recorders: Partial<Record<StreamDirection, TransferRecorder>>,
): FailureReport {
  const traces: FailureReport['traces'] = {};
  if (recorders.upload !== undefined) traces.upload = recorders.upload.trace;
  if (recorders.download !== undefined) traces.download = recorders.download.trace;
  const focus = phase.endsWith('upload')
    ? traces.upload
    : phase.endsWith('download')
      ? traces.download
      : (traces.download ?? traces.upload);
  return { phase, firstClose: focus === undefined ? 'none' : firstClose(focus), traces };
}
