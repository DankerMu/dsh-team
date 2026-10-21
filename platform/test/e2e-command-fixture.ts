import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { processBirth } from '../../scripts/probe-browser-native.mjs';
import { reserveVerificationProducer } from '../../scripts/verification-producer.mjs';

/** Shared real command boundary for the Docker consumer and custody cancellation evidence. */
export async function runE2e(repositoryRoot: string): Promise<void> {
  const lifetime: { input?: NodeJS.WritableStream } = {};
  const reservation = await reserveVerificationProducer(() => {
    lifetime.input?.end();
  });
  if (reservation?.cancelled) {
    reservation.release();
    throw new Error('Concurrent built-artifact verification failed');
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('pnpm', ['run', 'e2e'], {
      cwd: repositoryRoot,
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // The public command must override this shared socket, not trust an opt-in flag.
        PLATFORM_DOCKER_SOCKET: '/var/run/docker.sock',
        DSH_TEAM_E2E_PARENT_LIFETIME: '1',
        ...reservation?.environment,
        ...(process.env.DSH_TEAM_VERIFICATION_PRODUCERS === undefined
          ? {}
          : {
              DSH_TEAM_VERIFICATION_PRODUCERS: process.env.DSH_TEAM_VERIFICATION_PRODUCERS,
              DSH_TEAM_VERIFICATION_INVOCATION: process.env.DSH_TEAM_VERIFICATION_INVOCATION,
            }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    reservation?.release();
    throw new Error('Concurrent built-artifact verification failed');
  }
  lifetime.input = child.stdin;
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  let output = '';
  const outcome = { expired: false, spawnFailed: false, lifetimeFailed: false };
  child.on('error', () => {
    outcome.spawnFailed = true;
  });
  child.stdin.on('error', () => {
    outcome.lifetimeFailed = true;
  });
  const collect = (chunk: Buffer) => {
    if (output.length < 2 * 1024 * 1024) output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  // Keep the real owner's unchanged 60s startup deadline meaningful.
  const timer = setTimeout(() => {
    outcome.expired = true;
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  }, 45_000);
  child.once('close', () => {
    clearTimeout(timer);
  });
  try {
    if (reservation) {
      try {
        if (child.pid === undefined) throw new Error('Detached root launch unavailable');
        await reservation.bind({ pid: child.pid, birth: await processBirth(child.pid) });
      } catch {
        outcome.lifetimeFailed = true;
        child.stdin.end();
      }
    }
    const code = await closed;
    if (outcome.expired || outcome.spawnFailed || outcome.lifetimeFailed || code !== 0) {
      // Build and hurl output are from this credential-free invocation only.
      process.stderr.write(output);
      throw new Error('Concurrent built-artifact verification failed');
    }
    assert(output.includes('e2e: database schema/migration OK'));
    assert(output.includes('e2e: built artifact served smoke/*.hurl'));
  } finally {
    clearTimeout(timer);
    reservation?.release();
  }
}
