import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { DockerClient } from './client.ts';
import { acquireDshCookie } from './credentials.ts';
import type { AcquireDshCookieInput as AcquisitionInput } from './credentials.ts';
import { waitForUserContainerReady } from './readiness.ts';
import { startUserContainer } from './start.ts';
import type { StartResult, StartUserContainerInput as StartupInput } from './start.ts';
import { stopUserContainer } from './stop.ts';
import type { StopUserContainerInput as RetirementInput } from './stop.ts';
import { discoverReconciliationUsers, reconcileUser } from './reconcile.ts';

export interface OrchestratorDependencies {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
}

export type StartUserContainerInput = Omit<StartupInput, keyof OrchestratorDependencies>;
export type AcquireDshCookieInput = Omit<AcquisitionInput, keyof OrchestratorDependencies>;
export type StopUserContainerInput = Omit<RetirementInput, keyof OrchestratorDependencies>;

export interface Orchestrator {
  readonly startUserContainer: (input: StartUserContainerInput) => Promise<StartResult>;
  readonly acquireDshCookie: (input: AcquireDshCookieInput) => Promise<void>;
  readonly waitForUserContainerReady: (input: AcquireDshCookieInput) => Promise<void>;
  readonly stopUserContainer: (input: StopUserContainerInput) => Promise<void>;
  readonly reconcile: (input?: { readonly signal?: AbortSignal }) => Promise<void>;
}

/** One owner belongs to the platform/database lifetime, not to an individual request. */
export function createOrchestrator(dependencies: OrchestratorDependencies): Orchestrator {
  const { client, database } = dependencies;
  const tails = new Map<string, Promise<undefined>>();
  const pending = new Set<string>();

  function reserve(userId: string): boolean {
    // Read after asynchronous reuse inspection: settings may have changed while it was pending.
    const { maxRunningInstances } = readSettings(database);
    const occupied = new Set(pending);
    const rows = database
      .prepare<[], { user_id: string }>(
        "SELECT user_id FROM instances WHERE status IN ('starting', 'running')",
      )
      .all();
    for (const row of rows) occupied.add(row.user_id);
    // Reaching admission means no live reusable identity; an exact-ID404 replacement owns its slot.
    occupied.delete(userId);
    if (occupied.size >= maxRunningInstances) return false;
    pending.add(userId);
    return true;
  }

  async function start(input: StartupInput): Promise<StartResult> {
    try {
      return await startUserContainer(input, () => reserve(input.userId));
    } finally {
      // Await actual work/cleanup, not caller cancellation. A durable active row remains counted.
      pending.delete(input.userId);
    }
  }

  function schedule<
    Input extends { readonly userId: string; readonly signal?: AbortSignal },
    Result,
  >(
    input: Input,
    operation: (input: Input & OrchestratorDependencies) => Promise<Result>,
    failure: string,
    awaitSettlement = false,
  ): Promise<Result> {
    const captured = { ...input, client, database };
    const { userId, signal } = captured;
    if (typeof userId !== 'string' || userId.length !== 12 || !/^[a-z0-9]{12}$/.test(userId))
      return Promise.reject(new Error(failure));
    if (signal?.aborted) return Promise.reject(new Error(failure));
    const result = Promise.withResolvers<Result>();
    const canceled = () => {
      result.reject(new Error(failure));
    };
    if (!awaitSettlement) signal?.addEventListener('abort', canceled, { once: true });
    // Waiting cancellation rejects the caller, but its FIFO slot still follows the predecessor.
    const work = (tails.get(userId) ?? Promise.resolve(undefined)).then(async () => {
      // Active cancellation belongs to the operation, including its independent cleanup.
      signal?.removeEventListener('abort', canceled);
      if (signal?.aborted) {
        result.reject(new Error(failure));
        return undefined;
      }
      try {
        result.resolve(await operation(captured));
      } catch (error) {
        result.reject(error);
      }
      return undefined;
    });
    const tail: Promise<undefined> = work.then(() => {
      if (tails.get(userId) === tail) tails.delete(userId);
      return undefined;
    });
    tails.set(userId, tail);
    return result.promise;
  }

  async function reconcile(input: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const signal = input.signal;
    const cancellation = signal === undefined ? {} : { signal };
    try {
      const users = await discoverReconciliationUsers({ client, database, ...cancellation });
      // Observe every launched operation to actual settlement, including cancellation/failure.
      const results = await Promise.allSettled(
        users.map((userId) =>
          schedule(
            { ...cancellation, userId },
            reconcileUser,
            'Instance reconciliation failed',
            true,
          ),
        ),
      );
      if (signal?.aborted || results.some((result) => result.status === 'rejected'))
        throw new Error();
    } catch {
      throw new Error('Instance reconciliation failed');
    }
  }

  return {
    reconcile,
    startUserContainer: (input: StartUserContainerInput) =>
      schedule(input, start, 'Container startup failed during account validation or cancellation'),
    acquireDshCookie: (input: AcquireDshCookieInput) =>
      schedule(
        input,
        acquireDshCookie,
        'DSH credential acquisition failed during current instance or cancellation',
      ),
    waitForUserContainerReady: (input: AcquireDshCookieInput) =>
      schedule(
        input,
        waitForUserContainerReady,
        'DSH readiness failed before selecting an owned instance',
      ),
    stopUserContainer: (input: StopUserContainerInput) =>
      schedule(input, stopUserContainer, 'User container retirement failed'),
  };
}
