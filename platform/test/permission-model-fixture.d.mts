import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';
import type { ModelObserver } from './model-observer-fixture.ts';

export declare function runPermissionModelScenario(input: {
  page: CdpPage;
  origin: string;
  cookie: string;
  evidence: string;
  observe: (path: string, contents: string) => Promise<Record<string, unknown>>;
  model: string;
  reviewObserver: ModelObserver;
}): Promise<void>;
