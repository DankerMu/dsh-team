export interface BrowserExecTarget {
  readonly receiptFile: string;
  readonly containerId: string;
}
export interface BrowserExecAuthority {
  readonly version: 1;
  readonly receiptFile: string;
  readonly pointer: string | null;
  readonly directoryIdentity: Readonly<Record<string, string | number>> | null;
  readonly browser: Readonly<Record<string, unknown>> & { readonly containerId: string };
}
export declare function captureBrowserExecAuthority(
  target: BrowserExecTarget,
): Promise<BrowserExecAuthority>;
export declare function readBrowserExecRetirementReceipt(
  authority: BrowserExecAuthority,
): Promise<Record<string, unknown>>;
