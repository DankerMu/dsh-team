/** Structural types for the import-safe mapped-host helper. */
export type MappedHostWorkspace = {
  readonly available: boolean;
  readonly workBound: boolean;
};

export type MappedHostAcceptInput = {
  readonly origin: string;
  readonly cookie: string;
  readonly extraFlags: readonly string[];
  readonly screenshot: string;
  readonly browserMs: number;
  readonly composition?: boolean;
  readonly chromeBin: string;
  readonly profile: string;
  readonly pidFile: string;
  readonly workspace?: MappedHostWorkspace;
  readonly expectedHost?: string;
  readonly expectedRoster?: readonly string[];
  readonly preserveModels?: string;
  readonly expectedDefault?: string;
};

export type MappedHostAcceptResult = {
  readonly accepted: boolean;
  readonly initialized?: boolean;
  readonly screenshot?: { readonly screenshot?: string };
  readonly reload?: MappedHostAcceptResult;
  readonly preservation?: {
    readonly general?: boolean;
    readonly listed?: readonly string[];
    readonly selected?: readonly string[];
    readonly defaultModel?: string;
    readonly exactModels?: readonly string[];
    readonly screenshot?: { readonly screenshot?: string };
  };
  readonly [key: string]: unknown;
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
  input: Omit<MappedHostAcceptInput, 'composition' | 'expectedRoster' | 'preserveModels'>,
): Promise<MappedHostAcceptResult>;

export declare function closeMapped(
  page: unknown,
  chrome: { stop?: () => Promise<void> } | undefined,
  welcome?: { cleanup?: () => Promise<void> } | undefined,
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
  readonly chromeBin: string;
  readonly profile: string;
  readonly pidFile: string;
}): Promise<{
  chrome: { stop: () => Promise<void> };
  page: unknown;
  errors: unknown[];
  requests: unknown[];
  welcome: unknown;
}>;
