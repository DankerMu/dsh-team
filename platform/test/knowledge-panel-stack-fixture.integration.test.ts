import { expect, it } from 'vitest';
import { panelSnapshot, panelStep, settledPanel } from './knowledge-panel-stack-fixture.ts';
import type { PanelSnapshot } from './knowledge-panel-stack-fixture.ts';

const LISTED: PanelSnapshot = {
  loading: 0,
  buttons: ['刷新', 'dsh-team-seed-policies', '筛选'],
  datasets: { state: 'list', text: 'dsh-team-seed-policies', names: ['dsh-team-seed-policies'] },
  files: [{ state: 'list', names: ['expense-policy.txt'], hint: false }],
};

it('accepts the in-page panel snapshot as observed', () => {
  expect(panelSnapshot(LISTED)).toEqual(LISTED);
  const closed = { loading: 0, buttons: [], datasets: null, files: [] };
  expect(panelSnapshot(closed)).toEqual(closed);
});

it.each([
  ['a missing value', undefined],
  ['an array', []],
  ['a negative loading count', { ...LISTED, loading: -1 }],
  ['a fractional loading count', { ...LISTED, loading: 0.5 }],
  ['non-string buttons', { ...LISTED, buttons: [1] }],
  ['an unknown list state', { ...LISTED, datasets: { ...LISTED.datasets, state: 'ready' } }],
  ['a null list state', { ...LISTED, datasets: { ...LISTED.datasets, state: null } }],
  ['non-string names', { ...LISTED, datasets: { ...LISTED.datasets, names: [null] } }],
  ['a missing list text', { ...LISTED, datasets: { state: 'list', names: [] } }],
  ['a files object', { ...LISTED, files: {} }],
  ['an unknown files state', { ...LISTED, files: [{ state: 'busy', names: [], hint: false }] }],
  ['a non-boolean hint', { ...LISTED, files: [{ state: 'list', names: [], hint: 'no' }] }],
])('rejects a snapshot with %s', (_label, value) => {
  expect(() => panelSnapshot(value)).toThrow('Knowledge panel snapshot malformed');
});

it('waits until the panel is open and nothing is loading', async () => {
  const observed: PanelSnapshot[] = [
    { loading: 0, buttons: [], datasets: null, files: [] },
    { ...LISTED, loading: 1, datasets: { state: 'loading', text: '', names: [] } },
    { ...LISTED, loading: 1 },
    LISTED,
  ];
  let reads = 0;
  const settled = await settledPanel(() => Promise.resolve(observed[reads++] ?? LISTED), 5_000);

  expect(settled).toEqual(LISTED);
  expect(reads).toBe(4);
});

it('fails when the panel never settles within the timeout', async () => {
  const loading: PanelSnapshot = { ...LISTED, loading: 1 };

  await expect(settledPanel(() => Promise.resolve(loading), 300)).rejects.toThrow(
    'Stack workbench knowledge panel settled not reached',
  );
});

it('records a step with its state, counts and screenshot only', () => {
  expect(panelStep('files', LISTED, 'kb-files')).toEqual({
    step: 'files',
    state: 'list',
    datasets: 1,
    files: 1,
    screenshot: 'kb-files.png',
  });
  const unconfigured: PanelSnapshot = {
    loading: 0,
    buttons: [],
    datasets: { state: 'not-configured', text: '知识库未配置，请联系管理员', names: [] },
    files: [],
  };
  expect(panelStep('not-configured', unconfigured, 'kb-not-configured')).toEqual({
    step: 'not-configured',
    state: 'not-configured',
    datasets: 0,
    files: 0,
    screenshot: 'kb-not-configured.png',
  });
  expect(() => panelStep('closed', { ...unconfigured, datasets: null }, 'kb-closed')).toThrow(
    'Knowledge panel not open',
  );
});
