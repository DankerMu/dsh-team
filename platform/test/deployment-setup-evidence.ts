export type DeploymentSetupPhase =
  | 'deployment-host-admission'
  | 'deployment-lock-admission'
  | 'user-image-preparation'
  | 'deployment-creation'
  | 'fixed-name-admission'
  | 'compose-capability'
  | 'resource-registration'
  | 'platform-build'
  | 'platform-image-identity'
  | 'local-configuration'
  | 'scenario-preparation'
  | 'compose-creation'
  | 'account-configuration'
  | 'health'
  | 'administrator-terminal'
  | 'administrator-login'
  | 'model-configuration'
  | 'employee-registration';

type OperationStatus = 'entered' | 'completed' | 'failed';
type CleanupOutcome = 'not-required' | 'unconfirmed' | 'confirmed';
type CleanupOwner = 'deploymentDrain' | 'resources';
interface SetupFailure {
  readonly phase: DeploymentSetupPhase;
  readonly code: 'operation-failed';
  readonly cause: 'unknown';
}
export interface DeploymentSetupSnapshot {
  readonly current: DeploymentSetupPhase | null;
  readonly lastCompleted: DeploymentSetupPhase | null;
  readonly firstFailure: SetupFailure | null;
  readonly operations: Readonly<Partial<Record<DeploymentSetupPhase, OperationStatus>>>;
  readonly cleanup: Readonly<Record<CleanupOwner, CleanupOutcome>>;
  readonly evidence: 'retained' | 'unavailable';
}
export type DeploymentSetupSink = (snapshot: DeploymentSetupSnapshot) => void | Promise<void>;
export interface DeploymentSetupOperation {
  complete(): void;
  fail(): void;
}
export interface DeploymentSetupEvidence {
  begin(phase: DeploymentSetupPhase): DeploymentSetupOperation;
  run<T>(phase: DeploymentSetupPhase, operation: () => Promise<T>): Promise<T>;
  runSync<T>(phase: DeploymentSetupPhase, operation: () => T): T;
  cleanup(owner: CleanupOwner, outcome: CleanupOutcome): void;
  snapshot(): DeploymentSetupSnapshot;
  publish(): Promise<boolean>;
}

function stdoutEvidence(snapshot: DeploymentSetupSnapshot): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  let settled = false;
  let retirement: NodeJS.Immediate | undefined;
  function finish(error: unknown): void {
    if (settled) return;
    settled = true;
    clearImmediate(retirement);
    process.stdout.off('error', onError);
    if (error === undefined) resolve(undefined);
    else reject(error);
  }
  function onError(error: Error): void {
    finish(error);
  }
  process.stdout.on('error', onError);
  try {
    process.stdout.write(JSON.stringify({ deploymentSetup: snapshot }) + '\n', (error) => {
      if (settled) return;
      if (error) {
        // Writable reports callback errors before its error event. Keep ownership
        // through that turn; already-closed streams may emit no second event.
        retirement = setImmediate(() => {
          finish(error);
        });
      } else {
        finish(undefined);
      }
    });
  } catch (error) {
    finish(error);
  }
  return promise;
}

/** Verification-only facts; arbitrary exceptions are never inspected or retained here. */
export function createDeploymentSetupEvidence(
  sink: DeploymentSetupSink = stdoutEvidence,
): DeploymentSetupEvidence {
  const active: DeploymentSetupPhase[] = [];
  const operations: Partial<Record<DeploymentSetupPhase, OperationStatus>> = {};
  const cleanup: Record<CleanupOwner, CleanupOutcome> = {
    deploymentDrain: 'not-required',
    resources: 'not-required',
  };
  let lastCompleted: DeploymentSetupPhase | null = null;
  let firstFailure: SetupFailure | null = null;
  let evidence: DeploymentSetupSnapshot['evidence'] = 'unavailable';
  function begin(phase: DeploymentSetupPhase): DeploymentSetupOperation {
    active.push(phase);
    operations[phase] = 'entered';
    let settled = false;
    function finish(failed: boolean): void {
      if (settled) return;
      settled = true;
      active.pop();
      operations[phase] = failed ? 'failed' : 'completed';
      if (failed)
        firstFailure ??= Object.freeze({ phase, code: 'operation-failed', cause: 'unknown' });
      else lastCompleted = phase;
    }
    return {
      complete() {
        finish(false);
      },
      fail() {
        finish(true);
      },
    };
  }
  function snapshot(): DeploymentSetupSnapshot {
    return Object.freeze({
      current: active.at(-1) ?? firstFailure?.phase ?? null,
      lastCompleted,
      firstFailure,
      operations: Object.freeze({ ...operations }),
      cleanup: Object.freeze({ ...cleanup }),
      evidence,
    });
  }
  return {
    begin,
    async run(phase, operation) {
      const operationScope = begin(phase);
      try {
        const result = await operation();
        operationScope.complete();
        return result;
      } catch (error) {
        operationScope.fail();
        throw error;
      }
    },
    runSync(phase, operation) {
      const operationScope = begin(phase);
      try {
        const result = operation();
        operationScope.complete();
        return result;
      } catch (error) {
        operationScope.fail();
        throw error;
      }
    },
    cleanup(owner, outcome) {
      cleanup[owner] = outcome;
    },
    snapshot,
    async publish() {
      evidence = 'retained';
      try {
        await sink(snapshot());
        return true;
      } catch {
        // The caller retains the safe in-memory facts, never the rejected sink error.
        evidence = 'unavailable';
        return false;
      }
    },
  };
}

/** Keep optional-observer callers on the same operation and rejection path. */
export function deploymentSetupStep<T>(
  setup: DeploymentSetupEvidence | undefined,
  phase: DeploymentSetupPhase,
  operation: () => Promise<T>,
): Promise<T> {
  return setup ? setup.run(phase, operation) : operation();
}
