/** Structural types for the import-safe mapped-host helper. */
import type { BrowserRuntime } from './probe-browser-runtime.mjs';
import type { CdpPage, ChromeHandle, WelcomeObserver } from './probe-dsh-api-cdp.mjs';
export type MappedHostWorkspace = {
  readonly available: boolean;
  readonly workBound: boolean;
};

export type MappedPageHandle = {
  chrome: ChromeHandle;
  page: CdpPage;
  errors: unknown[];
  requests: unknown[];
  welcome: WelcomeObserver | null;
};

export type MappedHostAcceptInput = {
  readonly origin: string;
  readonly cookie: string;
  readonly extraFlags: readonly string[];
  readonly screenshot: string;
  readonly browserMs: number;
  readonly composition?: boolean;
  readonly runtime: BrowserRuntime;
  readonly profile: string;
  readonly receiptFile: string;
  readonly workspace?: MappedHostWorkspace;
  readonly expectedHost?: string;
  readonly expectedRoster?: readonly string[];
  readonly preserveModels?: string;
  readonly expectedDefault?: string;
  readonly preserveSessionId?: string;
  readonly observeSessions?: boolean;
};

export type MappedHostSessionObservation = {
  readonly sessionsAvailable: boolean;
  readonly items: readonly { readonly sessionId: string; readonly cwd: string }[];
  readonly cookieNames: readonly string[];
  readonly creationRequests: number;
  readonly createdSessionIds: readonly string[];
  readonly failedCreations: number;
  readonly pendingCreations: number;
  readonly workspaceRequests: number;
  readonly promptRequests: number;
};

export type MappedHostAcceptResult = {
  readonly sessionAddressObserved?: boolean;
  readonly accepted: boolean;
  readonly beforeSessionObservation?: MappedHostSessionObservation;
  readonly sessionObservation?: MappedHostSessionObservation;
  readonly initialized?: boolean;
  readonly screenshot?: { readonly screenshot?: string };
  readonly reload?: MappedHostAcceptResult;
  readonly preservation?: {
    readonly sessionId?: string;
    readonly general?: boolean;
    readonly listed?: readonly string[];
    readonly selected?: readonly string[];
    readonly defaultModel?: string;
    readonly exactModels?: readonly string[];
    readonly screenshot?: { readonly screenshot?: string };
  };
  readonly bootRoster?: { readonly ids?: readonly string[] };
  readonly consoleErrors?: readonly unknown[];
  readonly ui?: Record<string, unknown>;
  readonly host?: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
  readonly workBound?: boolean;
  readonly workBoundUnknown?: boolean;
  readonly readiness?: string;
};

export declare function mappedFlags(host: string): string[];

export declare function exchangeLaunchToken(input: {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly cookieHost?: string;
}): Promise<string>;

export declare function mappedRpc(
  origin: string,
  cookie: string,
  method: string,
  payload: unknown,
): Promise<unknown>;

export declare function acceptObservation(
  input: MappedHostAcceptInput,
): Promise<MappedHostAcceptResult>;

export declare function collectObservation(
  input: Omit<
    MappedHostAcceptInput,
    'composition' | 'expectedRoster' | 'preserveModels' | 'observeSessions'
  >,
): Promise<MappedHostAcceptResult>;

export declare function closeMapped(
  page: unknown,
  chrome: { stop?: () => Promise<void> } | undefined,
  welcome?: { cleanup?: () => Promise<void> } | null | undefined,
  failure?: { readonly error: unknown },
): Promise<void>;

export declare function navigateReady(
  page: unknown,
  origin: string,
  ms: number,
  reload?: boolean,
): Promise<void>;

export declare function openMappedPage(input: {
  readonly origin: string;
  readonly cookie: string;
  readonly extraFlags: readonly string[];
  readonly composition?: boolean;
  readonly runtime: BrowserRuntime;
  readonly profile: string;
  readonly receiptFile: string;
}): Promise<MappedPageHandle>;
