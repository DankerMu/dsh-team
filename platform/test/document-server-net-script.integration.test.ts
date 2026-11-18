import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../deploy/document-server-net.sh', import.meta.url));
// Logs each call with whether the marker already exists; STUB_FAIL fails one `<tool> <option>`,
// STUB_ACCEPT makes that tool's `-S` report an ACCEPT policy.
const IPTABLES = `#!/bin/sh
tool=\${0##*/}
ready=0; [ -e "$DSH_TEAM_FIREWALL_READY" ] && ready=1
echo "$ready $tool $*" >> "$STUB_LOG"
[ "$tool $1" = "\${STUB_FAIL:-}" ] && exit 1
if [ "$1" = -S ]; then
  if [ "$tool" = "\${STUB_ACCEPT:-}" ]; then echo '-P INPUT ACCEPT'; else echo '-P INPUT DROP'; fi
fi
exit 0
`;
const MATCHES = ['-i lo', '-m conntrack --ctstate ESTABLISHED,RELATED', '-p tcp --dport 80'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every call the holder must make for `tool`, in order, all before the marker exists. */
const calls = (tool: string, matches: string[]) => [
  ...matches.map((match) => `0 ${tool} -A INPUT ${match} -j ACCEPT`),
  `0 ${tool} -P INPUT DROP`,
  ...matches.map((match) => `0 ${tool} -C INPUT ${match} -j ACCEPT`),
  `0 ${tool} -S INPUT`,
];
const V4 = calls('iptables', MATCHES);
const V6 = calls('ip6tables', [...MATCHES, '-p ipv6-icmp']);

/** Runs the script against stubs; once the marker appears it sends SIGTERM, as `docker stop` does. */
async function holder(options: { ipv6: boolean; env?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-holder-'));
  roots.push(root);
  for (const [name, body] of [
    ['iptables', IPTABLES],
    ['ip6tables', IPTABLES],
    // GNU `sleep infinity` stand-in that also exists on macOS.
    ['sleep', '#!/bin/sh\nexec /bin/sleep 1000\n'],
  ] as const) {
    writeFileSync(join(root, name), body);
    chmodSync(join(root, name), 0o755);
  }
  const ready = join(root, 'firewall-ready');
  const ifInet6 = join(root, 'if_inet6');
  if (options.ipv6) writeFileSync(ifInet6, '');
  const log = join(root, 'log');
  writeFileSync(log, '');
  const env = { PATH: `${root}:/usr/bin:/bin`, STUB_LOG: log, ...options.env };
  const child = spawn('/bin/sh', [SCRIPT], {
    env: { ...env, DSH_TEAM_FIREWALL_READY: ready, DSH_TEAM_IF_INET6: ifInet6 },
    detached: true,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  const running = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 5_000;
  while (running() && !existsSync(ready) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const held = running() && existsSync(ready);
  if (held) child.kill('SIGTERM');
  await exited;
  const [code, signal] = [child.exitCode, child.signalCode];
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the held `sleep` already ended with its group.
  }
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { held, code, signal, marker: existsSync(ready), lines };
}

it('writes the marker only after every v4 and v6 rule, the DROP policy and each check, then exits 0 on TERM', async () => {
  const result = await holder({ ipv6: true });

  expect(result).toEqual({
    held: true,
    code: 0,
    signal: null,
    marker: true,
    lines: [...V4, ...V6],
  });
});

it('skips IPv6 only when the kernel has no IPv6', async () => {
  const result = await holder({ ipv6: false });

  expect(result).toEqual({ held: true, code: 0, signal: null, marker: true, lines: V4 });
});

it.each([
  ['an IPv4 append', { STUB_FAIL: 'iptables -A' }, 1],
  ['the IPv4 policy', { STUB_FAIL: 'iptables -P' }, 4],
  ['an IPv4 check', { STUB_FAIL: 'iptables -C' }, 5],
  ['an IPv4 policy readback', { STUB_ACCEPT: 'iptables' }, V4.length],
  ['an IPv6 append', { STUB_FAIL: 'ip6tables -A' }, V4.length + 1],
  ['an IPv6 check', { STUB_FAIL: 'ip6tables -C' }, V4.length + 6],
  ['an IPv6 policy readback', { STUB_ACCEPT: 'ip6tables' }, V4.length + V6.length],
])('fails without the marker on %s', async (_step, env, made) => {
  const result = await holder({ ipv6: true, env });

  expect(result.held).toBe(false);
  expect(result.marker).toBe(false);
  expect(result.code).not.toBe(0);
  expect(result.lines).toEqual([...V4, ...V6].slice(0, made));
});
