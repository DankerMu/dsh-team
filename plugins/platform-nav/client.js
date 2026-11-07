// @ts-check
/**
 * Classic-script sidebar footer entry linking DSH back to the platform pages, the locked display
 * of administrator-forced bundles on the released plugin page, and of better-sidebar's two HTML
 * preview sandbox switches.
 */
(() => {
  /** @param {string} key */
  function pageValue(key) {
    // Page global written by the host half through the released `webserver/index-inject` row.
    const value = Reflect.get(globalThis, '__DSH_TEAM_PLATFORM_NAV__');
    return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  }

  const LOCK = 'data-dsh-team-plugin-lock';
  const SANDBOX = 'html-sandbox';
  const LOCK_TEXT = {
    'forced-on': '已开启 · 由管理员设定',
    'forced-off': '已关闭 · 由管理员设定',
    [SANDBOX]: '沙箱开启 · 由管理员设定',
  };
  const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const ANCHORS = '[data-plugin-package],[data-plugin-detail]';
  // dsh-better-sidebar 0.28.0's HTML viewer toggles `htmlViewerNoSandbox` and
  // `htmlViewerDefaultUnsafe`, zh and en titles (lib/client.js:2713-2716, :3343-3346). Its
  // Switch is a `<label>` holding `<input type="checkbox" aria-label={title}>`; the DOM has no key.
  const SANDBOX_TITLES = [
    '关闭 HTML 预览沙箱（不安全）',
    'HTML 预览默认以非沙箱模式打开（不安全）',
    'Disable HTML preview sandbox (unsafe)',
    'Open HTML previews unsandboxed by default (unsafe)',
  ];
  const SANDBOX_INPUTS = SANDBOX_TITLES.map(
    (title) => `input[type="checkbox"][aria-label="${title}"]`,
  ).join(',');
  // The rule applies before the popup renders, so no clickable switch ever flashes.
  const SANDBOX_CSS = SANDBOX_TITLES.map(
    (title) => `label:has(> input[aria-label="${title}"]){display:none !important}`,
  ).join('');

  /**
   * Each forced package's two bundle switch selectors (its card, and the last switch of the
   * detail page's top action row: `:last-of-type` still matches once the mark follows it).
   * Anything malformed locks nothing; the host half already rejects it loudly.
   * @returns {{ selectors: string[]; selector: string; state: keyof typeof LOCK_TEXT }[]}
   */
  function forcedLocks() {
    const catalog = pageValue('pluginCatalog');
    if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) return [];
    const locks = [];
    for (const [name, state] of Object.entries(catalog)) {
      if (!PACKAGE.test(name) || (state !== 'forced-on' && state !== 'forced-off')) return [];
      const selectors = [
        `[data-plugin-package="${name}"] button[role="switch"]`,
        `[data-plugin-detail="${name}"] > :first-child button[role="switch"]:last-of-type`,
      ];
      locks.push({ selectors, selector: selectors.join(','), state });
    }
    return locks;
  }

  /**
   * Insert one non-interactive mark after a hidden switch; DSH's own nodes stay as rendered.
   * @param {PlatformNavElement} native
   * @param {keyof typeof LOCK_TEXT} state
   */
  function lockSwitch(native, state) {
    const parent = native.parentElement;
    if (parent === null) return;
    for (const sibling of parent.children) if (sibling.hasAttribute(LOCK)) return;
    const mark = document.createElement('span');
    mark.setAttribute(LOCK, state);
    mark.textContent = LOCK_TEXT[state];
    mark.style.cssText =
      'font-size:12px;line-height:20px;white-space:nowrap;color:var(--dsw-alias-label-secondary)';
    native.after(mark);
  }

  /**
   * The mark follows the Switch's `<label>`, not the input, which the hidden label would cover;
   * each toggle row is its own parent, so rows are deduplicated independently.
   * @param {PlatformNavElement} input
   */
  function lockSandboxSwitch(input) {
    const label = input.closest('label');
    if (label !== null) lockSwitch(label, SANDBOX);
  }

  /** @param {string} value @param {string} css */
  function appendLockStyle(value, css) {
    const style = document.createElement('style');
    style.setAttribute(LOCK, value);
    style.textContent = css;
    document.head.append(style);
  }

  /**
   * Hide and mark the HTML preview sandbox switches on every page (product policy F36, no page
   * global or overlay input) and the forced bundle switches of a valid catalog, now and as DSH
   * renders them. One style per lock kind; the catalog guard matches only its own style.
   */
  function lockSwitches() {
    if (document.head.querySelector(`style[${LOCK}="${SANDBOX}"]`) !== null) return;
    appendLockStyle(SANDBOX, SANDBOX_CSS);
    const locks = forcedLocks();
    if (locks.length > 0 && document.head.querySelector(`style[${LOCK}=""]`) === null)
      appendLockStyle(
        '',
        locks
          .flatMap(({ selectors }) =>
            selectors.map((selector) => `${selector}{display:none !important}`),
          )
          .join(''),
      );
    /** @param {PlatformNavElement} root */
    const scan = (root) => {
      for (const { selector, state } of locks) {
        if (root.matches(selector)) lockSwitch(root, state);
        for (const native of root.querySelectorAll(selector)) lockSwitch(native, state);
      }
      for (const input of root.querySelectorAll(SANDBOX_INPUTS)) lockSandboxSwitch(input);
    };
    /**
     * Only an added subtree inside or holding a plugin page anchor, or holding a sandbox toggle,
     * is searched. The sandbox check costs one `querySelector` per added element, chat
     * streaming included, and never a whole-document query. A lone re-mounted input needs no
     * check: its label keeps the mark that follows it, and the style keeps the label hidden.
     * @param {PlatformNavElement} element
     */
    const relevant = (element) =>
      element.closest(ANCHORS) !== null ||
      element.querySelector(ANCHORS) !== null ||
      element.querySelector(SANDBOX_INPUTS) !== null;
    scan(document.body);
    // The one observer, resident on every DSH page: only added element nodes are looked at.
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const element = /** @type {PlatformNavElement} */ (node);
          if (relevant(element)) scan(element);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.__ModuleLoader__.load({
    id: '@dsh-team/platform-nav',
    factory: (requireClient) => {
      const React = requireClient('react');
      const h = React.createElement;
      const MARK = 'data-dsh-team-platform-nav';
      // The shipped footer cell is a flex row sized for one action, and the released renderer
      // wraps the slot's entries in a `display:contents` anchor: select the real cell through
      // that stable anchor and stack this entry below Cordis, centred in the collapsed rail.
      const CSS =
        `:has(> [data-slot="sidebar.footer.action"] > [${MARK}])` +
        `{flex-direction:column;align-items:center}` +
        `[${MARK}] a:hover{background:var(--dsw-alias-interactive-bg-hover)}` +
        `[${MARK}] a:focus-visible{outline:var(--dsw-focus-ring-width) solid ` +
        `var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}`;
      const ICONS = {
        account: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
        admin: ['M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6l-7-3Z', 'm9 12 2 2 4-4'],
      };

      /** Only a literal `admin: true` on an object page global shows the console link. */
      function administrator() {
        return pageValue('admin') === true;
      }

      /** @param {keyof typeof ICONS} kind @param {number} size */
      function icon(kind, size) {
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            focusable: 'false',
            style: { flex: 'none' },
          },
          ...ICONS[kind].map((d) => h('path', { key: d, d })),
        );
      }

      /** @param {{ href: string; label: string; kind: keyof typeof ICONS; wide: boolean }} link */
      function platformLink({ href, label, kind, wide }) {
        const base = {
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          color: 'var(--dsw-alias-label-primary)',
          textDecoration: 'none',
          fontSize: '14px',
          lineHeight: '22px',
        };
        if (!wide) {
          return h(
            'a',
            {
              key: href,
              href,
              'aria-label': label,
              title: label,
              style: {
                ...base,
                justifyContent: 'center',
                width: '36px',
                height: '36px',
                borderRadius: '50%',
              },
            },
            icon(kind, 18),
          );
        }
        return h(
          'a',
          {
            key: href,
            href,
            style: {
              ...base,
              gap: '8px',
              height: '36px',
              margin: '0 -2px',
              padding: '0 10px 0 8px',
              borderRadius: 'var(--dsw-radius-md)',
            },
          },
          icon(kind, 16),
          h(
            'span',
            {
              style: {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            label,
          ),
        );
      }

      /** @param {PlatformNavProps} props */
      function PlatformNav({ wide }) {
        const links = [
          platformLink({ href: '/_platform/account', label: '账号设置', kind: 'account', wide }),
        ];
        if (administrator())
          links.push(
            platformLink({ href: '/_platform/admin', label: '管理后台', kind: 'admin', wide }),
          );
        return h(
          'nav',
          {
            [MARK]: wide ? 'wide' : 'rail',
            'aria-label': '平台入口',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              width: wide ? '100%' : '36px',
              marginTop: '4px',
            },
          },
          h('style', null, CSS),
          ...links,
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          // Sort after the shipped Cordis action (order 0) so its badge keeps its place.
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              { name: 'sidebar.footer.action', id: 'dsh-team-platform-nav', order: 1 },
              PlatformNav,
            ),
          );
          lockSwitches();
        },
      };
    },
  });
})();
