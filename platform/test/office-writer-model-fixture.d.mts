import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';

export declare function runOfficeWriterScenario(input: {
  page: CdpPage;
  rpc: (method: string, args: unknown) => Promise<Record<string, unknown>>;
  exec: (script: string) => string;
  evidence: string;
}): Promise<void>;
