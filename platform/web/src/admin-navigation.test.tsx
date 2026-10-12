// @vitest-environment jsdom

import { expect, it } from 'vitest';
import { element, renderAccountPage } from '../test/account-dom-fixture.tsx';
import { AdminNavigation } from './admin-navigation.tsx';

it.each(['accounts', 'audit'] as const)(
  'offers both implemented pages with only %s active',
  (page) => {
    const { view } = renderAccountPage(<AdminNavigation page={page} />, '/_platform/admin');

    const accounts = element(view, 'a[href="/_platform/admin"]', HTMLAnchorElement);
    const audit = element(view, 'a[href="/_platform/admin/audit"]', HTMLAnchorElement);
    expect(accounts.textContent).toBe('账号管理');
    expect(audit.textContent).toBe('审计日志');
    expect(accounts.getAttribute('aria-current')).toBe(page === 'accounts' ? 'page' : null);
    expect(audit.getAttribute('aria-current')).toBe(page === 'audit' ? 'page' : null);
    expect(element(view, 'a[href="/_platform/account"]', HTMLAnchorElement).textContent).toBe(
      '账号设置',
    );
    expect(element(view, 'a[href="/"]', HTMLAnchorElement).textContent).toBe('返回工作台');
  },
);
