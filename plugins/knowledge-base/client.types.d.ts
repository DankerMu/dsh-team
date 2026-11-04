/** Structural subset of the released 0.2.1-rc.2 Client contracts and the React runtime seed. */
export interface KbEntry {
  readonly id: string;
  readonly name: string;
}

/** A route answer as the panel uses it; every failure value collapses into `failed`. */
export type KbAnswer =
  | {
      readonly result: 'ok';
      readonly datasets?: KbEntry[];
      readonly total?: number;
      readonly documents?: KbEntry[];
    }
  | { readonly result: 'not-configured' | 'failed' };

/** What an expanded library shows for one page and filter. */
export interface KbFilesView {
  readonly state: 'loading' | 'not-configured' | 'failed' | 'empty' | 'no-match' | 'list';
  readonly page: number;
  readonly keywords: string | undefined;
  readonly total?: number;
  readonly documents?: KbEntry[];
}

export interface KbReact {
  createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useState<T>(initial: T): [T, (next: T) => void];
  useEffect(effect: () => unknown, deps: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  useCallback<T>(callback: T, deps: readonly unknown[]): T;
}

interface KbSlots {
  inject(name: 'main' | 'sidebar.panellist', install: () => () => void): void;
  register(entry: Record<string, unknown>, component: (props: never) => unknown): () => void;
}

/** Public classic-script loader; React is supplied by the DSH runtime seed. */
declare global {
  const window: {
    __ModuleLoader__: {
      load(registration: {
        id: string;
        factory: (require: (id: 'react') => KbReact) => {
          inject: string[];
          apply(ctx: { slots: KbSlots }): void;
        };
      }): void;
    };
  };
}
