export type BrowserRuntime =
  | { readonly kind: 'native'; readonly bin: string }
  | {
      readonly kind: 'docker-network-none';
      readonly imageId: string;
      readonly chromeDirectory: string;
      readonly chromeSha256: string;
      readonly runId: string;
    };
export type ChromeLaunchInput = {
  readonly runtime: BrowserRuntime;
  readonly origin: string;
  readonly profile: string;
  readonly receiptFile: string;
  readonly extraFlags?: readonly string[];
};
export type IsolatedBrowserReceipt = {
  readonly version: 1;
  readonly nonce: string;
  readonly kind: 'docker-network-none';
  readonly state: string;
  readonly profile: string;
  readonly socketDirectory: string;
  readonly containerName: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly runId: string;
  readonly debugPort: number;
  readonly chromeSha256: string;
  readonly privateUid: number;
  readonly privateNodeVersion: string;
};
export declare function isolatedBrowserRuntime(
  runId?: string,
): Extract<BrowserRuntime, { kind: 'docker-network-none' }>;
export declare function rescueChrome(receiptFile: string, expectedNonce?: string): Promise<void>;
export declare function processBirth(pid: number): Promise<string>;
export declare function browserDocker(args: readonly string[], ms?: number): string;
export declare function chromeDigest(path: string): Promise<string>;
export declare function readReceipt(path: string): Promise<Record<string, unknown>>;
export declare function writeReceipt(
  path: string,
  receipt: Readonly<Record<string, unknown>>,
): Promise<void>;
export declare function registerChrome(input: ChromeLaunchInput): Promise<Record<string, unknown>>;
export declare function startIsolated(
  input: ChromeLaunchInput,
  receipt: Record<string, unknown>,
): Promise<{ debugPort: number; stop(): Promise<void> }>;
export declare function chromeFlags(
  profile: string,
  debugPort: number,
  extraFlags?: readonly string[],
): string[];
