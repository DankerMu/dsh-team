import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { snapshotAuthState } from './auth-fixture.ts';

it('refuses incompatible stored accounts before Docker and preserves the file database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-email-'));
  const socket = join(directory, 'engine.sock');
  let requests = 0;
  const engine = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  engine.listen(socket);
  await once(engine, 'listening');
  const path = join(directory, 'platform.db');
  const email = `a\0${'x'.repeat(251)}@b`;
  const database = openDatabase(path);
  try {
    applyMigrations(database);
    database
      .prepare("INSERT INTO users VALUES ('oldaccount01', ?, 'unused', 'employee', 'disabled', 1)")
      .run(email);
    database.exec("INSERT INTO platform_sessions VALUES ('historical', 'oldaccount01', 1, 1)");
    database
      .prepare(
        "INSERT INTO audit_events (created_at, event_type, details, actor_email) VALUES (1, 'login.failed', '{}', ?)",
      )
      .run(email);
    const before = {
      users: database.prepare('SELECT * FROM users').all(),
      ...snapshotAuthState(database),
    };
    database.close();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
      {
        cwd: directory,
        env: {
          PLATFORM_HOST: '127.0.0.1',
          PLATFORM_PORT: '8080',
          PLATFORM_LOG_LEVEL: 'silent',
          PLATFORM_PUBLIC_URL: 'http://127.0.0.1:8080',
          PLATFORM_DATA_DIR: directory,
          PLATFORM_DOCKER_SOCKET: socket,
          PLATFORM_UPSTREAM_MODE: 'published-loopback',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 6000,
        killSignal: 'SIGKILL',
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    await once(child, 'close');

    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
    expect(stderr).toContain(
      'Account email exceeds 254 Unicode code points; correct accounts offline before startup',
    );
    expect(stderr).not.toContain(email);
    expect(requests).toBe(0);
    const reopened = openDatabase(path);
    try {
      expect({
        users: reopened.prepare('SELECT * FROM users').all(),
        ...snapshotAuthState(reopened),
      }).toEqual(before);
    } finally {
      reopened.close();
    }
  } finally {
    if (database.open) database.close();
    engine.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      engine.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
