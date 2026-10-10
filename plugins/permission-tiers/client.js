// @ts-check
/** Repo-owned panel over the native pending approval, not the shipped ApprovalPanel. */
window.__ModuleLoader__.load({
  id: '@dsh-team/permission-tiers',
  factory: (requireClient) => {
    const React = requireClient('react');
    const h = React.createElement;

    /** @param {ChildComposerOwner} owner */
    function selectChildApproval(owner) {
      const pending = owner.pendingInteraction;
      if (
        owner.session?.subagent?.address?.mode !== 'one-shot' ||
        typeof owner.sessionId !== 'string' ||
        owner.sessionId.length === 0 ||
        pending?.kind !== 'approval' ||
        pending.sessionId !== owner.sessionId ||
        typeof pending.key !== 'string' ||
        pending.key.length === 0 ||
        typeof pending.answer !== 'function' ||
        pending.answerable !== true
      ) {
        return null;
      }
      return pending;
    }

    /** @param {{ pending: ChildPendingApproval }} props */
    function ChildApprovalFlow({ pending }) {
      const [answered, setAnswered] = React.useState(false);
      const waiting = React.useRef(false);
      const active = React.useRef(true);
      React.useEffect(() => {
        active.current = true;
        return () => {
          active.current = false;
        };
      }, []);

      /** @param {'rejected' | 'allowed-once'} outcome */
      function answer(outcome) {
        if (!active.current || waiting.current || !pending.answerable) return;
        waiting.current = true;
        setAnswered(true);
        // Native settlement rejects on failure; never expose its raw error to the UI/console.
        pending.answer(outcome).catch(() => {
          if (!active.current || !pending.answerable) return;
          waiting.current = false;
          setAnswered(false);
        });
      }

      const reason =
        pending.displayReason?.zh ??
        pending.reason ??
        `工具 ${pending.toolName} 请求执行，需要人工批准`;
      const disabled = answered || !pending.answerable;
      return h(
        'section',
        {
          'data-approval-key': pending.key,
          'aria-label': '子任务审批',
          'aria-busy': answered,
          style: {
            padding: '16px',
            margin: '8px 16px',
            border: '1px solid var(--dsw-alias-state-warn-secondary)',
            borderRadius: '12px',
            background: 'var(--dsw-specific-input-major)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('div', { role: 'status' }, answered ? '正在提交审批决定' : '等待审批'),
        h('div', { role: 'group', 'aria-label': '审批详情', style: { margin: '12px 0' } }, reason),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          h('button', { type: 'button', disabled, onClick: () => answer('rejected') }, '拒绝'),
          h(
            'button',
            { type: 'button', disabled, onClick: () => answer('allowed-once') },
            '允许一次',
          ),
        ),
      );
    }

    /** @param {ChildApprovalProps} props */
    function ChildApprovalPanel({ matched }) {
      // The opaque native key is the remount axis; old failures cannot revive a new request.
      return h(ChildApprovalFlow, { key: matched.key, pending: matched });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Composer chains elect ascending priority; this narrowly precedes native readonly -10.
        ctx.slots.inject('conversation.composer', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer',
              priority: -20,
              select: selectChildApproval,
            },
            ChildApprovalPanel,
          ),
        );
      },
    };
  },
});
