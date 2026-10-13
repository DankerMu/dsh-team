import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';

export declare function runPermissionModelScenario(input: {
  page: CdpPage;
  origin: string;
  cookie: string;
  evidence: string;
  observe: (path: string, contents: string) => Record<string, unknown>;
}): Promise<void>;
