import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  observeAccountUi,
  expectNoBrowserStorage,
  submitPendingAccountForm,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import {
  ADMIN_UI_PASSWORD,
  withAdminUi,
  readAuditSnapshot,
  expectAuditUnchanged,
} from './admin-ui-fixture.ts';
import { startupUnixOwnerFixture } from './container-start-fixture.ts';
import { configureInstanceModel } from './instance-fixture.ts';

const PAGE = '/_platform/admin/instances';
const API = '/_platform/api/admin/instances';

test('built instance page renders five real persisted states, saved safe logs and local filtering without mutations', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, seed, target }) => {
    const started = 1_900_000_000_000;
    const active = started + 1_000;
    const error = '启动失败：已保存的安全日志\n<untrusted-markup>';
    const insert = database.prepare(
      'INSERT INTO instances(user_id,status,last_started_at,last_activity_at,last_error) VALUES (?,?,?,?,?)',
    );
    insert.run(target.id, 'error', started, active, error);
    for (const status of ['stopped', 'starting', 'running']) {
      const registered = await seed.post('/_platform/api/register', {
        data: { email: `${status}-instance@example.test`, password: ADMIN_UI_PASSWORD },
      });
      expect(registered.status()).toBe(201);
      insert.run(readPublicIdentity(await registered.json()).id, status, started, active, null);
    }
    const audit = readAuditSnapshot(database);
    const observed = observeAccountUi(page, testInfo, baseUrl, `${baseUrl}${API}`);

    const entry = await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });

    expect(entry?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: '实例管理', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '实例管理' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const status of ['未创建', '已停止', '启动中', '运行中', '出错']) {
      await expect(page.getByRole('cell', { name: status, exact: true })).toBeVisible();
    }
    const failed = page.getByRole('row').filter({ hasText: target.email });
    await expect(failed).toContainText(new Date(started).toLocaleString('zh-CN'));
    await expect(failed).toContainText(new Date(active).toLocaleString('zh-CN'));
    await expect(failed.locator('pre')).toBeHidden();
    await failed.getByText('查看错误日志', { exact: true }).click();
    await expect(failed.locator('pre')).toHaveText(error);
    await expect(failed.locator('pre')).toBeVisible();
    await expect(page.locator('untrusted-markup')).toHaveCount(0);
    await observed.screenshot('instances-states-and-error');
    await page.getByLabel('搜索邮箱').fill('running-instance');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('running-instance@example.test');
    await page.getByLabel('搜索邮箱').fill('no-instance-match');
    await expect(page.getByRole('status')).toHaveText('没有匹配的实例');
    await observed.screenshot('instances-no-match');
    expect(observed.actionRequests).toEqual([{ url: `${baseUrl}${API}`, method: 'GET' }]);
    expect(observed.otherMutations).toEqual([]);
    expectAuditUnchanged(database, audit);
    await expectNoBrowserStorage(page);
    observed.expectHealthy([]);
  });
});

test('confirmed browser restart and reset execute real service admission and audit with an owned Engine dependency', async ({
  page,
  playwright,
}, testInfo) => {
  const engine = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-instance-ui-',
    users: {},
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  try {
    await withAdminUi(
      playwright,
      page,
      async ({ baseUrl, database, target, admin }) => {
        configureInstanceModel(database);
        database
          .prepare(
            "INSERT INTO instances(user_id,status,last_error) VALUES (?,'error','启动失败：安全日志')",
          )
          .run(target.id);
        engine.daemon.overrides.set(`GET /volumes/dsh-team-home-${target.id}`, {
          status: 200,
          document: { Name: `dsh-team-home-${target.id}`, Labels: { 'dsh-team.user': target.id } },
        });
        const list = `${baseUrl}${API}`;
        const restart = `${list}/${target.id}/restart`;
        const reset = `${list}/${target.id}/reset-config`;
        const observed = observeAccountUi(page, testInfo, baseUrl, [list, restart, reset]);
        const beforeSessions = JSON.stringify(
          database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
        );
        const row = page.getByRole('row').filter({ hasText: target.email });
        await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });
        const beforeCancel = readAuditSnapshot(database);
        await row.getByRole('button', { name: '重置配置', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText(
          '会恢复该用户的 DSH 设置，文件和对话保留',
        );
        await expect(page.getByRole('dialog')).toContainText(target.email);
        await observed.screenshot('instances-reset-confirmation');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await row.getByRole('button', { name: '重置配置', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(observed.actionRequests.filter((request) => request.method === 'POST')).toEqual([]);
        expectAuditUnchanged(database, beforeCancel);

        for (const action of ['restart', 'reset-config'] as const) {
          const url = action === 'restart' ? restart : reset;
          const label = action === 'restart' ? '重启' : '重置配置';
          await withAccountUiRouteCleanup(page, async (release) => {
            const held = Promise.withResolvers<undefined>();
            await page.route(
              url,
              async (route) => {
                expect(route.request().method()).toBe('POST');
                expect(route.request().postDataJSON()).toEqual({});
                held.resolve(undefined);
                await release.promise;
                await route.continue();
              },
              { times: 1 },
            );
            await row.getByRole('button', { name: label, exact: true }).click();
            const result = page.waitForResponse(url);
            await page.getByRole('button', { name: '确认', exact: true }).click();
            await held.promise;
            await expect(page.getByRole('button', { name: '正在提交…' })).toBeDisabled();
            await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toBeVisible();
            await expect(page.getByLabel('搜索邮箱')).toBeDisabled();
            await expect(
              row.getByRole('button', {
                name: action === 'restart' ? '重置配置' : '重启',
                exact: true,
              }),
            ).toBeDisabled();
            await submitPendingAccountForm(page, '确认实例操作');
            expect(observed.actionRequests.filter((request) => request.url === url)).toHaveLength(
              1,
            );
            await observed.screenshot(`instances-${action}-pending`);
            release.resolve(undefined);
            const response = await result;
            expect(response.status()).toBe(action === 'restart' ? 200 : 204);
            await response.finished();
            await expect(page.getByRole('dialog')).toHaveCount(0);
          });
          const event = action === 'restart' ? 'instance.restarted' : 'instance.config-reset';
          expect(
            database
              .prepare('SELECT actor_email,target,details FROM audit_events WHERE event_type=?')
              .all(event),
          ).toEqual([{ actor_email: admin.email, target: target.id, details: '{}' }]);
          if (action === 'restart') {
            await expect(page.getByRole('status')).toContainText(['不代表已就绪']);
            // The real service observes this dependency's exhausted token stream, not a fake UI success.
            await expect
              .poll(() =>
                database.prepare('SELECT status FROM instances WHERE user_id=?').get(target.id),
              )
              .toEqual({ status: 'error' });
            await page.getByRole('button', { name: '刷新', exact: true }).click();
            await expect(row).toContainText('出错');
            await row.getByText('查看错误日志', { exact: true }).click();
            const saved = database
              .prepare<[string], { lastError: string | null }>(
                'SELECT last_error AS lastError FROM instances WHERE user_id=?',
              )
              .get(target.id);
            expect(saved?.lastError).toMatch(/^DSH readiness failed/);
            await expect(row.locator('pre')).toHaveText(saved?.lastError ?? '');
          } else {
            await expect(page.getByRole('status')).toContainText(['配置已重置']);
            await expect(row).toContainText('已停止');
            expect(
              database
                .prepare('SELECT status,container_id FROM instances WHERE user_id=?')
                .get(target.id),
            ).toEqual({ status: 'stopped', container_id: null });
          }
        }
        expect(
          JSON.stringify(
            database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
          ) === beforeSessions,
        ).toBe(true);
        expect(engine.daemon.containers.size).toBe(0);
        expect(observed.otherMutations).toEqual([]);
        observed.expectHealthy([]);
        await observed.screenshot('instances-reset-complete');
      },
      { canonicalInstanceService: true, dockerSocketPath: join(engine.root, 'engine.sock') },
    );
  } finally {
    await engine.close();
  }
});
