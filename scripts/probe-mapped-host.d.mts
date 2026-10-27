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
  /** Composition only: prove the sidebar platform links for this role, then follow one. */
  readonly platformNav?: 'employee' | 'admin';
  /** Composition only: prove the plugin page has no install entries; switch office-agents off and on. */
  readonly pluginPage?: boolean;
};

/** The office-agents bundle switch as read back from the card list after a reload. */
export type MappedHostPluginSwitch = {
  readonly checked: boolean;
  readonly status: string;
};

export type MappedHostPlatformLink = {
  readonly href: string;
  readonly text: string;
  readonly label: string | null;
  readonly target: string | null;
  readonly visible: boolean;
  /** Horizontally inside the footer cell, allowing the released 2px Cordis bleed. */
  readonly contained: boolean;
  /** The wide label span is not truncated (always true for compact rail links). */
  readonly labelFits: boolean;
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
  readonly pluginPage?: {
    readonly list: {
      readonly refresh: boolean;
      readonly addButtons: number;
      readonly group: string;
      readonly status: string;
      readonly checked: boolean;
    };
    readonly detail: {
      readonly uninstallButtons: number;
      readonly checked: boolean;
      readonly disabled: boolean;
      readonly title: string | null;
    };
    readonly off: MappedHostPluginSwitch;
    readonly on: MappedHostPluginSwitch;
    readonly screenshots: readonly { readonly screenshot: string; readonly bytes: number }[];
  };
  readonly platformNav?: {
    readonly wide: readonly MappedHostPlatformLink[];
    readonly rail: readonly MappedHostPlatformLink[];
    /** Cordis badge state shared by both modes: absent without Cordis plugin activity. */
    readonly cordis: 'absent' | 'stacked';
    readonly destination: {
      readonly path: string;
      readonly search: string;
      readonly heading: string;
      /** Administrator console only: its link back to the DSH workbench. */
      readonly workbench?: {
        readonly href: string;
        readonly text: string;
        readonly visible: boolean;
      };
    };
    readonly screenshots: readonly { readonly screenshot: string; readonly bytes: number }[];
  };
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
    | 'composition'
    | 'expectedRoster'
    | 'preserveModels'
    | 'observeSessions'
    | 'platformNav'
    | 'pluginPage'
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
