import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';
import type { AutoReviewObserver } from './permission-model-observer-fixture.ts';

export declare function runPermissionModelScenario(input: {
  page: CdpPage;
  origin: string;
  cookie: string;
  evidence: string;
  observe: (path: string, contents: string) => Record<string, unknown>;
  model: string;
  prepareAuto: () => Promise<AutoReviewObserver>;
}): Promise<void>;
