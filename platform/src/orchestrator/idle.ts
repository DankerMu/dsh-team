import { createHash } from 'node:crypto';
import type { PlatformConfig } from '../config.ts';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { Orchestrator } from './orchestrator.ts';
import { readTaskState } from './task-state.ts';

export type GetUserActivity = (userId: string) => {
  readonly liveCount: number;
  readonly lastActivityAt: number | null;
};
export interface RuntimeRow {
  status: 'running' | 'starting' | 'stopped' | 'error';
  user_id: string;
  container_id: string | null;
  image_id: string | null;
  image_tag: string | null;
  last_started_at: number | null;
  last_activity_at: number | null;
  last_error: string | null;
  upstream_host: string | null;
  upstream_port: number | null;
  dsh_cookie: string | null;
}
interface IdleObservation {
  readonly containerId: string | null;
  readonly imageId: string | null;
  readonly startedAt: number | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly credentialIdentity: string;
  readonly lastActivityAt: number | null;
  checkedAt: number;
  since?: number;
}
interface IdleDependencies {
  readonly database: DatabaseHandle;
  readonly config: PlatformConfig;
  readonly owner: Pick<Orchestrator, 'checkIdle'>;
  readonly row: (userId: string) => RuntimeRow | undefined;
  readonly hasFlight: (userId: string) => boolean;
  readonly isClosing: () => boolean;
}
export function complete(row: RuntimeRow): row is RuntimeRow & {
  upstream_host: string;
  upstream_port: number;
  dsh_cookie: string;
} {
  return (
    typeof row.upstream_host === 'string' &&
    row.upstream_host.trim() !== '' &&
    Number.isInteger(row.upstream_port) &&
    row.upstream_port !== null &&
    row.upstream_port > 0 &&
    row.upstream_port <= 65535 &&
    typeof row.dsh_cookie === 'string' &&
    row.dsh_cookie.trim() !== ''
  );
}
function sameIdentity(observation: IdleObservation, row: RuntimeRow): boolean {
  return (
    observation.containerId === row.container_id &&
    observation.imageId === row.image_id &&
    observation.startedAt === row.last_started_at &&
    observation.host === row.upstream_host &&
    observation.port === row.upstream_port
  );
}
function sameRow(left: RuntimeRow | undefined, right: RuntimeRow): boolean {
  return (
    left?.status === right.status &&
    left.user_id === right.user_id &&
    left.container_id === right.container_id &&
    left.image_id === right.image_id &&
    left.image_tag === right.image_tag &&
    left.last_started_at === right.last_started_at &&
    left.last_activity_at === right.last_activity_at &&
    left.last_error === right.last_error &&
    left.upstream_host === right.upstream_host &&
    left.upstream_port === right.upstream_port &&
    left.dsh_cookie === right.dsh_cookie
  );
}

/** Continuity and probe ownership only. All lifecycle work stays in the original owner FIFO. */
export class IdleChecks {
  private readonly input: IdleDependencies;
  private readonly idle = new Map<string, IdleObservation>();
  private readonly retiring = new Map<string, IdleObservation>();
  private readonly abort = new AbortController();
  private readonly account;
  private readonly users;
  private sweep: Promise<void> | undefined;

  constructor(input: IdleDependencies) {
    this.input = input;
    this.account = input.database.prepare<[string], { status: string }>(
      'SELECT status FROM users WHERE id = ?',
    );
    this.users = input.database.prepare<[], { user_id: string }>(
      `SELECT instances.user_id FROM instances JOIN users ON users.id = instances.user_id WHERE instances.status = 'running' AND users.status = 'active' ORDER BY instances.user_id`,
    );
  }

  invalidate(userId: string): void {
    // Every event matters, including a short request or start at the same timestamp.
    this.idle.delete(userId);
  }

  isRetiring(userId: string, row: RuntimeRow | undefined): boolean {
    const fence = this.retiring.get(userId);
    // Credentials/endpoints can change without replacing the physical container already stopping.
    return (
      fence !== undefined &&
      row?.status === 'running' &&
      fence.containerId === row.container_id &&
      fence.imageId === row.image_id &&
      fence.startedAt === row.last_started_at
    );
  }

  close(): Promise<void> {
    this.abort.abort();
    return this.sweep ?? Promise.resolve();
  }

  readonly checkIdle = (getActivity: GetUserActivity): Promise<void> => {
    if (this.input.isClosing()) return Promise.reject(new Error('Instance service unavailable'));
    if (this.sweep !== undefined) return this.sweep;
    const work = this.traverse(getActivity);
    this.sweep = work;
    void work
      .finally(() => {
        if (this.sweep === work) this.sweep = undefined;
      })
      .catch(() => undefined);
    return work;
  };

  private async traverse(getActivity: GetUserActivity): Promise<void> {
    const users = this.users.all();
    const active = new Set(users.map((user) => user.user_id));
    for (const userId of this.idle.keys()) if (!active.has(userId)) this.idle.delete(userId);
    let index = 0;
    const outcome = { failed: false };
    // Independent bounded workers, not another lifecycle queue.
    await Promise.all(
      Array.from({ length: Math.min(4, users.length) }, async () => {
        while (!this.input.isClosing()) {
          const user = users[index++];
          if (user === undefined) break;
          try {
            await this.checkUser(user.user_id, getActivity);
          } catch {
            this.idle.delete(user.user_id);
            outcome.failed = true;
          }
        }
      }),
    );
    if (outcome.failed) throw new Error('Idle instance check failed');
  }

  private observeIdle(
    userId: string,
    initial: RuntimeRow,
    credentialIdentity: string,
    lastActivityAt: number | null,
    now: number,
  ): IdleObservation {
    let receipt = this.idle.get(userId);
    if (
      receipt === undefined ||
      !sameIdentity(receipt, initial) ||
      receipt.credentialIdentity !== credentialIdentity ||
      now < receipt.checkedAt ||
      lastActivityAt !== receipt.lastActivityAt
    ) {
      receipt = {
        containerId: initial.container_id,
        imageId: initial.image_id,
        startedAt: initial.last_started_at,
        host: initial.upstream_host,
        port: initial.upstream_port,
        credentialIdentity,
        checkedAt: now,
        lastActivityAt,
      };
      this.idle.set(userId, receipt);
    }
    return receipt;
  }

  private async checkUser(userId: string, getActivity: GetUserActivity): Promise<void> {
    const { row, hasFlight, isClosing, database, config, owner } = this.input;
    const initial = row(userId);
    if (
      initial?.status !== 'running' ||
      !complete(initial) ||
      initial.container_id === null ||
      initial.image_id === null ||
      hasFlight(userId)
    ) {
      this.idle.delete(userId);
      return;
    }
    const { upstream_host: host, upstream_port: port, dsh_cookie: cookie } = initial;
    // Credential replacement invalidates continuity without retaining its secret in the receipt.
    const credentialIdentity = createHash('sha256').update(cookie).digest('hex');
    const live = getActivity(userId);
    const now = Date.now();
    const captured = this.observeIdle(
      userId,
      initial,
      credentialIdentity,
      live.lastActivityAt,
      now,
    );
    if (live.liveCount !== 0) {
      this.idle.delete(userId);
      return;
    }
    const deadline = new AbortController();
    // Bound FIFO waiting too: an unhealthy user cannot indefinitely consume a traversal worker.
    const timer = setTimeout(() => {
      deadline.abort();
    }, 5_000);
    const signal = AbortSignal.any([this.abort.signal, deadline.signal]);
    const retirement = { admitted: false };
    const unchanged = () => {
      const currentActivity = getActivity(userId);
      return (
        !isClosing() &&
        !signal.aborted &&
        this.idle.get(userId) === captured &&
        !hasFlight(userId) &&
        sameRow(row(userId), initial) &&
        currentActivity.liveCount === 0 &&
        currentActivity.lastActivityAt === live.lastActivityAt &&
        this.account.get(userId)?.status === 'active'
      );
    };
    const due = () => {
      const decisionAt = Date.now();
      return (
        captured.since !== undefined &&
        decisionAt >= captured.checkedAt &&
        unchanged() &&
        (decisionAt - captured.since) / 60_000 >= readSettings(database).idleMinutes
      );
    };
    try {
      await owner.checkIdle({
        userId,
        signal,
        eligible: async () => {
          if (!unchanged()) {
            this.idle.delete(userId);
            return false;
          }
          readSettings(database);
          const tasks = await readTaskState({
            host,
            port,
            cookie,
            authority: config.authority,
            publicUrl: config.publicUrl,
            signal,
          });
          const decisionAt = Date.now();
          if (tasks !== 'idle' || !unchanged() || decisionAt < captured.checkedAt) {
            this.idle.delete(userId);
            return false;
          }
          captured.checkedAt = decisionAt;
          captured.since ??= decisionAt;
          return due();
        },
        onRetiring: () => {
          // Atomic synchronous final admission after the owner's await eligible() boundary.
          if (!due()) {
            this.idle.delete(userId);
            return undefined;
          }
          retirement.admitted = true;
          this.retiring.set(userId, captured);
          this.idle.delete(userId);
          return () => {
            if (this.retiring.get(userId) === captured) this.retiring.delete(userId);
          };
        },
      });
    } catch {
      this.idle.delete(userId);
      if (retirement.admitted || !signal.aborted) throw new Error('Idle instance check failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
