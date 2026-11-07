import { afterEach, expect, it } from 'vitest';
import {
  APP_BOOT,
  DSH,
  evaluations,
  imageTree,
  MARKER,
  OPT,
  PROFILE,
  RELEASED_MANIFESTS,
  removeImageTrees,
  repositoryManifest,
  verify,
  write,
} from './catalog-check-fixture.mjs';

afterEach(removeImageTrees);

// Both copies change alike: the /opt plugin and its profile registration share one name, so the
// check runs once and the copies stay equal.
it.each([
  [
    'an excluding range',
    'platform-nav',
    { engines: { dsh: '>=0.3.0' } },
    'DSH plugin compatibility failed: platform-nav engines.dsh=">=0.3.0" peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'a missing range',
    'office-agents',
    { engines: {} },
    'DSH plugin compatibility failed: office-agents engines.dsh=undefined peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'a blank range',
    'permission-tiers',
    { engines: { dsh: ' ' } },
    'DSH plugin compatibility failed: permission-tiers engines.dsh=" " peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'an exact DSH peer',
    'zh-locale',
    { peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } },
    'DSH plugin compatibility failed: zh-locale engines.dsh=">=0.2.1-rc.2 <0.3.0" peer="0.2.1-rc.2" installed=0.2.1-rc.2',
  ],
])('fails the DSH compatibility check once and verbatim for %s', (_name, id, change, line) => {
  const tree = imageTree();
  const manifest = { ...repositoryManifest(id), ...change };
  write(tree.root, `${OPT}/${id}/package.json`, manifest);
  write(tree.root, `${PROFILE}/node_modules/@dsh-team/${id}/package.json`, manifest);

  expect(verify(tree)).toEqual({ status: 1, stderr: `${line}\n` });
});

it('fails when the installed DSH semver cannot be loaded', () => {
  const tree = imageTree();
  write(tree.root, `${DSH}/node_modules/semver/index.js`, "throw new Error('broken');\n");

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `DSH semver unavailable: ${DSH}/package.json\n`,
  });
});

/** Change the released stub in both delivered copies, so only the compatibility rule decides. */
function changeReleased(tree, change) {
  const manifest = { ...RELEASED_MANIFESTS['dsh-better-sidebar'], ...change };
  write(tree.root, `${OPT}/dsh-better-sidebar/package.json`, manifest);
  write(tree.root, `${PROFILE}/node_modules/dsh-better-sidebar/package.json`, manifest);
}

it('passes a non-repository plugin the released loader decision accepts, once and with no exemptions', () => {
  const tree = imageTree();

  expect(verify(tree)).toEqual({ status: 0, stderr: '' });
  expect(evaluations(tree)).toEqual([
    { name: 'dsh-better-sidebar', exemptions: {}, installed: '0.2.1-rc.2' },
  ]);
});

it('hands the released loader decision the installed DSH version, not a constant', () => {
  const tree = imageTree();
  write(tree.root, `${DSH}/package.json`, { name: '@deepseek-ai/dsh', version: '0.2.9-rc.7' });

  verify(tree);

  expect(evaluations(tree).map((call) => call.installed)).toEqual(['0.2.9-rc.7']);
});

it.each([
  [
    'a problem object',
    'unmet',
    'DSH plugin compatibility failed: dsh-better-sidebar' +
      ' requirements={"@deepseek-ai/dsh-agent":"^0.3.0"} installed=0.2.1-rc.2',
  ],
  [
    'a throw',
    'throws',
    'DSH plugin compatibility failed: dsh-better-sidebar' +
      ' error="Error: malformed peerDependencies second line" installed=0.2.1-rc.2',
  ],
])(
  'fails a non-repository plugin on %s from the released loader decision, in one line',
  (_name, marker, line) => {
    const tree = imageTree();
    changeReleased(tree, { [MARKER]: marker });

    expect(verify(tree)).toEqual({ status: 1, stderr: `${line}\n` });
  },
);

it('keeps the repository rule for @dsh-team plugins without consulting the released loader decision', () => {
  const tree = imageTree();
  const manifest = { ...repositoryManifest('office-agents'), engines: {}, [MARKER]: 'throws' };
  write(tree.root, `${OPT}/office-agents/package.json`, manifest);
  write(tree.root, `${PROFILE}/node_modules/@dsh-team/office-agents/package.json`, manifest);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr:
      'DSH plugin compatibility failed: office-agents engines.dsh=undefined peer=undefined installed=0.2.1-rc.2\n',
  });
  expect(evaluations(tree).map((call) => call.name)).toEqual(['dsh-better-sidebar']);
});

it.each([
  ['cannot be loaded', "throw new Error('broken');\n"],
  ['does not export the loader decision', 'export const other = 1;\n'],
])('fails when the installed DSH app-boot %s', (_name, source) => {
  const tree = imageTree();
  write(tree.root, `${APP_BOOT}/lib/index.js`, source);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `DSH app-boot unavailable: ${DSH}/package.json\n`,
  });
  expect(evaluations(tree)).toEqual([]);
});
