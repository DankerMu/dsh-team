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

export interface KnowledgeBaseHostContext {
  on(event: 'webserver/index-inject', callback: (table: IndexInjectionRow[]) => void): unknown;
  effect(callback: () => () => Promise<void>): unknown;
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } };
  logger: KnowledgeBaseLogger;
}
