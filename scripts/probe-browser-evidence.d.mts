export type RequestEvidenceRow = {
  readonly event: string;
  readonly requestTag: string | null;
  readonly hop: number | null;
  readonly path: string;
  readonly method: string | null;
  readonly resourceType: string | null;
  readonly status: number | null;
  readonly relativeMs: number | null;
  readonly observedMs: number;
  readonly error: string | null;
  readonly canceled: boolean | null;
  readonly redirectFrom?: {
    readonly hop: number | null;
    readonly path: string;
    readonly status: number | null;
  };
};
export type RequestFailureEvidence = {
  readonly version: 1;
  readonly clock: string;
  readonly endedMs: number | null;
  readonly limits: { readonly rows: number; readonly requests: number; readonly bytes: number };
  readonly rows: readonly RequestEvidenceRow[];
  readonly loss: {
    readonly droppedRows: number;
    readonly correlationEvictions: number;
    readonly unmatchedEvents: number;
    readonly invalidEvents: number;
    readonly collectorFailures: number;
  };
  readonly complete: boolean;
};
export type RequestEvidenceCollector = { snapshot(): RequestFailureEvidence; dispose(): void };
export declare const REQUEST_EVIDENCE_LIMITS: Readonly<{
  rows: number;
  requests: number;
  bytes: number;
}>;
export declare function collectRequestEvidence(page: unknown): RequestEvidenceCollector;
export declare function retainRequestFailure(
  collector: RequestEvidenceCollector | undefined,
  screenshot: string,
): Promise<boolean>;
export declare function retainPageRequestFailure(
  page: unknown,
  screenshot: string,
): Promise<boolean>;
export declare function disposeRequestEvidence(page: unknown): void;
