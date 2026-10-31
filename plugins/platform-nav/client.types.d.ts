/** Structural subset of the released 0.2.1-rc.2 Client contracts. */
interface PlatformNavProps {
  /** Owner prop of `sidebar.footer.action`: false is the collapsed 56px rail. */
  wide: boolean;
}

interface PlatformNavReact {
  createElement(
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}

interface PlatformNavContext {
  slots: {
    inject(name: 'sidebar.footer.action', install: () => () => void): void;
    register(
      entry: { name: 'sidebar.footer.action'; id: string; order: number },
      component: (props: PlatformNavProps) => unknown,
    ): () => void;
  };
}

/** Public classic-script loader; React is supplied by the DSH runtime seed. */
declare const window: {
  __ModuleLoader__: {
    load(registration: {
      id: string;
      factory: (require: (id: 'react') => PlatformNavReact) => {
        inject: string[];
        apply(ctx: PlatformNavContext): void;
      };
    }): void;
  };
};
