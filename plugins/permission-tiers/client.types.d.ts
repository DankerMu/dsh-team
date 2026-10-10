/** Structural subset of the released 0.2.0-rc.2 Client contracts. */
interface ChildPendingApproval {
  readonly kind: 'approval';
  readonly sessionId: string;
  readonly key: string;
  readonly toolName: string;
  readonly reason?: string | undefined;
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string } | undefined;
  readonly answerable: boolean;
  answer(outcome: 'rejected' | 'allowed-once'): Promise<void>;
}

interface ChildComposerOwner {
  sessionId: string;
  session?: { subagent?: { address?: { mode?: string } } | null };
  pendingInteraction?: ChildPendingApproval | null;
}

interface ChildApprovalProps {
  matched: ChildPendingApproval;
}

interface ChildApprovalReact {
  createElement(
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  createElement<Props>(type: (props: Props) => unknown, props: Props & { key?: string }): unknown;
  useState<Value>(initial: Value): [Value, (value: Value) => void];
  useRef<Value>(initial: Value): { current: Value };
  useEffect(effect: () => () => void, dependencies: readonly unknown[]): void;
}

interface ChildApprovalContext {
  slots: {
    inject(name: 'conversation.composer', install: () => () => void): void;
    register(
      entry: {
        name: 'conversation.composer';
        priority: number;
        select(owner: ChildComposerOwner): ChildPendingApproval | null;
      },
      component: (props: ChildApprovalProps) => unknown,
    ): () => void;
  };
}

/** Public classic-script loader; React is supplied by the DSH runtime seed. */
declare const window: {
  __ModuleLoader__: {
    load(registration: {
      id: string;
      factory: (require: (id: 'react') => ChildApprovalReact) => {
        inject: string[];
        apply(ctx: ChildApprovalContext): void;
      };
    }): void;
  };
};
