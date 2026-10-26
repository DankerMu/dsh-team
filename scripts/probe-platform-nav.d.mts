/** Structural types for the sidebar platform-navigation evidence helper. */
import type { MappedHostAcceptResult } from './probe-mapped-host.mjs';

export type PlatformNavPage = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export declare function verifyPlatformNav(input: {
  readonly page: PlatformNavPage;
  readonly admin: boolean;
  readonly errors: readonly unknown[];
  readonly screenshot: string;
  readonly ms: number;
}): Promise<NonNullable<MappedHostAcceptResult['platformNav']>>;
