import type { PlatformConfig } from '../config.ts';
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
export interface InstanceService {
  readonly reconcile: () => Promise<void>;
  readonly start: (userId: string) => Promise<InstanceState>;
  readonly status: (userId: string) => InstanceState;
  readonly resolveUpstream: (userId: string) =>
    | {
        readonly outcome: 'running';
        readonly host: string;
        readonly port: number;
        readonly cookie: string;
      }
    | { readonly outcome: Exclude<InstanceStatus, 'running'> };
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

function observedFailure(
  userId: string,
  row: RuntimeRow | undefined,
  failures: Map<string, FailureIdentity & { pending?: boolean }>,
  flights: ReadonlyMap<string, unknown>,
): InstanceState | undefined {
  const failure = failures.get(userId);
  if (failure === undefined) return undefined;
  if (matchesFailure(row, failure)) {
    if (failure.pending === true && flights.has(userId)) return state('starting');
    throw new Error('Instance operation failed');
  }
  failures.delete(userId);
  return undefined;
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
  const flights = new Map<string, { admission: Promise<InstanceState>; work: Promise<void> }>();
  // Exceptional-work receipts only: no credentials, endpoints, capacity or lifecycle-state cache.
  // A running-row receipt can originate only from the owner's verified-absence callback.
  const failures = new Map<string, FailureIdentity & { pending?: boolean }>();
  const reconciliations = new Set<Promise<void>>();
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const idleChecks = new IdleChecks({
    database,
    config,
    owner,
    row: (userId) => select.get(userId),
    hasFlight: (userId) => flights.has(userId),
    isClosing: () => closing,
  });

  function observed(userId: string, row: RuntimeRow | undefined): InstanceState {
    if (idleChecks.isRetiring(userId, row)) return state('starting');
    const failure = observedFailure(userId, row, failures, flights);
    if (failure !== undefined) return failure;
    if (row?.status === 'running') return state(complete(row) ? 'running' : 'error');
    if (flights.has(userId)) return state('starting');
    if (row?.status === 'starting' || row?.status === 'error') return state(row.status);
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
  function status(userId: string): InstanceState {
    return observed(userId, select.get(userId));
  }
  function admitted(userId: string, admission: Promise<InstanceState>): Promise<InstanceState> {
    return admission.then((result) =>
      result.status === 'full' || result.status === 'unconfigured' ? result : status(userId),
    );
  }
  function recordFailure(
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
      const absent = failures.get(userId);
      if (absent !== undefined && matchesFailure(row, absent)) {
        absent.pending = false;
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
      if (fallbackIdentity.status !== 'running') failures.set(userId, fallbackIdentity);
    }
    admission.reject(new Error('Instance operation failed'));
  }
  function start(userId: string): Promise<InstanceState> {
    if (closing) return Promise.reject(new Error('Instance service unavailable'));
    // Every explicit start invalidates idle, including reuse, rejected admission and shared flights.
    idleChecks.invalidate(userId);
    const existing = flights.get(userId);
    if (existing !== undefined) return admitted(userId, existing.admission);
    // Snapshot canonical settings for this admission; even running reuse retains model precedence.
    const snapshot = model(database);
    const initial = select.get(userId);
    const previous = failures.get(userId);
    // A retry is not evidence that a verified-absent running identity became live again.
    if (previous?.status !== 'running' || !matchesFailure(initial, previous))
      failures.delete(userId);
    let failureIdentity: FailureIdentity = {
      containerId: initial?.container_id,
      startedAt: initial?.last_started_at,
      status: initial?.status,
    };
    const admission = Promise.withResolvers<InstanceState>();
    const flight = { admission: admission.promise, work: Promise.resolve() };
    flights.set(userId, flight);
    flight.work = (async () => {
      let readinessIdentity: { containerId: string; startedAt: number | null } | undefined;
      try {
        const result = await owner.startUserContainer({
          userId,
          config,
          ...snapshot,
          onVerifiedAbsent: (identity) => {
            if (matchesFailure(select.get(userId), identity)) {
              failureIdentity = identity;
              failures.set(userId, { ...identity, pending: true });
            }
          },
        });
        if (result.outcome === 'running' && failures.get(userId) === previous)
          failures.delete(userId);
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
          await owner.waitForUserContainerReady({ userId, authority: config.authority });
        }
      } catch {
        // Persisted lifecycle errors are ordinary states; unexpected failures remain safe HTTP500.
        recordFailure(userId, readinessIdentity, failureIdentity, admission);
      } finally {
        const absent = failures.get(userId);
        if (absent !== undefined) absent.pending = false;
        if (flights.get(userId) === flight) flights.delete(userId);
      }
    })();
    // Observe background persistence failures too; no raw diagnostic or cached last outcome.
    void flight.work.catch(() => {
      admission.reject(new Error('Instance operation failed'));
    });
    return admitted(userId, flight.admission);
  }

  return {
    start,
    status,
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
      const current = observed(userId, row);
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
          ...[...flights.values()].map((flight) => flight.work),
        ]);
        await owner.drain();
      })();
      return shutdown;
    },
  };
}
