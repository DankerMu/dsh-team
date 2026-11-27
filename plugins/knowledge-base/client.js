// @ts-check
/**
 * Classic-script client half of the knowledge-base plugin: the 「知识库」 panel and the composer
 * scope control. As with the released panels (定时任务), the panel's entry is one
 * `sidebar.panellist` row and its content is the `main` page under the same key. It reads only
 * this instance's own `api/knowledge-base.*` routes, whose host half forwards to the platform
 * proxy; browsing touches no Session or scope data. The scope control reads the host's `kbScope`
 * projection and writes only through the `/kb-scope` command.
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
  const SCOPE = 'data-dsh-team-kb-scope';
  const SCOPE_STATE = 'data-dsh-team-kb-scope-state';
  const SCOPE_FAILED = '范围保存失败，请重试';
  /** How long a saved write waits for its projection frame before the actions re-enable. */
  const SCOPE_SETTLE_MS = 2000;
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

  /** The panel's own look: rows, counts, glyphs and state notices, on DSH's variables. */
  const SECONDARY = 'var(--dsw-alias-label-secondary)';
  const RADIUS = 'var(--dsw-radius-md, 6px)';
  const DIVIDER =
    '1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-primary, currentColor))';
  // Hover needs a rule, so the title button's background lives here and not inline.
  const PANEL_CSS =
    '[data-dsh-team-kb-page] [data-dsh-team-kb-dataset] > button{background:transparent}' +
    '[data-dsh-team-kb-page] [data-dsh-team-kb-dataset] > button:hover' +
    '{background:var(--dsw-alias-interactive-bg-hover, transparent)}';
  const PANEL_TITLE = {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    height: '34px',
    padding: '0 8px 0 28px',
    border: 'none',
    borderRadius: RADIUS,
    color: 'inherit',
    font: 'inherit',
    fontWeight: 600,
    textAlign: 'left',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const PANEL_CHEVRON = {
    position: 'absolute',
    top: '10px',
    left: '8px',
    color: SECONDARY,
    pointerEvents: 'none',
  };
  const PANEL_FILE = { display: 'flex', alignItems: 'center', gap: '6px', height: '26px' };
  const PANEL_NAME = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const PANEL_COUNT = { margin: '2px 0 0', color: SECONDARY, fontSize: '12px' };
  const PANEL_NOTICE = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    margin: '8px 0',
    color: SECONDARY,
  };
  const PANEL_PAGING = { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' };
  const CHEVRON_PATHS = ['m9 6 6 6-6 6'];
  const FILE_PATHS = [
    'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z',
    'M14 3v5h5',
  ];
  const PANEL_PATHS = [
    'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z',
    'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
    'M9 7.5h6M9 11h4',
  ];

  /**
   * An inline line glyph without text, hidden from assistive technology.
   * @param {string[]} paths
   * @param {number} size
   * @param {number} strokeWidth
   * @param {Record<string, string | number>} [style]
   */
  function glyph(paths, size, strokeWidth, style) {
    const props = {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: 'false',
      style,
    };
    return h('svg', props, ...paths.map((d) => h('path', { key: d, d })));
  }

  /** @param {{ size: number; active: boolean }} props */
  function PanelIcon({ size, active }) {
    return glyph(PANEL_PATHS, size, active ? 1.9 : 1.6);
  }

  /**
   * A panel state's text in the shared notice look, with 「重试」 beside it when `retry` is given.
   * @param {string} text
   * @param {(() => void) | undefined} retry
   */
  function stateNotice(text, retry) {
    const action = retry === undefined ? null : button('重试', retry);
    return h('div', { style: PANEL_NOTICE }, h('p', { style: { margin: 0 } }, text), action);
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
   * One page of documents; the paging row only when there is more than one page.
   * @param {import('./client.types.js').KbFilesView} view
   * @param {(page: number) => void} go
   */
  function filesPage(view, go) {
    const pages = Math.max(1, Math.ceil((view.total ?? 0) / PAGE_SIZE));
    const fileGlyph = glyph(FILE_PATHS, 14, 1.6, { flex: 'none', color: SECONDARY });
    // The glyph has no text, so the row's text stays exactly the file name.
    const rows = (view.documents ?? []).map(({ id, name }) =>
      h(
        'li',
        { key: id, 'data-dsh-team-kb-file': id, title: name, style: PANEL_FILE },
        fileGlyph,
        h('span', { style: PANEL_NAME }, name),
      ),
    );
    const list = h(
      'ul',
      { key: 'files', style: { listStyle: 'none', margin: 0, padding: 0 } },
      ...rows,
    );
    if (pages <= 1) return [list];
    const paging = h(
      'div',
      { key: 'paging', style: PANEL_PAGING },
      button('上一页', () => go(view.page - 1), view.page <= 1),
      h('span', null, `第 ${String(view.page)} / ${String(pages)} 页`),
      button('下一页', () => go(view.page + 1), view.page >= pages),
    );
    return [list, paging];
  }

  // The field and its submit button read as one bordered group: their inner corners are square
  // and the button's left border is the field's right one.
  const FILTER_FIELD = {
    flex: '1 1 120px',
    minWidth: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  };
  const FILTER_SUBMIT = { borderLeftWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 };

  /**
   * The file-name filter; a blank filter clears it and one over the proxy's limit is refused.
   * @param {{ draft: string; tooLong: boolean; setDraft: (value: string) => void; submit: () => void }} filter
   */
  function filterForm({ draft, tooLong, setDraft, submit }) {
    return h(
      'form',
      {
        style: { display: 'flex', flexWrap: 'wrap', margin: '8px 0' },
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
        style: { ...CONTROL, ...FILTER_FIELD },
      }),
      h('button', { type: 'submit', style: { ...CONTROL, ...FILTER_SUBMIT } }, '筛选'),
      tooLong
        ? h(
            'p',
            {
              'data-dsh-team-kb-hint': 'keywords-too-long',
              style: { width: '100%', margin: '4px 0 0' },
            },
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
    const listed = view.state === 'list';
    const retry = () => load(view.page, view.keywords);
    const body = listed
      ? filesPage(view, (page) => load(page, view.keywords))
      : [stateNotice(FILES_TEXT[view.state], view.state === 'failed' ? retry : undefined)];
    // The count and the form keep their child slots, so the field survives a reload.
    return h(
      'div',
      {
        'data-dsh-team-kb-files': datasetId,
        [STATE]: view.state,
        style: { padding: '0 8px 10px 28px' },
      },
      listed ? h('p', { style: PANEL_COUNT }, `共 ${String(view.total ?? 0)} 个文件`) : null,
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
    // The chevron sits beside the title button, never in it: the button's text is the name.
    const turn = { ...PANEL_CHEVRON, transform: open ? 'rotate(90deg)' : 'none' };
    const title = h(
      'button',
      { type: 'button', 'aria-expanded': open, onClick: toggle, style: PANEL_TITLE },
      name,
    );
    return h(
      'li',
      {
        key: id,
        'data-dsh-team-kb-dataset': id,
        style: { position: 'relative', borderBottom: DIVIDER },
      },
      glyph(CHEVRON_PATHS, 14, 1.8, turn),
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
        : stateNotice(LIST_TEXT[view.state], view.state === 'failed' ? load : undefined);
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
      h('style', null, PANEL_CSS),
      header,
      h('div', { 'data-dsh-team-kb-datasets': '', [STATE]: view.state }, content),
    );
  }

  /**
   * The `kbScope` wire view, or undefined when absent or not the host's shape.
   * @param {unknown} value
   * @returns {import('./client.types.js').KbScopeView | undefined}
   */
  function scopeView(value) {
    if (typeof value !== 'object' || value === null) return undefined;
    const { child, selection } = /** @type {Record<string, unknown>} */ (value);
    if (typeof child !== 'boolean') return undefined;
    const listed = Array.isArray(selection) && selection.every((id) => typeof id === 'string');
    if (selection !== null && !listed) return undefined;
    return { child, selection: /** @type {string[] | null} */ (selection) };
  }

  /**
   * Whether two selections are the same scope: both the whole scope, or the same IDs in any order.
   * @param {string[] | null} left
   * @param {string[] | null} right
   */
  function sameScope(left, right) {
    if (left === null || right === null) return left === right;
    return left.length === right.length && left.every((id) => right.includes(id));
  }

  /**
   * The selection after toggling one listed library: from the whole scope, every listed library
   * but this one; otherwise this one removed or appended, unlisted (deleted) IDs kept.
   * @param {string[] | null} selection
   * @param {string[]} listed
   * @param {string} id
   */
  function toggled(selection, listed, id) {
    if (selection === null) return listed.filter((item) => item !== id);
    return selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id];
  }

  /**
   * The popover: whole-scope and no-scope actions, then one checkbox per listed library. Its
   * library list reuses the panel's request slot, states and texts.
   * @param {{ selection: string[] | null; pending: boolean; failed: boolean; write: (ids: string[] | null) => void }} props
   */
  function ScopePopover({ selection, pending, failed, write }) {
    const request = useRequest();
    /** @type {[import('./client.types.js').KbAnswer | { result: 'loading' }, (list: import('./client.types.js').KbAnswer | { result: 'loading' }) => void]} */
    const [list, setList] = React.useState(
      /** @type {import('./client.types.js').KbAnswer | { result: 'loading' }} */ ({
        result: 'loading',
      }),
    );
    const load = React.useCallback(() => {
      setList({ result: 'loading' });
      request('api/knowledge-base.datasets', setList);
    }, [request]);
    React.useEffect(load, [load]);
    const view = datasetsView(list, '');
    const listed = view.rows.map(({ id }) => id);
    const rows = view.rows.map(({ id, name }) =>
      h(
        'label',
        { key: id, style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' } },
        h('input', {
          type: 'checkbox',
          'data-dsh-team-kb-scope-dataset': id,
          checked: selection === null || selection.includes(id),
          disabled: pending,
          onChange: () => write(toggled(selection, listed, id)),
        }),
        name,
      ),
    );
    const content =
      view.state === 'list'
        ? rows
        : [notice(LIST_TEXT[view.state], view.state === 'failed' ? [button('重试', load)] : [])];
    return h(
      'div',
      {
        role: 'dialog',
        'aria-label': '知识库检索范围',
        style: {
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: 0,
          zIndex: 20,
          boxSizing: 'border-box',
          width: '260px',
          maxHeight: '320px',
          overflowY: 'auto',
          padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border-primary, currentColor)',
          borderRadius: 'var(--dsw-radius-md, 6px)',
          background: 'var(--dsw-alias-bg-base, Canvas)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '13px',
        },
      },
      h(
        'div',
        { style: { display: 'flex', gap: '8px', marginBottom: '6px' } },
        button('全选', () => write(null), pending),
        button('取消全选', () => write([]), pending),
      ),
      h('div', { [SCOPE_STATE]: view.state }, ...content),
      failed
        ? h('p', { 'data-dsh-team-kb-scope-error': '', style: { margin: '6px 0 0' } }, SCOPE_FAILED)
        : null,
    );
  }

  /**
   * The composer control: a button labelled from the projection and its popover. Writes go one
   * at a time through `execute`; the label changes only when the projection does.
   * @param {{ sessionId: string; useProjection: (key: 'kbScope') => unknown; execute: (sessionId: string, line: string) => Promise<import('./client.types.js').KbCommandResult> }} props
   */
  function ScopeControl({ sessionId, useProjection, execute }) {
    const scope = scopeView(useProjection('kbScope'));
    const [open, setOpen] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const writing = React.useRef(false);
    const alive = React.useRef(true);
    // A saved write's selection, held until the projection shows it: the remote answer can
    // arrive before the projection frame, and a change computed from the stale selection would
    // overwrite the saved one. A Session change or SCOPE_SETTLE_MS releases it as well.
    /** @type {[{ sessionId: string; selection: string[] | null } | null, (next: { sessionId: string; selection: string[] | null } | null) => void]} */
    const [awaited, setAwaited] = React.useState(
      /** @type {{ sessionId: string; selection: string[] | null } | null} */ (null),
    );
    const current = scope === undefined ? undefined : scope.selection;
    React.useEffect(
      () => () => {
        alive.current = false;
      },
      [],
    );
    React.useEffect(() => {
      if (awaited === null) return undefined;
      const release = () => {
        writing.current = false;
        setAwaited(null);
        setPending(false);
      };
      const shown = current !== undefined && sameScope(current, awaited.selection);
      if (shown || awaited.sessionId !== sessionId) {
        release();
        return undefined;
      }
      const timer = setTimeout(release, SCOPE_SETTLE_MS);
      return () => clearTimeout(timer);
    }, [awaited, current, sessionId]);
    // A child Agent's Session has its root's scope; the controller refuses commands there.
    if (scope === undefined || scope.child) return null;
    /** @param {string[] | null} datasetIds */
    const write = (datasetIds) => {
      if (writing.current) return;
      writing.current = true;
      setPending(true);
      setFailed(false);
      /** @param {boolean} saved */
      const settle = (saved) => {
        if (!alive.current) {
          writing.current = false;
          return;
        }
        if (saved) {
          setAwaited({ sessionId, selection: datasetIds });
          return;
        }
        writing.current = false;
        setPending(false);
        setFailed(true);
      };
      // Any answer that is not a success settles as a failure, so the fence always clears.
      execute(sessionId, `/kb-scope ${JSON.stringify({ datasetIds })}`).then(
        (result) => {
          settle(result.ok && result.value?.result?.kind === 'success');
        },
        () => {
          settle(false);
        },
      );
    };
    const { selection } = scope;
    const [state, summary] =
      selection === null
        ? ['all', '全部']
        : selection.length === 0
          ? ['none', '不检索']
          : ['some', `${String(selection.length)} 个`];
    const toggle = h(
      'button',
      {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
        style: { ...CONTROL, height: '26px', padding: '0 8px', fontSize: '12px' },
      },
      `知识库：${summary}`,
    );
    return h(
      'span',
      { [SCOPE]: state, style: { position: 'relative', display: 'inline-flex' } },
      toggle,
      open ? h(ScopePopover, { selection, pending, failed, write }) : null,
    );
  }

  window.__ModuleLoader__.load({
    id: '@dsh-team/knowledge-base',
    factory: (requireClient) => {
      React = requireClient('react');
      return {
        // As the released plan client, the command remote is reached through `remote`.
        inject: ['slots', 'remote', 'remote.commands'],
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
          /** @param {{ sessionId: string; useProjection: (key: 'kbScope') => unknown }} props */
          const ScopeEntry = (props) =>
            h(ScopeControl, {
              ...props,
              /** @param {string} sessionId @param {string} line */
              execute: (sessionId, line) => ctx.remote.commands.execute(sessionId, line, []),
            });
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              { name: 'conversation.input.left', id: 'knowledge-base-scope', order: 100 },
              ScopeEntry,
            ),
          );
          // The command row the control leaves in the transcript renders nothing.
          ctx.slots.inject('conversation.chat.commandview', () =>
            ctx.slots.register(
              { name: 'conversation.chat.commandview', key: 'kb-scope' },
              () => null,
            ),
          );
        },
      };
    },
  });
})();
