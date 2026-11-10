/** Structural subset of the released dsh-better-sidebar 0.28.0 file viewer contract. */
interface FileViewerProps {
  readonly scope?: { readonly sessionId?: string };
  readonly path: string;
  readonly [key: string]: unknown;
}

export interface FileViewerDescriptor {
  readonly id: string;
  readonly title?: string | (() => string);
  readonly exts: readonly string[];
  readonly priority?: number;
  readonly fetchStrategy: string;
  readonly component: (props: FileViewerProps) => unknown;
}

/** The `ctx.betterSidebar` members this plugin uses (src/client/service.ts:618-727). */
interface BetterSidebarService {
  registerFileViewer(descriptor: FileViewerDescriptor): () => void;
  getFileViewers(): readonly FileViewerDescriptor[];
  isViewerEnabled(id: string): boolean;
  subscribe(listener: () => void): () => void;
  subscribeState(listener: () => void): () => void;
}

interface OfficeHintsReact {
  createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}

interface OfficeHintsContext {
  readonly betterSidebar: BetterSidebarService;
  /** Cordis effect: runs `execute` now and its returned disposer when the plugin unloads. */
  effect(execute: () => () => void, name?: string): void;
}

/** Public classic-script loader; React is supplied by the DSH runtime seed. */
declare global {
  const window: {
    __ModuleLoader__: {
      load(registration: {
        id: string;
        factory: (require: (id: 'react') => OfficeHintsReact) => {
          inject: string[];
          apply(ctx: OfficeHintsContext): void;
        };
      }): void;
    };
  };
}
