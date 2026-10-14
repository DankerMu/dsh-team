import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';
import type { ModelObserver } from './model-observer-fixture.ts';

export declare function runOfficeWriterScenario(input: {
  page: CdpPage;
  rpc: (method: string, args: unknown) => Promise<Record<string, unknown>>;
  exec: (script: string) => Promise<string>;
  evidence: string;
  mode: 'manual' | 'delegated';
  observer?: ModelObserver;
}): Promise<void>;
