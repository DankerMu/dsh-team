// @ts-check
/**
 * Classic-script client half of the knowledge-base plugin: the 「知识库」 panel. As with the
 * released panels (定时任务), its entry is one `sidebar.panellist` row and its content is the
 * `main` page under the same key. It reads only this instance's own `api/knowledge-base.*` routes,
 * whose host half forwards to the platform proxy; browsing touches no Session or scope data.
 */
(() => {
  const ID = 'knowledge-base';
  const GLOBAL = '__DSH_TEAM_KNOWLEDGE_BASE__';
  const STATE = 'data-dsh-team-kb-state';
  const PAGE_SIZE = 20;
  const MAX_KEYWORDS_BYTES = 256;
  const ENTRY_ID = /^[0-9a-f]{32}$/;
  const LIST_TEXT = {
    loading: '正在加载知识库…',
    'not-configured': '知识库未配置，请联系管理员',
    failed: '知识库加载失败',
    empty: '暂无知识库',
    'no-match': '没有名称匹配的知识库',
  };
  const FILES_TEXT = {
    loading: '正在加载文件…',
    'not-configured': '知识库未配置，无法查看文件',
    failed: '文件加载失败',
    empty: '该知识库暂无文件',
    'no-match': '没有名称匹配的文件',
  };
  /** @type {import('./client.types.js').KbAnswer} */
  const FAILED = { result: 'failed' };
  /** Set once by the factory from the DSH runtime seed; components only run after that. */
  /** @type {import('./client.types.js').KbReact} */
  let React = /** @type {any} */ (undefined);
  /** @type {import('./client.types.js').KbReact['createElement']} */
  const h = (type, props, ...children) => React.createElement(type, props, ...children);

  /** Only a literal `available: true` on an object page global, published by the host half. */
  function available() {
    const value = Reflect.get(globalThis, GLOBAL);
    return typeof value === 'object' && value !== null && Reflect.get(value, 'available') === true;
  }

  /**
   * Empty or only whitespace as the proxy (and rc2's TrimSpace) judges it, U+0085 included.
   * @param {string} text
   */
  function isBlank(text) {
    return /^[\s\u0085]*$/u.test(text);
  }

  /**
   * Listed IDs and names, or undefined when any entry is malformed.
   * @param {unknown} value
   * @returns {import('./client.types.js').KbEntry[] | undefined}
   */
  function entries(value) {
    if (!Array.isArray(value)) return undefined;
    const valid = value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        ENTRY_ID.test(entry.id) &&
        typeof entry.name === 'string',
    );
    return valid ? value.map(({ id, name }) => ({ id, name })) : undefined;
  }

  /**
   * The route's answer as the panel uses it; anything but `ok` or `not-configured` is a failure.
   * @param {unknown} body
   * @returns {import('./client.types.js').KbAnswer}
   */
  function answerOf(body) {
    if (typeof body !== 'object' || body === null) return FAILED;
    const { result, datasets, total, documents } = /** @type {Record<string, unknown>} */ (body);
    if (result === 'not-configured') return { result };
    if (result !== 'ok') return FAILED;
    const listed = entries(datasets ?? documents);
    if (listed === undefined) return FAILED;
    if (datasets !== undefined) return { result, datasets: listed };
    const count = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0;
    return count ? { result, total: /** @type {number} */ (total), documents: listed } : FAILED;
  }

  /**
   * One same-origin read whose body is always consumed before the panel changes.
   * @param {string} path
   * @param {AbortSignal} signal
   */
  async function readAnswer(path, signal) {
    const response = await fetch(path, { signal });
    const text = await response.text();
    if (response.status !== 200) return FAILED;
    try {
      return answerOf(JSON.parse(text));
    } catch {
      return FAILED;
    }
  }

  /**
   * One request slot: a new request aborts the previous one, and only the latest answer settles.
   * Unmounting aborts the slot's request and drops its answer.
   */
  function useRequest() {
    const slot = React.useRef({
      sequence: 0,
      controller: /** @type {AbortController | null} */ (null),
    });
    React.useEffect(
      () => () => {
        slot.current.sequence++;
        slot.current.controller?.abort();
      },
      [],
    );
    return React.useCallback(
      /**
       * @param {string} path
       * @param {(answer: import('./client.types.js').KbAnswer) => void} settle
       */
      (path, settle) => {
        const own = slot.current;
        own.controller?.abort();
        const controller = new AbortController();
        own.controller = controller;
        const sequence = ++own.sequence;
        /** @param {import('./client.types.js').KbAnswer} answer */
        const done = (answer) => {
          if (own.sequence !== sequence || controller.signal.aborted) return;
          own.controller = null;
          settle(answer);
        };
        readAnswer(path, controller.signal).then(done, () => {
          done(FAILED);
        });
      },
      [],
    );
  }

  /** Shared look of the panel's plain buttons and fields, on DSH's own colour variables. */
  const CONTROL = {
    boxSizing: 'border-box',
    height: '28px',
    padding: '0 10px',
    border: '1px solid var(--dsw-alias-border-primary, currentColor)',
    borderRadius: 'var(--dsw-radius-md, 6px)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  };

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @param {boolean} [disabled]
   */
  function button(label, onClick, disabled = false) {
    const props = { key: label, type: 'button', onClick, disabled, style: CONTROL };
    return h('button', props, label);
  }

  /**
   * @param {string} text
   * @param {unknown[]} [extra]
   */
  function notice(text, extra = []) {
    const style = { margin: '8px 0', color: 'var(--dsw-alias-label-secondary)' };
    return h('div', { style }, h('p', { style: { margin: '0 0 8px' } }, text), ...extra);
  }

  /** @param {{ size: number; active: boolean }} props */
  function PanelIcon({ size, active }) {
    const paths = [
      'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z',
      'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
      'M9 7.5h6M9 11h4',
    ];
    const props = {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 1.9 : 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: 'false',
    };
    return h('svg', props, ...paths.map((d) => h('path', { key: d, d })));
  }

  /**
   * The displayed state of a documents answer for its page and filter. An empty page past the
   * end of a positive total asks for the last page instead (`fallback`) unless `retried`.
   * @param {import('./client.types.js').KbAnswer} answer
   * @param {number} page
   * @param {string | undefined} keywords
   * @param {boolean} retried
   * @returns {import('./client.types.js').KbFilesView & { fallback?: number }}
   */
  function filesOf(answer, page, keywords, retried) {
    if (answer.result !== 'ok') return { state: answer.result, page, keywords };
    const { total = 0, documents = [] } = answer;
    if (documents.length > 0) return { state: 'list', page, keywords, total, documents };
    const last = Math.ceil(total / PAGE_SIZE);
    if (!retried && last >= 1 && last < page)
      return { state: 'loading', page: last, keywords, fallback: last };
    return { state: keywords === undefined ? 'empty' : 'no-match', page, keywords };
  }

  /**
   * @param {string} datasetId
   * @param {number} page
   * @param {string | undefined} keywords
   */
  function documentsPath(datasetId, page, keywords) {
    const query = `datasetId=${datasetId}&page=${String(page)}&pageSize=${String(PAGE_SIZE)}`;
    const filter = keywords === undefined ? '' : `&keywords=${encodeURIComponent(keywords)}`;
    return `api/knowledge-base.documents?${query}${filter}`;
  }

  /**
   * One page of documents with paging controls.
   * @param {import('./client.types.js').KbFilesView} view
   * @param {(page: number) => void} go
   */
  function filesPage(view, go) {
    const pages = Math.max(1, Math.ceil((view.total ?? 0) / PAGE_SIZE));
    const rows = (view.documents ?? []).map(({ id, name }) =>
      h('li', { key: id, 'data-dsh-team-kb-file': id, style: { padding: '2px 0' } }, name),
    );
    const paging = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' } },
      button('上一页', () => go(view.page - 1), view.page <= 1),
      h('span', null, `第 ${String(view.page)} / ${String(pages)} 页`),
      button('下一页', () => go(view.page + 1), view.page >= pages),
    );
    return [h('ul', { key: 'files', style: { margin: 0, paddingLeft: '18px' } }, ...rows), paging];
  }

  /**
   * The file-name filter; a blank filter clears it and one over the proxy's limit is refused.
   * @param {{ draft: string; tooLong: boolean; setDraft: (value: string) => void; submit: () => void }} filter
   */
  function filterForm({ draft, tooLong, setDraft, submit }) {
    return h(
      'form',
      {
        style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '8px 0' },
        /** @param {{ preventDefault(): void }} event */
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      },
      h('input', {
        'aria-label': '按文件名筛选',
        placeholder: '按文件名筛选',
        value: draft,
        /** @param {{ target: { value: string } }} event */
        onChange: (event) => setDraft(event.target.value),
        style: { ...CONTROL, flex: '1 1 160px' },
      }),
      h('button', { type: 'submit', style: CONTROL }, '筛选'),
      tooLong
        ? h(
            'p',
            { 'data-dsh-team-kb-hint': 'keywords-too-long', style: { width: '100%', margin: 0 } },
            '筛选词过长',
          )
        : null,
    );
  }

  /** @param {{ datasetId: string }} props */
  function DatasetFiles({ datasetId }) {
    const request = useRequest();
    /** @type {[import('./client.types.js').KbFilesView, (view: import('./client.types.js').KbFilesView) => void]} */
    const [view, setView] = React.useState(
      /** @type {import('./client.types.js').KbFilesView} */ ({
        state: 'loading',
        page: 1,
        keywords: undefined,
      }),
    );
    const [draft, setDraft] = React.useState('');
    const [tooLong, setTooLong] = React.useState(false);
    const load = React.useCallback(
      /**
       * @param {number} page
       * @param {string | undefined} keywords
       */
      (page, keywords) => {
        setView({ state: 'loading', page, keywords });
        /** @param {number} target @param {boolean} retried */
        const fetchPage = (target, retried) =>
          request(documentsPath(datasetId, target, keywords), (answer) => {
            const next = filesOf(answer, target, keywords, retried);
            if (next.fallback === undefined) setView(next);
            else fetchPage(next.fallback, true);
          });
        fetchPage(page, false);
      },
      [request, datasetId],
    );
    React.useEffect(() => {
      load(1, undefined);
    }, [load]);
    // A blank draft clears the filter whatever its length; only a real one can be too long.
    const submit = () => {
      const blank = isBlank(draft);
      const refused = !blank && new TextEncoder().encode(draft).byteLength > MAX_KEYWORDS_BYTES;
      setTooLong(refused);
      if (!refused) load(1, blank ? undefined : draft);
    };
    const body =
      view.state === 'list'
        ? filesPage(view, (page) => load(page, view.keywords))
        : [
            notice(
              FILES_TEXT[view.state],
              view.state === 'failed' ? [button('重试', () => load(view.page, view.keywords))] : [],
            ),
          ];
    return h(
      'div',
      {
        'data-dsh-team-kb-files': datasetId,
        [STATE]: view.state,
        style: { padding: '4px 0 12px 16px' },
      },
      view.state === 'not-configured' ? null : filterForm({ draft, tooLong, setDraft, submit }),
      ...body,
    );
  }

  /**
   * The list's displayed state and rows for the current library-name search.
   * @param {import('./client.types.js').KbAnswer | { result: 'loading' }} list
   * @param {string} search
   * @returns {{ state: Exclude<import('./client.types.js').KbFilesView['state'], 'list'> | 'list'; rows: import('./client.types.js').KbEntry[] }}
   */
  function datasetsView(list, search) {
    if (list.result !== 'ok') return { state: list.result, rows: [] };
    const all = list.datasets ?? [];
    if (all.length === 0) return { state: 'empty', rows: [] };
    const needle = search.trim().toLowerCase();
    const rows =
      needle === '' ? all : all.filter(({ name }) => name.toLowerCase().includes(needle));
    return { state: rows.length === 0 ? 'no-match' : 'list', rows };
  }

  /**
   * @param {import('./client.types.js').KbEntry} dataset
   * @param {boolean} open
   * @param {() => void} toggle
   */
  function datasetRow({ id, name }, open, toggle) {
    const title = h(
      'button',
      {
        type: 'button',
        'aria-expanded': open,
        onClick: toggle,
        style: { ...CONTROL, border: 'none', padding: '0 4px', fontWeight: 600, textAlign: 'left' },
      },
      name,
    );
    return h(
      'li',
      { key: id, 'data-dsh-team-kb-dataset': id },
      title,
      open ? h(DatasetFiles, { datasetId: id }) : null,
    );
  }

  /** The 「知识库」 main page: library list, name search, refresh and expandable libraries. */
  function KnowledgeBasePage() {
    const request = useRequest();
    /** @type {[import('./client.types.js').KbAnswer | { result: 'loading' }, (list: import('./client.types.js').KbAnswer | { result: 'loading' }) => void]} */
    const [list, setList] = React.useState(
      /** @type {import('./client.types.js').KbAnswer | { result: 'loading' }} */ ({
        result: 'loading',
      }),
    );
    const [search, setSearch] = React.useState('');
    const [expanded, setExpanded] = React.useState(/** @type {ReadonlySet<string>} */ (new Set()));
    const load = React.useCallback(() => {
      setList({ result: 'loading' });
      setExpanded(new Set());
      request('api/knowledge-base.datasets', setList);
    }, [request]);
    React.useEffect(load, [load]);
    const view = datasetsView(list, search);
    /** @param {string} id */
    const toggle = (id) => {
      const next = new Set(expanded);
      if (!next.delete(id)) next.add(id);
      setExpanded(next);
    };
    const configured = view.state !== 'not-configured';
    const header = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' } },
      h('h2', { style: { flex: '1 1 auto', margin: 0, fontSize: '18px' } }, '知识库'),
      configured
        ? h('input', {
            'aria-label': '按库名搜索',
            placeholder: '搜索知识库',
            value: search,
            /** @param {{ target: { value: string } }} event */
            onChange: (event) => setSearch(event.target.value),
            style: CONTROL,
          })
        : null,
      // Refresh stays when not configured: the administrator may configure RAGFlow meanwhile.
      button('刷新', load),
    );
    const content =
      view.state === 'list'
        ? h(
            'ul',
            { style: { listStyle: 'none', margin: 0, padding: 0 } },
            ...view.rows.map((row) => datasetRow(row, expanded.has(row.id), () => toggle(row.id))),
          )
        : notice(LIST_TEXT[view.state], view.state === 'failed' ? [button('重试', load)] : []);
    return h(
      'div',
      {
        'data-dsh-team-kb-page': '',
        style: {
          boxSizing: 'border-box',
          height: '100%',
          overflowY: 'auto',
          padding: '24px 32px',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '14px',
        },
      },
      header,
      h('div', { 'data-dsh-team-kb-datasets': '', [STATE]: view.state }, content),
    );
  }

  window.__ModuleLoader__.load({
    id: '@dsh-team/knowledge-base',
    factory: (requireClient) => {
      React = requireClient('react');
      return {
        inject: ['slots'],
        apply(ctx) {
          // An unavailable instance (no platform address or token) gets no panel at all.
          if (!available()) return;
          // `layout.selectPanel` requires the `main` entry with the row's key.
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: ID }, KnowledgeBasePage),
          );
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: ID, order: 20, label: () => '知识库' },
              PanelIcon,
            ),
          );
        },
      };
    },
  });
})();
