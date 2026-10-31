/** Structural subset of the released 0.2.1-rc.2 host webserver injection contract. */
interface IndexInjectionRow {
  kind: string;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface PlatformNavHostContext {
  on(event: 'webserver/index-inject', callback: (table: IndexInjectionRow[]) => void): unknown;
}
