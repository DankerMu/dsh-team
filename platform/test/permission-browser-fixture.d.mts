import type { UserImageLifecycle } from './user-image-fixture.ts';
import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';

/** Real browser assertions using the invocation-owned Docker lifecycle. */
export declare function runPermissionBrowserScenario(
  lifecycle: UserImageLifecycle,
  options: { readonly runtime: BrowserRuntime; readonly evidenceDirectory: string },
): Promise<string>;
