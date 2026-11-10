// @ts-check
/**
 * Classic-script client half of the Office hints plugin. While an ONLYOFFICE viewer
 * (`onlyoffice:<ext>`) is registered and enabled in better-sidebar, a higher-priority wrapper
 * viewer `office-hints:<ext>` shows the collaboration hint above the ONLYOFFICE editor, or only
 * the Session hint when the tab has no Session. Otherwise nothing is registered and the file
 * goes wherever it went without this plugin.
 */
(() => {
  const EXTS = ['docx', 'xlsx', 'pptx'];
  const HINT = 'data-dsh-team-office-hint';
  const FRAME = 'data-dsh-team-office-hints';
  // Baseline F40, verbatim.
  const COLLAB = '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。';
  const NO_SESSION = '请先新建或进入一个会话（Session），再打开 Office 文件。';
  const UNAVAILABLE = 'Office 编辑器未加载，请关闭后重新打开此文件。';
  const NOTICE = {
    padding: '6px 12px',
    fontSize: '12px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary)',
    borderBottom: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.25))',
    flex: 'none',
  };

  window.__ModuleLoader__.load({
    id: '@dsh-team/office-hints',
    factory: (requireClient) => {
      const React = requireClient('react');
      const h = React.createElement;

      return {
        inject: ['betterSidebar'],
        apply(ctx) {
          const sidebar = ctx.betterSidebar;
          /** @type {Map<string, () => void>} the wrappers this apply registered, by extension */
          const disposers = new Map();
          let running = false;
          let dirty = false;

          /**
           * The registered and enabled ONLYOFFICE viewer for `ext`, read at call time.
           * @param {string} ext
           */
          function editor(ext) {
            const id = `onlyoffice:${ext}`;
            const viewer = sidebar.getFileViewers().find((each) => each.id === id);
            return viewer !== undefined && sidebar.isViewerEnabled(id) ? viewer : undefined;
          }

          /**
           * No hooks: better-sidebar both mounts a viewer as an element and calls it directly.
           * ONLYOFFICE is rendered as its own element, so its hooks never join this function.
           * @param {string} ext
           * @returns {import('./client.types.js').FileViewerDescriptor['component']}
           */
          const wrapper = (ext) => (props) => {
            /** @param {...unknown} children */
            const frame = (...children) =>
              h(
                'div',
                {
                  [FRAME]: ext,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    height: '100%',
                    minHeight: 0,
                  },
                },
                ...children,
              );
            const sessionId = props.scope?.sessionId;
            if (typeof sessionId !== 'string' || sessionId === '') {
              return frame(h('div', { [HINT]: 'no-session', style: NOTICE }, NO_SESSION));
            }
            const viewer = editor(ext);
            if (viewer === undefined) return frame(h('div', { style: NOTICE }, UNAVAILABLE));
            return frame(
              h('div', { [HINT]: 'collab', role: 'note', style: NOTICE }, COLLAB),
              h('div', { style: { flex: '1 1 0', minHeight: 0 } }, h(viewer.component, props)),
            );
          };

          function reconcile() {
            const ids = new Set(sidebar.getFileViewers().map((viewer) => viewer.id));
            for (const ext of EXTS) {
              const id = `office-hints:${ext}`;
              const wanted = editor(ext) !== undefined;
              if (wanted && !ids.has(id)) {
                disposers.set(
                  ext,
                  sidebar.registerFileViewer({
                    id,
                    title: `Office 提示（${ext}）`,
                    exts: [ext],
                    priority: 20,
                    fetchStrategy: 'none',
                    component: wrapper(ext),
                  }),
                );
              }
              const dispose = disposers.get(ext);
              if (!wanted && dispose !== undefined) {
                disposers.delete(ext);
                dispose();
              }
            }
          }

          /**
           * Registration and disposal notify synchronously, so this re-enters itself; a nested
           * call only marks the outer one dirty, which reconciles again until nothing changed.
           */
          function sync() {
            if (running) {
              dirty = true;
              return;
            }
            running = true;
            try {
              do {
                dirty = false;
                reconcile();
              } while (dirty);
            } finally {
              running = false;
            }
          }

          function listener() {
            try {
              sync();
            } catch {
              // Swallowed: listeners run inside better-sidebar's uncaught notify loop, often
              // within ONLYOFFICE's own registration, which a throw would abort. The next
              // registry or preference notification reconciles again.
            }
          }

          ctx.effect(() => {
            const unsubscribe = sidebar.subscribe(listener);
            const unsubscribeState = sidebar.subscribeState(listener);
            listener();
            return () => {
              unsubscribe();
              unsubscribeState();
              for (const [ext, dispose] of [...disposers]) {
                disposers.delete(ext);
                dispose();
              }
            };
          }, 'office-hints: viewers');
        },
      };
    },
  });
})();
