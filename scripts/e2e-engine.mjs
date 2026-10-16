import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const owner = spawn(
    '/usr/bin/sudo',
    [
      '-n',
      '/usr/bin/unshare',
      '--fork',
      '--pid',
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
    ],
    {
      cwd: root,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    owner.stdin.end();
  };
  // The pipe is the lifetime capability; EOF also arrives after this process is SIGKILLed.
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  owner.stdin.on('error', () => {
    // The owner may close its read end first; its actual close status remains authoritative.
  });
  owner.on('error', () => {
    process.stderr.write('e2e: cannot acquire private Engine ownership\n');
  });
  owner.once('close', (code) => {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    process.exitCode = cancelled ? 1 : (code ?? 1);
  });
}
