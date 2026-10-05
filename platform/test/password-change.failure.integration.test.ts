import { describe, expect, it } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import { sessionCookieToken, tableCounts } from './auth-fixture.ts';
import {
  expectNoSecrets,
  getIdentity,
  PASSWORD,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import {
  BACKDATE_ACTIVITY,
  changePassword,
  NEW_PASSWORD,
  snapshotPasswordState,
} from './password-change-fixture.ts';

const EMAIL = 'user@example.com';
const FAULT = 'password-change-write-aborted';
const WRITE_FAULTS = [
  { label: 'password update', write: 'UPDATE OF password_hash ON users' },
  { label: 'session deletion', write: 'DELETE ON platform_sessions' },
  { label: 'replacement session insertion', write: 'INSERT ON platform_sessions' },
  { label: 'audit insertion', write: 'INSERT ON audit_events' },
] as const;

describe('password-change atomic writes over a real TCP port', () => {
  it.each(WRITE_FAULTS)('rolls back $label and permits a clean retry', async ({ write }) => {
    await withListeningApp(async (baseUrl, app, database, lines) => {
      const identity = await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);
      database.exec(
        `CREATE TEMP TRIGGER abort_change BEFORE ${write} BEGIN SELECT RAISE(ABORT, '${FAULT}'); END`,
      );
      try {
        const rejected = await changePassword(baseUrl, `platform_session=${login.token}`);

        expect(rejected.status).toBe(500);
        expect(await rejected.json()).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: FAULT,
        });
        expect(rejected.headers.getSetCookie()).toEqual([]);
        expect(snapshotPasswordState(database)).toEqual(before);
        expect(database.inTransaction).toBe(false);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });

        database.exec('DROP TRIGGER abort_change');
        const retry = await changePassword(baseUrl, `platform_session=${login.token}`);
        expect(retry.status).toBe(204);
        expect(await retry.text()).toBe('');
        expect(retry.headers.getSetCookie()).toHaveLength(1);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 3 });
        const freshToken = sessionCookieToken(retry.headers.getSetCookie());
        const recognized = await getIdentity(baseUrl, `platform_session=${freshToken}`);
        expect(recognized.status).toBe(200);
        expect(await recognized.json()).toEqual(identity);
        expect((await getIdentity(baseUrl, `platform_session=${login.token}`)).status).toBe(401);
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'password.changed',
        });
        expect(events).toEqual([
          expect.objectContaining({
            actorEmail: EMAIL,
            targetEmail: EMAIL,
            target: identity.id,
            details: {},
          }),
        ]);
        expectNoSecrets(lines, events, [PASSWORD, NEW_PASSWORD, login.token, freshToken]);
      } finally {
        database.exec('DROP TRIGGER IF EXISTS abort_change');
      }
    });
  });
});
