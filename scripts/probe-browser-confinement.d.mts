import type { IsolatedBrowserReceipt } from './probe-browser-runtime.mjs';

export interface BrowserConfinementProof {
  readonly namespaceDistinct: true;
  readonly noIPv4DefaultRoute: true;
  readonly privateIPv4Present: true;
  readonly onlyLoopbackIPv6: true;
  readonly eth0IPv6Disabled: true;
  readonly hostIPv4Blocked: true;
  readonly linkScopeIPv6Blocked: true;
  readonly hostBridgeNoIPv4: true;
  readonly stableAttachment: true;
  readonly linkLocalHostControlAvailable: boolean;
}
export interface QualificationObservation {
  enter(phase: string): void;
  fail(error: unknown): void;
  cleanup(error: unknown, phase: string): void;
}
export declare function qualifyBrowserConfinement(
  receipt: IsolatedBrowserReceipt,
  diagnostic?: QualificationObservation,
): Promise<BrowserConfinementProof>;
