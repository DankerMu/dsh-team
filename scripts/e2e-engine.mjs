import { spawn } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinVerificationProducer } from './verification-producer.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'linux' || process.getuid?.() === 0) {
  process.stderr.write('e2e: requires nonroot Linux with private Engine namespace prerequisites\n');
  process.exitCode = 1;
} else {
  const uid = process.getuid();
  const gid = process.getgid();
  const path = process.env.PATH;
  const home = process.env.HOME;
  if (!path || !home) throw new Error('e2e: caller toolchain environment unavailable');
  const callerNetwork = await readlink('/proc/self/ns/net');
  let owner;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    owner?.stdin.end();
  };
  const parentLifetime = process.env.DSH_TEAM_E2E_PARENT_LIFETIME === '1';
  const releaseParent = () => {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    if (parentLifetime) {
      process.stdin.off('end', cancel);
      process.stdin.off('error', cancel);
      process.stdin.destroy();
    }
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  if (parentLifetime) {
    // Only an explicitly owned caller opts in; standalone e2e does not adopt terminal stdin.
    process.stdin.once('end', cancel);
    process.stdin.on('error', cancel);
    process.stdin.resume();
  }
  try {
    // Privileged work cannot begin before durable invocation/birth admission.
    const producer = await joinVerificationProducer(cancel);
    if (cancelled) {
      releaseParent();
      producer?.complete(true);
      process.exitCode = 1;
    } else {
      owner = spawn(
        '/usr/bin/sudo',
        [
          '-n',
          '/usr/bin/unshare',
          '--fork',
          '--pid',
          '--net',
          '--mount-proc',
          '--propagation',
          'private',
          '--kill-child=SIGKILL',
          '/usr/bin/python3',
          join(root, 'scripts/e2e-engine-supervisor.py'),
          String(uid),
          String(gid),
          path,
          home,
          callerNetwork,
          ...(producer ? [producer.nonce] : []),
        ],
        {
          cwd: root,
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
          stdio: ['pipe', producer ? 'pipe' : 'inherit', 'inherit'],
        },
      );
      let cleanupConfirmed = false;
      if (producer) {
        const marker = Buffer.from(`\ne2e: runtime-retired ${producer.nonce}\n`);
        let tail = Buffer.alloc(0);
        let outputAvailable = true;
        // Invoking-worker death closes its stdout reader too. Drain the canonical owner anyway.
        process.stdout.on('error', () => {
          outputAvailable = false;
          owner.stdout.resume();
          cancel();
        });
        const forward = (bytes) => {
          if (bytes.length > 0 && outputAvailable && !process.stdout.write(bytes)) {
            owner.stdout.pause();
            process.stdout.once('drain', () => owner.stdout.resume());
          }
        };
        owner.stdout.on('data', (chunk) => {
          const observed = Buffer.concat([tail, chunk]);
          let start = 0;
          let index;
          while ((index = observed.indexOf(marker, start)) !== -1) {
            forward(observed.subarray(start, index));
            cleanupConfirmed = true;
            start = index + marker.length;
          }
          const remaining = observed.subarray(start);
          const boundary = Math.max(0, remaining.length - marker.length + 1);
          forward(remaining.subarray(0, boundary));
          // Hold only the possible protocol suffix; all ordinary bytes retain exact order.
          tail = remaining.subarray(boundary);
        });
        owner.stdout.once('end', () => forward(tail));
      }
      // The existing supervisor pipe remains the sole privileged lifetime capability.
      owner.stdin.on('error', () => {
        // The owner may close its read end first; its actual close status remains authoritative.
      });
      owner.on('error', () => {
        process.stderr.write('e2e: cannot acquire private Engine ownership\n');
      });
      owner.once('close', (code) => {
        releaseParent();
        producer?.complete(cleanupConfirmed);
        process.exitCode = cancelled ? 1 : (code ?? 1);
      });
    }
  } catch {
    releaseParent();
    process.stderr.write('e2e: cannot acquire invocation lifetime ownership\n');
    process.exitCode = 1;
  }
}
