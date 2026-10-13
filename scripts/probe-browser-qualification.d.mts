export interface QualificationFailure extends Error {
  code: string;
  qualificationPhase?: string;
  qualificationInvariants: readonly string[];
  qualificationOutcome?: string;
}
export interface QualificationErrorNode {
  readonly id?: number;
  readonly kind?: string;
  readonly code?: string;
  readonly phase?: string;
  readonly invariants?: readonly string[];
  readonly processOutcome?: string;
  readonly children?: readonly QualificationErrorNode[];
  readonly cause?: QualificationErrorNode;
  readonly reference?: number;
  readonly truncated?: true;
}
export interface QualificationErrorProjection {
  readonly root: QualificationErrorNode;
  readonly nodes: number;
  readonly dropped: number;
}
export interface QualificationFailureReport {
  readonly version: 1;
  readonly nonce: string;
  readonly state: 'failed';
  readonly phases: readonly string[];
  readonly droppedPhases: number;
  readonly primary: QualificationErrorProjection | null;
  readonly failureDomain: 'qualification' | 'cleanup' | null;
  readonly cleanup: readonly QualificationErrorProjection[];
  readonly droppedCleanup: number;
  readonly error: QualificationErrorProjection;
}
export interface QualificationDiagnostic {
  enter(phase: string): void;
  fail(error: unknown): void;
  cleanup(error: unknown, phase: string): void;
  snapshot(error: unknown): QualificationFailureReport;
}
export declare function qualificationError(
  code: string,
  phase: string,
  invariants?: readonly string[],
): QualificationFailure;
export declare function qualificationDiagnostic(nonce: string): QualificationDiagnostic;
