import type { PlatformConfig } from '../config.ts';
import type { InstanceStopReason } from '../audit/index.ts';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { hasCompleteModelSettings } from '../managed-config/index.ts';
import { IdleChecks, complete } from './idle.ts';
import type { DockerClient } from './client.ts';
import { createOrchestrator } from './orchestrator.ts';
import type { GetUserActivity, RuntimeRow } from './idle.ts';

type InstanceStatus = 'running' | 'stopped' | 'starting' | 'full' | 'error' | 'unconfigured';
interface InstanceState {
  readonly status: InstanceStatus;
  readonly reason: Exclude<InstanceStatus, 'running'> | null;
}
type InstanceUpstream =
  | {
      readonly outcome: 'running';
      readonly host: string;
      readonly port: number;
      readonly cookie: string;
    }
  | { readonly outcome: Exclude<InstanceStatus, 'running'> };
export interface InstanceService {
  readonly reconcile: () => Promise<void>;
  readonly start: (userId: string) => Promise<InstanceState>;
  readonly stop: (userId: string, reason: InstanceStopReason) => Promise<void>;
  readonly resetConfig: (userId: string, assertCurrent: () => void) => Promise<void>;
  readonly status: (userId: string) => InstanceState;
  readonly hasStartupWork: (userId: string) => boolean;
  readonly resolveUpstream: (userId: string) => InstanceUpstream;
  readonly recordActivity: (userId: string, lastActivityAt: number) => void;
  readonly flushActivity: (phase?: 'shutdown') => Promise<void>;
  readonly checkIdle: (getActivity: GetUserActivity) => Promise<void>;
  readonly close: () => Promise<void>;
}
interface FailureIdentity {
  containerId: string | null | undefined;
  startedAt: number | null | undefined;
  status: RuntimeRow['status'] | undefined;
}
function state(status: InstanceStatus): InstanceState {
  return { status, reason: status === 'running' ? null : status };
}

function matchesFailure(row: RuntimeRow | undefined, identity: FailureIdentity): boolean {
  if (row === undefined) return identity.containerId === undefined && identity.status === undefined;
  return (
    row.container_id === identity.containerId &&
    (identity.startedAt === undefined || row.last_started_at === identity.startedAt) &&
    row.status === identity.status
  );
}

function matchesReadiness(
  row: RuntimeRow | undefined,
  identity: { containerId: string; startedAt: number | null },
): boolean {
  if (row === undefined) return false;
  return row.container_id === identity.containerId && row.last_started_at === identity.startedAt;
}

function model(database: DatabaseHandle) {
  const settings = readSettings(database);
  return {
    modelSettings: {
      baseURL: settings.modelBaseUrl,
      apiKeyEnv: 'DSH_TEAM_MODEL_API_KEY',
      models: settings.models,
      defaultModel: settings.defaultModel,
    },
    modelKey: settings.modelApiKey,
  };
}

function matchingReceipt(
  userId: string,
  row: RuntimeRow | undefined,
  receipts: Map<string, FailureIdentity>,
): boolean {
  const identity = receipts.get(userId);
  if (identity === undefined) return false;
  if (matchesFailure(row, identity)) return true;
  receipts.delete(userId);
  return false;
}

function observedWork(
  userId: string,
  row: RuntimeRow | undefined,
  failures: Map<string, FailureIdentity>,
  absences: Map<string, FailureIdentity>,
  flights: ReadonlyMap<string, unknown>,
): InstanceState | undefined {
  if (matchingReceipt(userId, row, failures)) throw new Error('Instance operation failed');
  const excluded = matchingReceipt(userId, row, absences);
  if (!excluded && row?.status === 'running') return state(complete(row) ? 'running' : 'error');
  if (flights.has(userId)) return state('starting');
  if (!excluded && (row?.status === 'starting' || row?.status === 'error'))
    return state(row.status);
  return undefined;
}

function admissionState(
  database: DatabaseHandle,
  owner: ReturnType<typeof createOrchestrator>,
  userId: string,
): InstanceState {
  const snapshot = model(database);
  if (
    !hasCompleteModelSettings({
      ...snapshot.modelSettings,
      apiKeyConfigured: snapshot.modelKey.trim() !== '',
    })
  )
    return state('unconfigured');
  return state(owner.hasCapacity(userId) ? 'stopped' : 'full');
}

function admitted(
  userId: string,
  admission: Promise<InstanceState>,
  status: InstanceService['status'],
): Promise<InstanceState> {
  return admission.then((result) =>
    result.status === 'full' || result.status === 'unconfigured' ? result : status(userId),
  );
}

function recordFailure(
  select: { get(userId: string): RuntimeRow | undefined },
  failures: Map<string, FailureIdentity>,
  absences: ReadonlyMap<string, FailureIdentity>,
  userId: string,
  readinessIdentity: { containerId: string; startedAt: number | null } | undefined,
  fallbackIdentity: FailureIdentity,
  admission: PromiseWithResolvers<InstanceState>,
): void {
  try {
    const row = select.get(userId);
    if (row?.status === 'error') {
      admission.resolve(state('error'));
      return;
    }
    const absent = absences.get(userId);
    if (absent !== undefined && matchesFailure(row, absent)) {
      failures.set(userId, absent);
      admission.reject(new Error('Instance operation failed'));
      return;
    }
    if (
      row?.status !== 'running' &&
      (readinessIdentity === undefined || matchesReadiness(row, readinessIdentity))
    )
      failures.set(userId, {
        containerId: row?.container_id,
        startedAt: row?.last_started_at,
        status: row?.status,
      });
  } catch {
    // Record before releasing the flight, even when catch-time storage cannot be read.
    if (fallbackIdentity.status !== 'running' || absences.get(userId) === fallbackIdentity)
      failures.set(userId, fallbackIdentity);
  }
  admission.reject(new Error('Instance operation failed'));
}

function resolveRunningUpstream(
  row: RuntimeRow | undefined,
  current: InstanceState,
): InstanceUpstream {
  if (current.status === 'running' && row?.status === 'running' && complete(row)) {
    // complete() proves these nullable fields; endpoint and cookie come from one SELECT row.
    return {
      outcome: 'running',
      host: row.upstream_host,
      port: row.upstream_port,
      cookie: row.dsh_cookie,
    };
  }
  return { outcome: current.status === 'running' ? 'error' : current.status };
}

/** Owns one start-through-readiness flight, never another lifecycle queue or capacity ledger. */
export function createInstanceService({
  client,
  database,
  config,
}: {
  client: DockerClient;
  database: DatabaseHandle;
  config: PlatformConfig;
}): InstanceService {
  const owner = createOrchestrator({ client, database, config });
  const select = database.prepare<[string], RuntimeRow>(
    'SELECT * FROM instances WHERE user_id = ?',
  );
  const flights = new Map<
    string,
    { admission: Promise<InstanceState>; work: Promise<void>; controller: AbortController }
  >();
  const stops = new Map<string, Promise<void>>();
  // Identity receipts only: no credentials, endpoints, capacity or lifecycle-state cache.
  const failures = new Map<string, FailureIdentity>();
  const absences = new Map<string, FailureIdentity>();
  const reconciliations = new Set<Promise<void>>();
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const idleChecks = new IdleChecks({
    database,
    config,
    owner,
    row: (userId) => select.get(userId),
    hasFlight: (userId) => flights.has(userId) || stops.has(userId),
    isClosing: () => closing,
  });

  function observed(userId: string, row: RuntimeRow | undefined): InstanceState {
    if (idleChecks.isRetiring(userId, row)) return state('starting');
    return (
      observedWork(userId, row, failures, absences, flights) ??
      admissionState(database, owner, userId)
    );
  }
  function status(userId: string): InstanceState {
    return observed(userId, select.get(userId));
  }
  function start(userId: string): Promise<InstanceState> {
    if (closing || stops.has(userId))
      return Promise.reject(new Error('Instance service unavailable'));
    // Every explicit start invalidates idle, including reuse, rejected admission and shared flights.
    idleChecks.invalidate(userId);
    const existing = flights.get(userId);
    if (existing !== undefined) return admitted(userId, existing.admission, status);
    // Snapshot canonical settings for this admission; even running reuse retains model precedence.
    const snapshot = model(database);
    const initial = select.get(userId);
    const previous = absences.get(userId);
    // Explicit admission clears an error, never the independently retained absence fence.
    failures.delete(userId);
    let failureIdentity: FailureIdentity =
      previous !== undefined && matchesFailure(initial, previous)
        ? previous
        : {
            containerId: initial?.container_id,
            startedAt: initial?.last_started_at,
            status: initial?.status,
          };
    const admission = Promise.withResolvers<InstanceState>();
    const flight = {
      admission: admission.promise,
      work: Promise.resolve(),
      controller: new AbortController(),
    };
    flights.set(userId, flight);
    flight.work = (async () => {
      let readinessIdentity: { containerId: string; startedAt: number | null } | undefined;
      try {
        const result = await owner.startUserContainer({
          userId,
          config,
          ...snapshot,
          signal: flight.controller.signal,
          onVerifiedAbsent: (identity) => {
            if (matchesFailure(select.get(userId), identity)) {
              failureIdentity = identity;
              absences.set(userId, identity);
            }
          },
        });
        flight.controller.signal.throwIfAborted();
        if (result.outcome === 'running' && absences.get(userId) === previous)
          absences.delete(userId);
        admission.resolve(state(result.outcome));
        if (result.outcome === 'starting') {
          failureIdentity = {
            containerId: result.containerId,
            startedAt: undefined,
            status: 'starting',
          };
          const row = select.get(userId);
          // Never acquire a credential for a replacement that appeared after this start result.
          readinessIdentity = {
            containerId: result.containerId,
            startedAt: row?.last_started_at ?? null,
          };
          failureIdentity.startedAt = row?.last_started_at;
          if (row?.container_id !== result.containerId)
            throw new Error('Instance operation failed');
          await owner.waitForUserContainerReady({
            userId,
            authority: config.authority,
            signal: flight.controller.signal,
          });
        }
      } catch {
        // Persisted lifecycle errors are ordinary states; unexpected failures remain safe HTTP500.
        recordFailure(
          select,
          failures,
          absences,
          userId,
          readinessIdentity,
          failureIdentity,
          admission,
        );
      } finally {
        if (flights.get(userId) === flight) flights.delete(userId);
      }
    })();
    // Observe background persistence failures too; no raw diagnostic or cached last outcome.
    void flight.work.catch(() => {
      admission.reject(new Error('Instance operation failed'));
    });
    return admitted(userId, flight.admission, status);
  }

  function stop(
    userId: string,
    reason: InstanceStopReason,
    afterStop?: () => Promise<void>,
  ): Promise<void> {
    if (closing) return Promise.reject(new Error('Instance service unavailable'));
    const existing = stops.get(userId);
    if (existing !== undefined && afterStop === undefined) return existing;
    if (existing !== undefined) return Promise.reject(new Error('Instance service unavailable'));
    idleChecks.invalidate(userId);
    const flight = flights.get(userId);
    flight?.controller.abort();
    const work = (async () => {
      if (flight !== undefined) await Promise.allSettled([flight.work]);
      // Always enqueue: canceled callers can settle before their actual owner tail.
      await owner.stopUserContainer({ userId, reason, allowMissingInstance: true });
      failures.delete(userId);
      absences.delete(userId);
      if (afterStop !== undefined) await afterStop();
    })();
    stops.set(userId, work);
    void work
      .finally(() => {
        if (stops.get(userId) === work) stops.delete(userId);
      })
      .catch(() => undefined);
    return work;
  }
  return {
    start,
    stop,
    resetConfig: (userId, assertCurrent) =>
      stop(userId, 'admin', async () => {
        assertCurrent();
        await owner.restoreUserProfiles({ userId, config });
      }),
    status,
    hasStartupWork: (userId) => flights.has(userId),
    checkIdle: idleChecks.checkIdle,
    // Release observations remain valid while close fences lifecycle admission.
    // App shutdown awaits its final flush before closing SQLite.
    recordActivity: (userId, lastActivityAt) => {
      // An event at the same timestamp still invalidates pending task/queue observations.
      idleChecks.invalidate(userId);
      owner.recordActivity(userId, lastActivityAt);
    },
    flushActivity: async (phase) => {
      try {
        await owner.flushActivity(phase);
      } finally {
        // A previously resolved close promise cannot cover later release submissions.
        if (phase === 'shutdown') await owner.drain();
      }
    },
    resolveUpstream: (userId) => {
      const row = select.get(userId);
      return resolveRunningUpstream(row, observed(userId, row));
    },
    reconcile: () => {
      if (closing) return Promise.reject(new Error('Instance service unavailable'));
      const work = owner.reconcile();
      reconciliations.add(work);
      void work.finally(() => reconciliations.delete(work)).catch(() => undefined);
      return work;
    },
    close: () => {
      closing = true;
      shutdown ??= (async () => {
        await Promise.allSettled([
          idleChecks.close(),
          ...reconciliations,
          ...stops.values(),
          ...[...flights.values()].map((flight) => flight.work),
        ]);
        await owner.drain();
      })();
      return shutdown;
    },
  };
}
