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

/** Structural subset of the browser DOM the plugin page lock decoration uses. */
interface PlatformNavNode {
  readonly nodeType: number;
}

interface PlatformNavElement extends PlatformNavNode {
  readonly parentElement: PlatformNavElement | null;
  readonly children: Iterable<PlatformNavElement>;
  textContent: string | null;
  readonly style: { cssText: string };
  matches(selector: string): boolean;
  closest(selector: string): PlatformNavElement | null;
  querySelector(selector: string): PlatformNavElement | null;
  querySelectorAll(selector: string): Iterable<PlatformNavElement>;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  append(node: PlatformNavElement): void;
  after(node: PlatformNavElement): void;
}

declare const document: {
  readonly head: PlatformNavElement;
  readonly body: PlatformNavElement;
  createElement(tag: 'span' | 'style'): PlatformNavElement;
};

declare const MutationObserver: new (
  callback: (records: Iterable<{ readonly addedNodes: Iterable<PlatformNavNode> }>) => void,
) => {
  observe(target: PlatformNavElement, options: { childList: true; subtree: true }): void;
};
