import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  START_USER,
  startupBarrier,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import { instanceConfig } from '../../test/instance-fixture.ts';
import { writeSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createInstanceService } from './instance-service.ts';

async function fixture() {
  const context = await startupOwnerFixture();
  const service = createInstanceService({
    ...context,
    config: instanceConfig(context.root, context.input.config),
  });
  return {
    ...context,
    service,
    async close() {
      await service.close();
      context.database.close();
      await rm(context.root, { recursive: true, force: true });
    },
  };
}
function configure(database: DatabaseHandle) {
  writeSettings(database, {
    modelBaseUrl: 'http://model.invalid/v1',
    modelApiKey: 'service-key',
    models: [{ name: 'office-model' }],
    defaultModel: 'office-model',
  });
}

it('observes current model completeness and canonical capacity without Docker or durable invented states', async () => {
  const f = await fixture();
  try {
    expect(f.service.status(START_USER)).toEqual({
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    expect(await f.service.start(START_USER)).toEqual({
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    configure(f.database);
    expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
    writeSettings(f.database, { maxRunningInstances: 1 });
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES ('mnopqrstuvwx','starting')")
      .run();
    expect(f.service.status(START_USER)).toEqual({ status: 'full', reason: 'full' });
    expect(await f.service.start(START_USER)).toEqual({ status: 'full', reason: 'full' });
    expect(f.daemon.requests).toEqual([]);
    expect(f.database.prepare('SELECT user_id,status FROM instances').all()).toEqual([
      { user_id: 'mnopqrstuvwx', status: 'starting' },
    ]);
  } finally {
    await f.close();
  }
});

it('pairs the endpoint and credential from the current running row even after model configuration becomes incomplete', async () => {
  const f = await fixture();
  try {
    f.database
      .prepare(
        "INSERT INTO instances(user_id,status,upstream_host,upstream_port,dsh_cookie,last_error) VALUES (?, 'running','127.0.0.1',49173,'backend-cookie','private-diagnostic')",
      )
      .run(START_USER);
    expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
    expect(f.service.resolveUpstream(START_USER)).toEqual({
      outcome: 'running',
      host: '127.0.0.1',
      port: 49173,
      cookie: 'backend-cookie',
    });
    expect(await f.service.start(START_USER)).toEqual({
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    f.database
      .prepare("UPDATE instances SET upstream_port=49174,dsh_cookie='replacement-cookie'")
      .run();
    expect(f.service.resolveUpstream(START_USER)).toEqual({
      outcome: 'running',
      host: '127.0.0.1',
      port: 49174,
      cookie: 'replacement-cookie',
    });
    f.database.prepare('UPDATE instances SET dsh_cookie=NULL').run();
    expect(f.service.status(START_USER)).toEqual({ status: 'error', reason: 'error' });
    expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'error' });
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it('reuses a held startup flight and settles actual work before closing admission', async () => {
  const f = await fixture();
  const gate = startupBarrier();
  try {
    configure(f.database);
    f.beforeRequest(async (method, path) => {
      if (method === 'GET' && path.startsWith('/images/')) await gate.hold();
      return undefined;
    });
    f.daemon.overrides.set('GET /images/dsh-team-user%3Alocal/json', { status: 500 });
    const first = f.service.start(START_USER);
    const observed = expect(first).rejects.toThrow('Instance operation failed');
    await gate.reached;
    const repeated = expect(f.service.start(START_USER)).rejects.toThrow(
      'Instance operation failed',
    );
    expect(f.service.status(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'starting' });
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await expect(f.service.start('mnopqrstuvwx')).rejects.toThrow('Instance service unavailable');
    await expect(f.service.reconcile()).rejects.toThrow('Instance service unavailable');
    expect(closed).toBe(false);
    expect(f.database.open).toBe(true);
    gate.release();
    await observed;
    await repeated;
    await closing;
    expect(() => f.service.status(START_USER)).toThrow('Instance operation failed');
    expect(() => f.service.resolveUpstream(START_USER)).toThrow('Instance operation failed');
    expect(f.database.open).toBe(true);
  } finally {
    gate.release();
    await f.close();
  }
});

it('retains durable starting and error states and settles failed reconciliation without fake success', async () => {
  const f = await fixture();
  try {
    f.database.prepare("INSERT INTO instances(user_id,status) VALUES (?, 'error')").run(START_USER);
    expect(f.service.status(START_USER)).toEqual({ status: 'error', reason: 'error' });
    f.database.prepare("UPDATE instances SET status='starting'").run();
    expect(f.service.status(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    f.beforeRequest((_method, path) => {
      if (path.startsWith('/containers/json')) throw new Error('private-discovery-diagnostic');
      return Promise.resolve(undefined);
    });
    await expect(f.service.reconcile()).rejects.toThrow('Instance reconciliation failed');
    await f.service.close();
    expect(f.database.open).toBe(true);
  } finally {
    await f.close();
  }
});

it('reuses a verified running identity and admits starting without awaiting readiness failure cleanup', async () => {
  const f = await fixture();
  try {
    await f.service.reconcile();
    configure(f.database);
    expect(await f.service.start(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    await f.service.close();
    expect(f.service.status(START_USER)).toEqual({ status: 'error', reason: 'error' });
    expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'error' });
    expect(f.database.prepare('SELECT status,dsh_cookie FROM instances').get()).toEqual({
      status: 'error',
      dsh_cookie: null,
    });
  } finally {
    await f.close();
  }
});

it('validates running reuse through the owner without duplicate readiness or startup writes', async () => {
  const f = await fixture();
  try {
    configure(f.database);
    await f.owner.startUserContainer(f.input);
    f.database.prepare("UPDATE instances SET status='running',dsh_cookie='trusted-cookie'").run();
    const before = f.database.prepare('SELECT * FROM instances').get();
    const audit = f.database.prepare('SELECT * FROM audit_events').all();
    expect(await f.service.start(START_USER)).toEqual({ status: 'running', reason: null });
    expect(f.database.prepare('SELECT * FROM instances').get()).toEqual(before);
    expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audit);
    expect(f.daemon.requests.some(({ path }) => path.includes('follow=true'))).toBe(false);
    f.database.prepare('UPDATE instances SET dsh_cookie=NULL').run();
    expect(await f.service.start(START_USER)).toEqual({ status: 'error', reason: 'error' });
  } finally {
    await f.close();
  }
});

it('does not silently report starting when readiness error persistence failed and forgets the failure for a replacement identity', async () => {
  const f = await fixture();
  try {
    configure(f.database);
    f.database.exec(
      "CREATE TRIGGER reject_error BEFORE UPDATE ON instances WHEN NEW.status='error' BEGIN SELECT RAISE(ABORT,'private-persistence-diagnostic'); END",
    );
    expect(await f.service.start(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    await f.service.close();
    expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({
      status: 'starting',
    });
    expect(() => f.service.status(START_USER)).toThrow('Instance operation failed');
    expect(() => f.service.resolveUpstream(START_USER)).toThrow('Instance operation failed');
    f.database.exec('DROP TRIGGER reject_error');
    f.database
      .prepare(
        "UPDATE instances SET container_id=?,status='running',dsh_cookie='new-identity-cookie'",
      )
      .run('d'.repeat(64));
    expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
    expect(f.service.resolveUpstream(START_USER)).toEqual({
      outcome: 'running',
      host: '127.0.0.1',
      port: 49173,
      cookie: 'new-identity-cookie',
    });
  } finally {
    await f.close();
  }
});

it('clears a no-row failure observation when an explicit new admission is attempted', async () => {
  const f = await fixture();
  try {
    configure(f.database);
    f.daemon.overrides.set('GET /images/dsh-team-user%3Alocal/json', { status: 500 });
    await expect(f.service.start(START_USER)).rejects.toThrow('Instance operation failed');
    expect(() => f.service.status(START_USER)).toThrow('Instance operation failed');
    writeSettings(f.database, { modelApiKey: '' });
    expect(await f.service.start(START_USER)).toEqual({
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    expect(f.service.status(START_USER)).toEqual({
      status: 'unconfigured',
      reason: 'unconfigured',
    });
  } finally {
    await f.close();
  }
});

it('retains admitted readiness failure identity when even the catch-time database read fails', async () => {
  const f = await fixture();
  const storage = { renamed: false };
  try {
    configure(f.database);
    f.daemon.beforeRequest(({ path }) => {
      if (!storage.renamed && path.includes('follow=true')) {
        f.database.exec('ALTER TABLE instances RENAME TO unavailable_instances');
        storage.renamed = true;
      }
    });
    expect(await f.service.start(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    await f.service.close();
    expect(storage.renamed).toBe(true);
    f.database.exec('ALTER TABLE unavailable_instances RENAME TO instances');
    storage.renamed = false;
    expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({
      status: 'starting',
    });
    expect(() => f.service.status(START_USER)).toThrow('Instance operation failed');
    expect(() => f.service.resolveUpstream(START_USER)).toThrow('Instance operation failed');
  } finally {
    if (storage.renamed) f.database.exec('ALTER TABLE unavailable_instances RENAME TO instances');
    await f.close();
  }
});
