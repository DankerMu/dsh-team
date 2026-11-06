/** The managed overlay row's config when the instance has a platform address (network mode). */
export interface KnowledgeBaseConfig {
  /** `http://<instance bridge +3 IPv4>:<platform port>`, without a path. */
  readonly platformUrl: string;
}

interface KnowledgeBaseEntry {
  readonly id: string;
  readonly name: string;
}

/** The closed set both browser routes answer with HTTP 200. */
export type KnowledgeBaseAnswer =
  | { readonly result: 'ok'; readonly datasets: readonly KnowledgeBaseEntry[] }
  | {
      readonly result: 'ok';
      readonly total: number;
      readonly documents: readonly KnowledgeBaseEntry[];
    }
  | {
      readonly result:
        'not-configured' | 'unavailable' | 'timeout' | 'upstream-error' | 'invalid-request';
    };

interface KnowledgeBaseLogger {
  warn(format: string, ...args: unknown[]): void;
}

/** One platform proxy read; `limit` bounds the answer body in bytes. */
export interface PlatformRequest {
  readonly url: string;
  readonly token: string;
  readonly kind: 'datasets' | 'documents';
  readonly limit: number;
  readonly signal: AbortSignal;
  readonly logger: KnowledgeBaseLogger;
}

/** Structural subset of the released 0.2.1-rc.2 host webserver injection contract. */
interface IndexInjectionRow {
  kind: string;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** Structural subset of the released 0.2.1-rc.2 Connection exact Fetch route contract. */
interface FetchRoute {
  readonly path: string;
  readonly methods: readonly 'GET'[];
  readonly requestBody: 'buffered';
  readonly fetch: (request: Request) => Promise<Response>;
}

/** null: every library, later ones included; otherwise 0..1000 distinct dataset IDs. */
export type ScopeSelection = readonly string[] | null;

/** The `kbScope` fold state; plain JSON so the projection cache can persist it. */
export interface ScopeState {
  readonly child: boolean;
  readonly selection: ScopeSelection;
  readonly running: { readonly commandId: string; readonly selection: ScopeSelection } | null;
  readonly turn: { readonly turn: number; readonly scope: ScopeSelection } | null;
}

/** The `kbScope` wire view the client and the local lane read. */
export interface ScopeView {
  readonly child: boolean;
  readonly selection: ScopeSelection;
  readonly turn: ScopeState['turn'];
}

/**
 * Structural subset of the released 0.2.1-rc.2 Session event the fold reads: `command/run`
 * (`commandId`, `name`, `args?`), `command/done` (`commandId`, `kind`) and `turn/start` (`turn`).
 */
interface ScopeEvent {
  readonly type: string;
  readonly data: {
    readonly commandId?: string;
    readonly name?: string;
    readonly args?: string;
    readonly kind?: string;
    readonly turn?: number;
  };
}

/** Structural subset of the released 0.2.1-rc.2 SessionProjectionDefinition. */
export interface ScopeProjection {
  readonly key: 'kbScope';
  readonly stateVersion: 1;
  readonly stateSchema: { parse(value: unknown): ScopeState };
  init(header: { readonly origin?: string }): ScopeState;
  apply(state: ScopeState, event: ScopeEvent): ScopeState;
  readonly wire: {
    readonly viewSchema: { parse(value: unknown): ScopeView };
    view(state: ScopeState): ScopeView;
  };
}

interface CommandResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** Structural subset of the released 0.2.1-rc.2 CommandDefinition. */
export interface ScopeCommand {
  readonly definitionId: string;
  readonly name: 'kb-scope';
  readonly description: string;
  readonly input: { readonly hint: string };
  handler(invocation: { readonly rawInput: string }): CommandResult;
}

interface ScopedServices {
  sessionProjections: { register(definition: ScopeProjection): unknown };
  commands: { register(definition: ScopeCommand): unknown };
}

export interface KnowledgeBaseHostContext {
  on(event: 'webserver/index-inject', callback: (table: IndexInjectionRow[]) => void): unknown;
  effect(callback: () => () => Promise<void>): unknown;
  inject(
    deps: ['sessionProjections', 'commands'],
    callback: (ctx: ScopedServices) => void,
  ): unknown;
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } };
  logger: KnowledgeBaseLogger;
}
