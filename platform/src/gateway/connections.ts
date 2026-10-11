import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

type Connection = Duplex | ServerResponse;
interface Session {
  userId: string;
  token: string;
}
const RELEASED = () => undefined;

export interface GatewayActivity {
  readonly liveCount: number;
  readonly lastActivityAt: number | null;
}

export function createGatewayConnections(
  onActivity?: (userId: string, lastActivityAt: number) => void,
) {
  const users = new Map<string | undefined, Set<Connection>>();
  const sessions = new Map<string, { userId: string; resources: Set<Connection> }>();
  const releases = new WeakMap<Connection, () => void>();
  const activity = new Map<string, number>();
  let closing = false;

  function observeActivity(userId: string | undefined): void {
    if (userId === undefined) return;
    const now = Math.max(Date.now(), activity.get(userId) ?? -Infinity);
    activity.set(userId, now);
    onActivity?.(userId, now);
  }

  function track(
    session: Session | undefined,
    connection: Connection,
    untilFinish = false,
  ): () => void {
    releases.get(connection)?.();
    if (closing || connection.closed) {
      connection.destroy();
      return RELEASED;
    }
    const userId = session?.userId;
    let sessionGroup = session === undefined ? undefined : sessions.get(session.token);
    if (session !== undefined && sessionGroup === undefined) {
      sessionGroup = { userId: session.userId, resources: new Set() };
      sessions.set(session.token, sessionGroup);
    }
    sessionGroup?.resources.add(connection);
    let group = users.get(userId);
    if (group === undefined) {
      group = new Set();
      users.set(userId, group);
    }
    const owned = group;
    owned.add(connection);
    observeActivity(userId);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      connection.removeListener('close', release);
      if (untilFinish) connection.removeListener('finish', release);
      releases.delete(connection);
      owned.delete(connection);
      if (owned.size === 0 && users.get(userId) === owned) users.delete(userId);
      sessionGroup?.resources.delete(connection);
      if (
        session !== undefined &&
        sessionGroup?.resources.size === 0 &&
        sessions.get(session.token) === sessionGroup
      )
        sessions.delete(session.token);
      observeActivity(userId);
    };
    releases.set(connection, release);
    connection.once('close', release);
    if (untilFinish) connection.once('finish', release);
    return release;
  }

  async function destroy(group: Set<Connection> | undefined): Promise<void> {
    if (group === undefined) return;
    await Promise.all(
      [...group].map((connection) => {
        if (connection.closed) return Promise.resolve();
        const closed = Promise.withResolvers<undefined>();
        connection.once('close', () => {
          closed.resolve(undefined);
        });
        connection.destroy();
        return closed.promise;
      }),
    );
  }

  return {
    track,
    getUserActivity: (userId: string): GatewayActivity => ({
      liveCount: users.get(userId)?.size ?? 0,
      lastActivityAt: activity.get(userId) ?? null,
    }),
    isClosing: (): boolean => closing,
    disconnectUser: (userId: string): Promise<void> => destroy(users.get(userId)),
    revalidateSessions(isValid: (userId: string, token: string) => boolean): void {
      for (const [token, session] of sessions) {
        if (!isValid(session.userId, token)) {
          for (const connection of session.resources) connection.destroy();
        }
      }
    },
    async close(): Promise<void> {
      closing = true;
      await Promise.all([...users.values()].map(destroy));
    },
  };
}

export type GatewayConnections = ReturnType<typeof createGatewayConnections>;
