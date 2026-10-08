import type { DatabaseHandle } from '../db/index.ts';
import type { DockerClient } from './client.ts';
import { acquireDshCookie } from './credentials.ts';
import type { AcquireDshCookieInput as AcquisitionInput } from './credentials.ts';
import { waitForUserContainerReady } from './readiness.ts';
import { startUserContainer } from './start.ts';
import type { StartResult, StartUserContainerInput as StartupInput } from './start.ts';
import { stopUserContainer } from './stop.ts';
import type { StopUserContainerInput as RetirementInput } from './stop.ts';

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
}

/** One owner belongs to the platform/database lifetime, not to an individual request. */
export function createOrchestrator(dependencies: OrchestratorDependencies): Orchestrator {
  const { client, database } = dependencies;
  const tails = new Map<string, Promise<undefined>>();

  function schedule<
    Input extends { readonly userId: string; readonly signal?: AbortSignal },
    Result,
  >(
    input: Input,
    operation: (input: Input & OrchestratorDependencies) => Promise<Result>,
    failure: string,
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
    signal?.addEventListener('abort', canceled, { once: true });
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

  return {
    startUserContainer: (input: StartUserContainerInput) =>
      schedule(
        input,
        startUserContainer,
        'Container startup failed during account validation or cancellation',
      ),
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
