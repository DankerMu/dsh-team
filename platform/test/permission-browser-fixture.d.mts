import type { UserImageLifecycle } from './user-image-fixture.ts';

/** Real browser assertions using the invocation-owned Docker lifecycle. */
export declare function runPermissionBrowserScenario(
  lifecycle: UserImageLifecycle,
  options: { readonly chromeBin: string; readonly evidenceDirectory: string },
): Promise<string>;
