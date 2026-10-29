import type { UserImageLifecycle } from './user-image-fixture.ts';
import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';

interface PermissionBrowserScenario {
  readonly scope: 'root' | 'delegate';
  readonly action: 'reject' | 'allow' | 'cancel';
  /** Continuable only: evidence label, root tier selected first, and expected effects. */
  readonly name?: string;
  readonly tier?: '人工批准' | 'Auto' | 'Yolo';
  readonly unattended?: boolean;
  /** Expected child identity at agent/created; omitted means manual approval/ask. */
  readonly child?: { readonly tier: string; readonly policy: string };
  readonly reviews?: number;
  readonly resume?: boolean;
}

/** One owned browser oracle: delegation mode, protocol prefix and scenario list. */
export interface PermissionBrowserSuite {
  readonly mode: 'one-shot' | 'continuable';
  /** Owned provider scope, e.g. `issue83-ui`; titles use `title`. */
  readonly prompt: string;
  readonly title: string;
  /** Managed overlay user id: 12 lowercase ASCII letters or digits. */
  readonly overlay: string;
  readonly chrome: string;
  readonly scenarios: readonly PermissionBrowserScenario[];
  readonly limits: readonly string[];
}

/** Real browser assertions using the invocation-owned Docker lifecycle. */
export declare function runPermissionBrowserScenario(
  lifecycle: UserImageLifecycle,
  options: {
    readonly runtime: BrowserRuntime;
    readonly evidenceDirectory: string;
    readonly suite: PermissionBrowserSuite;
  },
): Promise<string>;
