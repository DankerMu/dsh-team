export function remoteRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid model refusal observation');
  }
  // Boundary narrowing; no raw response or configuration is included in failures.
  return value as Record<string, unknown>;
}

export interface ModelRefusalTurn {
  userSeq: number | null;
  turn: number | null;
  terminalSeq: number | null;
  errorCode: string | null;
  connectionError: boolean;
}

function classifyModelFailure(
  error: Record<string, unknown>,
): Pick<ModelRefusalTurn, 'errorCode' | 'connectionError'> {
  const errorCode = typeof error.code === 'string' ? error.code : null;
  // Released pi-ai collapses connection refusal to TRANSPORT plus SDK connection text.
  const connectionError =
    typeof error.message === 'string' &&
    /connection|ECONNREFUSED|fetch failed/i.test(error.message);
  return { errorCode, connectionError };
}

export function modelRefusalTurn(records: readonly unknown[], requestId: string): ModelRefusalTurn {
  let current: number | null = null;
  let turn: number | null = null;
  let userSeq: number | null = null;
  let terminalSeq: number | null = null;
  let errorCode: string | null = null;
  let connectionError = false;
  for (const row of records) {
    const event = remoteRecord(remoteRecord(row).event);
    const data = remoteRecord(event.data);
    if (event.type === 'turn/start' && typeof data.turn === 'number') current = data.turn;
    if (event.type === 'user/message' && remoteRecord(data.source).rpcId === requestId) {
      if (userSeq !== null) throw new Error('Duplicate accepted prompt');
      userSeq = typeof event.seq === 'number' ? event.seq : null;
      turn = current;
    }
    if (event.type !== 'turn/end') continue;
    current = null;
    if (turn === null || data.turn !== turn || userSeq === null) continue;
    const reason = remoteRecord(data.reason);
    terminalSeq = typeof event.seq === 'number' ? event.seq : null;
    if (reason.kind !== 'error') continue;
    const failure = classifyModelFailure(remoteRecord(reason.error));
    errorCode = failure.errorCode;
    connectionError = failure.connectionError;
  }
  return { userSeq, turn, terminalSeq, errorCode, connectionError };
}

export interface ModelRefusalObservation {
  accepted: boolean;
  promptCount: number;
  sessionId: string;
  requestId: string;
  turn: ModelRefusalTurn;
  running: boolean;
  usedProvider: string;
  usedModel: string;
  visibleError: boolean;
  recorder: {
    baseline: number;
    total: number;
    inflight: number;
    controlStatus: number;
    overflow: boolean;
  };
}

function assertTerminalConnection(turn: ModelRefusalTurn): void {
  if (
    turn.turn === null ||
    turn.userSeq === null ||
    turn.terminalSeq === null ||
    turn.terminalSeq <= turn.userSeq ||
    turn.errorCode !== 'TRANSPORT' ||
    !turn.connectionError
  ) {
    throw new Error('Expected correlated terminal model connection error');
  }
}

export function assertModelRefusal(observed: ModelRefusalObservation): void {
  if (observed.recorder.total !== observed.recorder.baseline)
    throw new Error('Observed alternate requests');
  if (
    !observed.accepted ||
    observed.promptCount !== 1 ||
    !observed.sessionId ||
    !observed.requestId
  ) {
    throw new Error('Expected exactly one accepted Session prompt');
  }
  assertTerminalConnection(observed.turn);
  if (
    observed.running ||
    observed.recorder.inflight !== 0 ||
    observed.recorder.overflow ||
    observed.recorder.controlStatus !== 204 ||
    observed.recorder.baseline !== 1
  ) {
    throw new Error('Expected completed request work and reachable recorder');
  }
  if (
    observed.usedProvider !== 'intranet' ||
    observed.usedModel !== 'beta' ||
    !observed.visibleError
  ) {
    throw new Error('Expected actual managed provider and employee-visible error');
  }
}
