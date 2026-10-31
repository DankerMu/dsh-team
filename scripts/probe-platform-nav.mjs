/** Real DSH sidebar evidence for the platform navigation plugin; no request bodies or cookies. */
import { captureSettledScreenshot, clickSelector, evalPage, waitFor } from './probe-dsh-api-ui.mjs';

const NAV = '[data-dsh-team-platform-nav]';
// Released 0.2.1-rc.2 zh sidebar toggle labels (`toggle.collapse` / `toggle.open`).
const COLLAPSE = 'button[aria-label="收起侧边栏"]';
const EXPAND = 'button[aria-label="打开侧边栏"]';
const ACCOUNT = { href: '/_platform/account', label: '账号设置', heading: '修改密码' };
const ADMIN = { href: '/_platform/admin', label: '管理后台', heading: '账号管理' };

const SLOT = '[data-slot="sidebar.footer.action"]';
// Released Cordis `.badge` bleeds 2px past its footer cell on each side (`margin:0 -2px`) and
// the wide entry mirrors it; containment allows that bleed plus 1px of fractional-layout slack.
const BLEED = 3;
const WORKBENCH = { href: '/', text: '返回工作台' };

/** Rendered: nonzero box, not hidden and not inert. */
const RENDERED = `const rendered=(el)=>{
  const r=el.getBoundingClientRect(),s=getComputedStyle(el);
  return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]');
};`;

/**
 * Visible, in-viewport links of the entry. The renderer's `display:contents` slot anchor must be
 * the entry's parent; the real flex cell (the anchor's parent) must be stacked by the entry's
 * `:has()` rule, and every link stays horizontally inside that cell. The Cordis badge renders
 * only with Cordis plugin activity: absent is accepted, and when present it must share the cell
 * with the entry stacked below it.
 */
const OBSERVE = `(function(){
  const nav=document.querySelector(${JSON.stringify(NAV)});
  if(!nav)return null;
  ${RENDERED}
  const inView=(r)=>r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;
  const visible=(el)=>rendered(el)&&inView(el.getBoundingClientRect());
  const anchor=nav.parentElement;
  const cell=anchor&&anchor.matches(${JSON.stringify(SLOT)})?anchor.parentElement:null;
  const box=cell?cell.getBoundingClientRect():null;
  const layout=cell?getComputedStyle(cell):null;
  const badge=document.querySelector('[data-cordis-badge]');
  const cordis=!badge?'absent':cell&&cell.contains(badge)&&visible(badge)&&
    nav.getBoundingClientRect().top>=badge.getBoundingClientRect().bottom-1?'stacked':'misplaced';
  return {
    mode:nav.getAttribute('data-dsh-team-platform-nav'),
    inFooterSlot:Boolean(cell),
    cellStacked:Boolean(layout&&layout.flexDirection==='column'&&layout.alignItems==='center'),
    cellInViewport:Boolean(box&&inView(box)),
    cordis,
    links:[...nav.querySelectorAll('a')].map((a)=>{
      const r=a.getBoundingClientRect(),span=a.querySelector('span');
      return {
        href:a.getAttribute('href'),
        text:(a.textContent||'').trim(),
        label:a.getAttribute('aria-label'),
        target:a.getAttribute('target'),
        visible:visible(a),
        contained:Boolean(box&&r.left>=box.left-${BLEED}&&r.right<=box.right+${BLEED}),
        labelFits:!span||span.scrollWidth<=span.clientWidth,
      };
    }),
  };
})()`;

/** The administrator console's rendered link back to the DSH workbench, or null. */
const WORKBENCH_READ = `const back=[...document.querySelectorAll('a[href="/"]')]
  .find((a)=>(a.textContent||'').trim()===${JSON.stringify(WORKBENCH.text)});
result.workbench=back?{href:back.getAttribute('href'),text:(back.textContent||'').trim(),visible:rendered(back)}:null;`;

/** Destination heading; only the administrator console must also offer its way back to DSH. */
const destinationExpression = (admin) => `(function(){
  ${RENDERED}
  const heading=document.querySelector('h1');
  const result={path:location.pathname,search:location.search,heading:heading?(heading.textContent||'').trim():null};
  ${admin ? WORKBENCH_READ : ''}
  return result;
})()`;

/** @param {boolean} admin */
const expectedPlatformLinks = (admin) => (admin ? [ACCOUNT, ADMIN] : [ACCOUNT]);

const linkMatches = (link, expected, wide) =>
  link.href === expected.href &&
  link.visible === true &&
  link.target === null &&
  link.contained === true &&
  link.labelFits === true &&
  (wide
    ? link.text === expected.label && link.label === null
    : link.text === '' && link.label === expected.label);

const MODES = ['wide', 'rail'];
const CORDIS = ['absent', 'stacked'];
// The released toggle carries the label of the transition it performs from the current mode.
const TOGGLE = { wide: COLLAPSE, rail: EXPAND };

/**
 * Exact link set for the mode: an employee seeing the console link is a failure, not extra.
 * `mode` null accepts either known mode (the initial observation).
 */
const platformNavMatches = (observed, mode, expected) =>
  Boolean(
    observed &&
    MODES.includes(observed.mode) &&
    (mode === null || observed.mode === mode) &&
    observed.inFooterSlot === true &&
    observed.cellStacked === true &&
    observed.cellInViewport === true &&
    CORDIS.includes(observed.cordis) &&
    Array.isArray(observed.links) &&
    observed.links.length === expected.length &&
    observed.links.every((link, index) =>
      linkMatches(link, expected[index], observed.mode === 'wide'),
    ),
  );

const settled = async (page, mode, expected, ms) => {
  const stage = `platform-nav-${mode ?? 'initial'}`;
  let last;
  try {
    return await waitFor(
      async () => {
        last = await evalPage(page, OBSERVE);
        return platformNavMatches(last, mode, expected) ? last : false;
      },
      ms,
      stage,
    );
  } catch (error) {
    // Bounded, credential-free shape for diagnosis; no page text beyond the fixed labels.
    throw new Error(`stage=${stage} observed=${JSON.stringify(last ?? null)}`, { cause: error });
  }
};

const destinationOf = async (page, admin) => {
  try {
    return await evalPage(page, destinationExpression(admin));
  } catch {
    // The execution context is replaced while the same-tab navigation commits.
    return undefined;
  }
};

/**
 * Prove the entry in DSH's initial sidebar mode, toggle to the other mode and back (both wide
 * and rail are observed whichever comes first), then follow the role's link out of DSH.
 * Run last: the click leaves the DSH page.
 */
export const verifyPlatformNav = async ({ page, admin, errors, screenshot, ms }) => {
  const expected = expectedPlatformLinks(admin);
  const shot = (suffix) =>
    captureSettledScreenshot(page, screenshot.replace(/\.png$/, `-platform-nav-${suffix}.png`));
  const initial = await settled(page, null, expected, ms);
  const screenshots = [await shot(initial.mode)];
  const other = initial.mode === 'wide' ? 'rail' : 'wide';
  await clickSelector(page, TOGGLE[initial.mode]);
  const toggled = await settled(page, other, expected, ms);
  screenshots.push(await shot(other));
  await clickSelector(page, TOGGLE[other]);
  await settled(page, initial.mode, expected, ms);
  const observed = { [initial.mode]: initial, [other]: toggled };
  // One Cordis fact for the evidence: both modes must report the same badge state.
  if (observed.wide.cordis !== observed.rail.cordis)
    throw new Error(
      `stage=platform-nav error=cordis-divergent wide=${observed.wide.cordis} rail=${observed.rail.cordis}`,
    );
  const target = admin ? ADMIN : ACCOUNT;
  await clickSelector(page, `${NAV} a[href="${target.href}"]`);
  let last;
  const destination = await waitFor(
    async () => {
      last = await destinationOf(page, admin);
      return last?.path === target.href &&
        last.heading === target.heading &&
        (!admin ||
          (last.workbench?.href === WORKBENCH.href &&
            last.workbench.text === WORKBENCH.text &&
            last.workbench.visible === true))
        ? last
        : false;
    },
    ms,
    'platform-nav-destination',
  ).catch((error) => {
    // Path, heading and the fixed workbench link only; no cookies or page bodies.
    throw new Error(`stage=platform-nav-destination observed=${JSON.stringify(last ?? null)}`, {
      cause: error,
    });
  });
  screenshots.push(await shot('destination'));
  if (errors.length) throw new Error(`stage=platform-nav error=console count=${errors.length}`);
  return {
    wide: observed.wide.links,
    rail: observed.rail.links,
    cordis: observed.wide.cordis,
    destination,
    screenshots,
  };
};
