import type * as ObserverModule from './deployment-observer-fixture.ts';
import type { DeploymentObservation } from './deployment-observer-fixture.ts';

export const SUBSTITUTE_OBSERVER_OVERRIDE = '/dsh-team-observer-substitute/compose.json';

/** Only the fields read by the substituted lifecycle calls below exist on this observation. */
export function substituteObservation(bound: boolean): DeploymentObservation {
  return {
    override: SUBSTITUTE_OBSERVER_OVERRIDE,
    current: {
      bound: bound ? { id: 'c'.repeat(64), startedAt: '2026-01-02T03:04:05Z' } : undefined,
    },
  } as unknown as DeploymentObservation;
}

/**
 * The real observer requires the qualified uid1000 Docker host and an in-container writer, which
 * Docker-free integration discovery cannot provide. Substitute only that boundary: record each
 * lifecycle call and keep the parent-binding readiness rule, never retirement authority.
 */
export function observerSubstitute(
  original: typeof ObserverModule,
  record: (event: string) => void,
): typeof ObserverModule {
  return {
    ...original,
    createDeploymentObservation(_lifecycle, imageId) {
      record(`create:${imageId}`);
      return Promise.resolve(substituteObservation(false));
    },
    bindDeploymentObservation(observation) {
      observation.current.bound = { id: 'c'.repeat(64), startedAt: '2026-01-02T03:04:05Z' };
      record('bind');
      return Promise.resolve();
    },
    requireDeploymentObservationReady(observation) {
      if (observation.current.bound === undefined)
        throw new Error('Deployment observer parent binding missing');
      record('ready');
    },
    finishDeploymentObservation(observation, scenarioSucceeded) {
      record(`finish:${String(scenarioSucceeded)}`);
      // Mirror the real retirement precondition: an unbound generation is never confirmed.
      if (observation.current.bound === undefined)
        return Promise.reject(new Error('Deployment generation was never bound'));
      return Promise.resolve();
    },
  };
}
