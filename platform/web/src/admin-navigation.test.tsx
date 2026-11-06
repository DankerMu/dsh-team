// @vitest-environment jsdom

import { expect, it } from 'vitest';
import { element, renderAccountPage } from '../test/account-dom-fixture.tsx';
import { AdminNavigation } from './admin-navigation.tsx';

it.each([
  'accounts',
  'instances',
  'audit',
  'models',
  'runtime',
  'plugins',
  'knowledge-base',
  'office',
] as const)('offers implemented pages with only %s active', (page) => {
  const { view } = renderAccountPage(<AdminNavigation page={page} />, '/_platform/admin');

  const accounts = element(view, 'a[href="/_platform/admin"]', HTMLAnchorElement);
  const instances = element(view, 'a[href="/_platform/admin/instances"]', HTMLAnchorElement);
  const audit = element(view, 'a[href="/_platform/admin/audit"]', HTMLAnchorElement);
  const models = element(view, 'a[href="/_platform/admin/models"]', HTMLAnchorElement);
  const runtime = element(view, 'a[href="/_platform/admin/runtime"]', HTMLAnchorElement);
  const plugins = element(view, 'a[href="/_platform/admin/plugins"]', HTMLAnchorElement);
  const knowledgeBase = element(
    view,
    'a[href="/_platform/admin/knowledge-base"]',
    HTMLAnchorElement,
  );
  const office = element(view, 'a[href="/_platform/admin/office"]', HTMLAnchorElement);
  expect(accounts.getAttribute('aria-current')).toBe(page === 'accounts' ? 'page' : null);
  expect(instances.getAttribute('aria-current')).toBe(page === 'instances' ? 'page' : null);
  expect(audit.getAttribute('aria-current')).toBe(page === 'audit' ? 'page' : null);
  expect(models.getAttribute('aria-current')).toBe(page === 'models' ? 'page' : null);
  expect(runtime.getAttribute('aria-current')).toBe(page === 'runtime' ? 'page' : null);
  expect(plugins.getAttribute('aria-current')).toBe(page === 'plugins' ? 'page' : null);
  expect(knowledgeBase.getAttribute('aria-current')).toBe(
    page === 'knowledge-base' ? 'page' : null,
  );
  expect(office.getAttribute('aria-current')).toBe(page === 'office' ? 'page' : null);
  expect([...view.querySelectorAll('a')].map((link) => link.textContent)).toEqual([
    '账号管理',
    '实例管理',
    '审计日志',
    '模型配置',
    '运行参数',
    '插件目录',
    '知识库',
    'Office',
    '账号设置',
    '返回工作台',
  ]);
});
