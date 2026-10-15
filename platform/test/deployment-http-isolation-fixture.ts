import { expect } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { record } from './container-start-docker-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Employee {
  id: string;
  cookie: string;
}

export async function verifyHttpIsolation(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  a: Employee,
  b: Employee,
  admin: { cookie: string },
) {
  const gateway = instanceGatewayFixture({
    base: deployment.base,
    origin: deployment.base,
    lifecycle,
  });
  const filename = `isolation-${lifecycle.runId}.txt`;
  const onlyA = `only-a-${lifecycle.runId}.txt`;
  const create = async (user: typeof a) => {
    await gateway.state(user.cookie, true);
    await gateway.ready(user.cookie);
    const session = await gateway.rpc(user.cookie, 'session/create', {
      request: { cwd: '/data/work', agentPreset: 'office-general' },
    });
    if (typeof session.sessionId !== 'string') throw new Error('Missing native Session');
    const title = `Isolated ${user.id}`;
    await gateway.rpc(user.cookie, 'session/rename', {
      request: { sessionId: session.sessionId, title },
    });
    const text = `Owned file ${user.id}`;
    await gateway.exec(
      `dsh-team-u-${user.id}`,
      `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(`/data/work/${filename}`)},${JSON.stringify(text)});
${user.id === a.id ? `writeFileSync(${JSON.stringify(`/data/work/${onlyA}`)},${JSON.stringify(text)});` : ''}`,
    );
    return { ...user, sessionId: session.sessionId, title, text };
  };
  const download = async (cookie: string, path: string, headers = {}) => {
    const response = await fetch(`${deployment.base}${path}`, {
      headers: { cookie, ...headers },
      redirect: 'manual',
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    const first = await create(a);
    const second = await create(b);
    expect(first.sessionId).not.toBe(second.sessionId);
    const filePath = `/api/file?path=${encodeURIComponent(`/data/work/${filename}`)}`;
    const privatePath = `/api/file?path=${encodeURIComponent(`/data/work/${onlyA}`)}`;
    for (const user of [first, second]) {
      expect((await gateway.rpc(user.cookie, 'session/list', { _request: {} })).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: user.sessionId })]),
      );
      expect(
        await gateway.rpcResult(user.cookie, 'session/projections', {
          request: { sessionId: user.sessionId },
        }),
      ).toMatchObject({ ok: true, value: { values: { title: user.title } } });
      const listing = await gateway.rpc(user.cookie, 'workspaceFiles/list', {
        workspaceFileScopeId: user.sessionId,
        path: '.',
      });
      expect(listing.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: filename })]),
      );
      expect(listing.truncated).toBe(false);
      expect(
        await gateway.rpc(user.cookie, 'workspaceFiles/read', {
          workspaceFileScopeId: user.sessionId,
          path: filename,
          range: {},
        }),
      ).toMatchObject({ text: user.text });
      expect(await download(user.cookie, filePath)).toEqual({ status: 200, text: user.text });
    }
    expect(await download(a.cookie, privatePath)).toEqual({ status: 200, text: first.text });
    const headers = {
      forwarded: `for=203.0.113.99;host=dsh-team-u-${a.id};proto=https`,
      'x-forwarded-for': '203.0.113.99',
      'x-forwarded-host': `dsh-team-u-${a.id}`,
      'x-forwarded-proto': 'https',
      'x-user-id': a.id,
      'x-session-id': first.sessionId,
      'x-user-role': 'admin',
      'x-original-url': privatePath,
      'x-rewrite-url': privatePath,
    };
    const query = `?userId=${a.id}&sessionId=${first.sessionId}`;
    const hostile = (method: string, args: unknown) =>
      gateway.rpcResult(b.cookie, method, args, { query, headers });
    expect(await hostile('session/list', { _request: {}, userId: a.id })).toMatchObject({
      ok: false,
      error: { code: 'gateway/arguments-invalid' },
    });
    const listed = await hostile('session/list', { _request: {} });
    expect(listed.ok).toBe(true);
    expect(record(listed.value).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: second.sessionId })]),
    );
    expect(JSON.stringify(listed)).not.toContain(first.sessionId);
    expect(JSON.stringify(listed)).not.toContain(first.title);
    expect(
      await hostile('session/projections', {
        request: { sessionId: first.sessionId },
      }),
    ).toEqual({ ok: true, value: null });
    const files = await hostile('workspaceFiles/list', {
      workspaceFileScopeId: second.sessionId,
      path: '.',
    });
    expect(files).toMatchObject({ ok: true, value: { truncated: false } });
    expect(JSON.stringify(files)).not.toContain(onlyA);
    expect(
      await hostile('workspaceFiles/read', {
        workspaceFileScopeId: second.sessionId,
        path: filename,
        range: {},
      }),
    ).toMatchObject({ ok: true, value: { text: second.text } });
    for (const method of ['workspaceFiles/list', 'workspaceFiles/read']) {
      const denied = await hostile(method, {
        workspaceFileScopeId: first.sessionId,
        path: method.endsWith('/list') ? '.' : onlyA,
        ...(method.endsWith('/read') ? { range: {} } : {}),
      });
      expect(denied.ok).toBe(false);
      expect(JSON.stringify(denied)).toContain('gateway/lookup-not-found');
      expect(JSON.stringify(denied)).not.toContain(first.text);
    }
    expect(
      await download(b.cookie, `${filePath}&userId=${a.id}&sessionId=${first.sessionId}`, headers),
    ).toEqual({ status: 200, text: second.text });
    expect(await download(b.cookie, privatePath, headers)).toMatchObject({ status: 404 });
    for (const path of [
      `/users/${a.id}/sessions/${first.sessionId}`,
      `/api/users/${a.id}/files/${onlyA}`,
    ]) {
      const response = await download(b.cookie, path, headers);
      expect([200, 400, 403, 404]).toContain(response.status);
      expect(response.text).not.toContain(first.text);
      expect(response.text).not.toContain(first.title);
    }
    const reads = ['users', 'instances', 'audit-events', 'model-config', 'runtime-config'];
    let runtime: unknown;
    for (const path of reads) {
      const response = await fetch(`${deployment.base}/_platform/api/admin/${path}`, {
        headers: { cookie: admin.cookie },
      });
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      if (path === 'runtime-config') runtime = value;
    }
    const routes: [string, string, unknown?][] = [
      ...reads.map((path): [string, string] => ['GET', path]),
      ['PUT', 'model-config', { ...MODEL_CONFIG, apiKey: 'deployment-acceptance-key' }],
      ['PUT', 'runtime-config', runtime],
      ['PUT', `users/${a.id}/status`, { status: 'disabled' }],
      ['PUT', `users/${a.id}/password`, { newPassword: 'isolated-reset-password' }],
      ['POST', `instances/${a.id}/restart`, {}],
      ['POST', 'instances/restart-running', {}],
    ];
    for (const [method, path, body] of routes) {
      const response = await fetch(`${deployment.base}/_platform/api/admin/${path}`, {
        method,
        headers: {
          ...headers,
          cookie: b.cookie,
          origin: deployment.base,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ statusCode: 403 });
    }
    expect(await gateway.state(a.cookie)).toEqual({ status: 'running', reason: null });
    expect(await download(a.cookie, privatePath)).toEqual({ status: 200, text: first.text });
    expect((await gateway.rpc(a.cookie, 'session/list', { _request: {} })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: first.sessionId })]),
    );
  } finally {
    gateway.close();
  }
}
