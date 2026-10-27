/** Structural types for the sidebar plugin-page evidence helper. */
import type { MappedHostAcceptResult } from './probe-mapped-host.mjs';

export type PluginPagePage = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export declare function verifyPluginPage(input: {
  readonly page: PluginPagePage;
  readonly errors: readonly unknown[];
  readonly screenshot: string;
  readonly ms: number;
  /** Re-navigate the same page and wait until the app is ready again. */
  readonly reload: () => Promise<void>;
}): Promise<NonNullable<MappedHostAcceptResult['pluginPage']>>;
