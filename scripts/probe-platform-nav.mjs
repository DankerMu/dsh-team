/** Real DSH sidebar evidence for the platform navigation plugin; no request bodies or cookies. */
import { captureSettledScreenshot, clickSelector, evalPage, waitFor } from './probe-dsh-api-ui.mjs';

const NAV = '[data-dsh-team-platform-nav]';
// Released 0.2.0-rc.2 zh sidebar toggle labels (`toggle.collapse` / `toggle.open`).
const COLLAPSE = 'button[aria-label="收起侧边栏"]';
const EXPAND = 'button[aria-label="打开侧边栏"]';
const ACCOUNT = { href: '/_platform/account', label: '账号设置', heading: '修改密码' };
const ADMIN = { href: '/_platform/admin', label: '管理后台', heading: '账号管理' };

/** Visible, in-viewport links of the entry, which must share the footer cell with Cordis. */
const OBSERVE = `(function(){
  const nav=document.querySelector(${JSON.stringify(NAV)});
  if(!nav)return null;
  const visible=(el)=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&
      s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]');
  };
  const cordis=document.querySelector('[data-cordis-badge]');
  return {
    mode:nav.getAttribute('data-dsh-team-platform-nav'),
    sharedFooter:Boolean(cordis&&nav.parentElement&&nav.parentElement.contains(cordis)),
    cordisVisible:Boolean(cordis&&visible(cordis)),
    links:[...nav.querySelectorAll('a')].map((a)=>({
      href:a.getAttribute('href'),
      text:(a.textContent||'').trim(),
      label:a.getAttribute('aria-label'),
      target:a.getAttribute('target'),
      visible:visible(a),
    })),
  };
})()`;

const DESTINATION = `(function(){
  const heading=document.querySelector('h1');
  return {path:location.pathname,search:location.search,heading:heading?(heading.textContent||'').trim():null};
})()`;

/** @param {boolean} admin */
const expectedPlatformLinks = (admin) => (admin ? [ACCOUNT, ADMIN] : [ACCOUNT]);

const linkMatches = (link, expected, wide) =>
  link.href === expected.href &&
  link.visible === true &&
  link.target === null &&
  (wide
    ? link.text === expected.label && link.label === null
    : link.text === '' && link.label === expected.label);

/** Exact link set for the mode: an employee seeing the console link is a failure, not extra. */
const platformNavMatches = (observed, mode, expected) =>
  Boolean(
    observed &&
    observed.mode === mode &&
    observed.sharedFooter === true &&
    observed.cordisVisible === true &&
    Array.isArray(observed.links) &&
    observed.links.length === expected.length &&
    observed.links.every((link, index) => linkMatches(link, expected[index], mode === 'wide')),
  );

const settled = async (page, mode, expected, ms) => {
  let last;
  try {
    return await waitFor(
      async () => {
        last = await evalPage(page, OBSERVE);
        return platformNavMatches(last, mode, expected) ? last : false;
      },
      ms,
      `platform-nav-${mode}`,
    );
  } catch (error) {
    // Bounded, credential-free shape for diagnosis; no page text beyond the fixed labels.
    throw new Error(`stage=platform-nav-${mode} observed=${JSON.stringify(last ?? null)}`, {
      cause: error,
    });
  }
};

const destinationOf = async (page) => {
  try {
    return await evalPage(page, DESTINATION);
  } catch {
    // The execution context is replaced while the same-tab navigation commits.
    return undefined;
  }
};

/**
 * Prove the wide and collapsed sidebar entries, then follow the role's link out of DSH.
 * Run last: the click leaves the DSH page.
 */
export const verifyPlatformNav = async ({ page, admin, errors, screenshot, ms }) => {
  const expected = expectedPlatformLinks(admin);
  const shot = (suffix) =>
    captureSettledScreenshot(page, screenshot.replace(/\.png$/, `-platform-nav-${suffix}.png`));
  const wide = await settled(page, 'wide', expected, ms);
  const screenshots = [await shot('wide')];
  await clickSelector(page, COLLAPSE);
  const rail = await settled(page, 'rail', expected, ms);
  screenshots.push(await shot('rail'));
  await clickSelector(page, EXPAND);
  await settled(page, 'wide', expected, ms);
  const target = admin ? ADMIN : ACCOUNT;
  await clickSelector(page, `${NAV} a[href="${target.href}"]`);
  const destination = await waitFor(
    async () => {
      const observed = await destinationOf(page);
      return observed?.path === target.href && observed.heading === target.heading
        ? observed
        : false;
    },
    ms,
    'platform-nav-destination',
  );
  screenshots.push(await shot('destination'));
  if (errors.length) throw new Error(`stage=platform-nav error=console count=${errors.length}`);
  return { wide: wide.links, rail: rail.links, cordisVisible: true, destination, screenshots };
};
