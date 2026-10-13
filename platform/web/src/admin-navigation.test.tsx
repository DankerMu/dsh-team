// @vitest-environment jsdom

import { expect, it } from 'vitest';
import { element, renderAccountPage } from '../test/account-dom-fixture.tsx';
import { AdminNavigation } from './admin-navigation.tsx';

it.each(['accounts', 'audit', 'models'] as const)(
  'offers implemented pages with only %s active',
  (page) => {
    const { view } = renderAccountPage(<AdminNavigation page={page} />, '/_platform/admin');

    const accounts = element(view, 'a[href="/_platform/admin"]', HTMLAnchorElement);
    const audit = element(view, 'a[href="/_platform/admin/audit"]', HTMLAnchorElement);
    const models = element(view, 'a[href="/_platform/admin/models"]', HTMLAnchorElement);
    expect(accounts.getAttribute('aria-current')).toBe(page === 'accounts' ? 'page' : null);
    expect(audit.getAttribute('aria-current')).toBe(page === 'audit' ? 'page' : null);
    expect(models.getAttribute('aria-current')).toBe(page === 'models' ? 'page' : null);
  },
);
