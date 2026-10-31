import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const sandboxScript = join(repoRoot, 'scripts/probe-sandbox.sh');
const WAIT_SECONDS = '7';
const LIFECYCLE_DOCKER_SECONDS = '5';
// The sandbox defines its own bound; the expected value is the contract's, not the script's.
const SANDBOX_DOCKER_SECONDS = '30';
const SPAWN_TIMEOUT_MS = 30_000;
// Each case spawns one bash child; its vitest bound must exceed the child's own deadline.
const CASE_TIMEOUT_MS = 40_000;
const SEPARATOR = '\u001f';

interface DockerReply {
  readonly argv: readonly string[];
  readonly status: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface CaseResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly (readonly string[])[];
  /** Each accepted bounded Docker invocation as `[seconds, ...dockerArgv]`, in order. */
  readonly bounded: readonly (readonly string[])[];
  readonly timeoutViolations: string;
  readonly cleanupFailed: string | undefined;
  readonly waitStatus: string | undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function dockerStub(replies: readonly DockerReply[]): string {
  const branches = replies.map(
    (reply) =>
      `${quote(reply.argv.join(SEPARATOR) + SEPARATOR)}) printf '%s' ${quote(reply.stdout ?? '')}; ` +
      `printf '%s' ${quote(reply.stderr ?? '')} >&2; exit ${String(reply.status)} ;;`,
  );
  return [
    '#!/bin/bash',
    `{ printf '%s\\037' "$@"; printf '\\n'; } >>"$STUB_DOCKER_LOG"`,
    `key="$(printf '%s\\037' "$@")"`,
    'case "$key" in',
    ...branches,
    "*) printf 'docker stub: unexpected call\\n' >&2; exit 99 ;;",
    'esac',
    '',
  ].join('\n');
}

// Accepts only the two bounded forms the probes use, records each accepted call as
// `<seconds> <docker argv>`, then runs the bounded command unchanged.
const TIMEOUT_STUB = [
  '#!/bin/bash',
  'if [ "$1" = --foreground ] && [ "$2" = "$EXPECT_WAIT_SECONDS" ] && [ "$3" = docker ] && [ "$4" = wait ]; then',
  `  { printf '%s\\037' "$2" "\${@:4}"; printf '\\n'; } >>"$STUB_TIMEOUT_LOG"`,
  '  shift 2',
  '  exec "$@"',
  'fi',
  'if [ "$1" = --foreground ] && [ "$2" = --kill-after=5 ] && [ "$3" = "$EXPECT_DOCKER_SECONDS" ] &&',
  '  [ "${4-}" = docker ] && [ "${5-}" != wait ]; then',
  `  { printf '%s\\037' "$3" "\${@:5}"; printf '\\n'; } >>"$STUB_TIMEOUT_LOG"`,
  '  shift 3',
  '  exec "$@"',
  'fi',
  `printf '%s\\n' "$*" >>"$STUB_TIMEOUT_VIOLATIONS"`,
  'exit 98',
  '',
].join('\n');

function header(): string {
  return [
    'set -euo pipefail',
    `repo_root=${quote(repoRoot)}`,
    'probe_name=probe-test',
    'cleanup_failed=0',
    `timeout_seconds=${WAIT_SECONDS}`,
  ].join('\n');
}

// sed prints a line once per matching range; a /^}/ range from the single-line
// note_cleanup_failure would overlap the next function and double its lines.
const SANDBOX_FUNCTIONS =
  '/^note_cleanup_failure()/p; /^absent()/,/^}/p; /^remove_owned()/,/^}/p; /^wait_for_container()/,/^}/p';
const SANDBOX_VARIABLES = '/^run_id=/,/^workdir=""/p';

function lifecycleScript(body: string): string {
  return [
    header(),
    `docker_seconds=${LIFECYCLE_DOCKER_SECONDS}`,
    '. "$repo_root/scripts/probe-dsh-api-lifecycle.sh"',
    body,
    `printf 'cleanup_failed=%s\\n' "$cleanup_failed"`,
  ].join('\n');
}

function sandboxScriptText(body: string): string {
  return [
    header(),
    `eval "$(sed -n ${quote(SANDBOX_VARIABLES)} "$repo_root/scripts/probe-sandbox.sh")"`,
    `eval "$(sed -n ${quote(SANDBOX_FUNCTIONS)} "$repo_root/scripts/probe-sandbox.sh")"`,
    body,
    `printf 'cleanup_failed=%s\\n' "$cleanup_failed"`,
  ].join('\n');
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function readArgvLog(path: string): string[][] {
  return readIfPresent(path)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(SEPARATOR).slice(0, -1));
}

function boundBy(seconds: string, calls: readonly (readonly string[])[]): string[][] {
  return calls.map((argv) => [seconds, ...argv]);
}

/**
 * Host route table seen by `probe_allocate_subnet` through `PROBE_ROUTE_TABLE`: text is written to
 * an owned file, `null` names a file that does not exist, absent leaves the variable unset.
 */
function runCase(
  script: string,
  dockerSeconds: string,
  replies: readonly DockerReply[],
  routeTable?: string | null,
): CaseResult {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-probe-cleanup-'));
  try {
    const dockerLog = join(directory, 'docker.log');
    const timeoutLog = join(directory, 'timeout.log');
    const timeoutViolations = join(directory, 'timeout-violations.log');
    const routeFile = join(directory, 'route');
    // Controlled external executables on PATH, not mocks of the probe functions under test.
    writeFileSync(join(directory, 'docker'), dockerStub(replies), { mode: 0o700 });
    writeFileSync(join(directory, 'timeout'), TIMEOUT_STUB, { mode: 0o700 });
    if (typeof routeTable === 'string') writeFileSync(routeFile, routeTable, { mode: 0o600 });
    const result = spawnSync('bash', ['-c', script], {
      cwd: directory,
      env: {
        ...(routeTable === undefined ? {} : { PROBE_ROUTE_TABLE: routeFile }),
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        TMPDIR: directory,
        STUB_DOCKER_LOG: dockerLog,
        STUB_TIMEOUT_LOG: timeoutLog,
        STUB_TIMEOUT_VIOLATIONS: timeoutViolations,
        EXPECT_WAIT_SECONDS: WAIT_SECONDS,
        EXPECT_DOCKER_SECONDS: dockerSeconds,
      },
      encoding: 'utf8',
      // Every child is a local stub; a hang must not stall the integration project, but the
      // parallel integration suite can starve bash startup well past a few seconds.
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const field = (name: string) =>
      result.stdout
        .split('\n')
        .find((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readArgvLog(dockerLog),
      bounded: readArgvLog(timeoutLog),
      timeoutViolations: readIfPresent(timeoutViolations),
      cleanupFailed: field('cleanup_failed'),
      waitStatus: field('wait_status'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sandboxVariableBlock(): string {
  const result = spawnSync('sed', ['-n', SANDBOX_VARIABLES, sandboxScript], { encoding: 'utf8' });
  return result.stdout;
}

const PREFIXES = ['Error response from daemon:', 'Error:'] as const;

const RM_X = ['rm', '-f', 'x'];
const INSPECT_X = ['container', 'inspect', '--format', '{{.Id}}', 'x'];
const PRESENT_ID = 'sha256:0123456789abcdef\n';
const DAEMON_NO_SUCH_X = 'Error response from daemon: No such container: x\n';

function scrubRun(image: string, helper: string): string[] {
  return [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    helper,
    '--user',
    '0:0',
    '--mount',
    'type=bind,src=/h,dst=/s/home',
    '--mount',
    'type=bind,src=/w,dst=/s/work',
    image,
    'sh',
    '-c',
    'find /s/home /s/work -mindepth 1 -delete',
  ];
}

describe('lifecycle probe_remove_owned', { timeout: CASE_TIMEOUT_MS }, () => {
  it('records a cleanup failure when rm reports absence but an independent inspect finds the container', () => {
    const replies = [
      { argv: RM_X, status: 1, stderr: DAEMON_NO_SUCH_X },
      { argv: INSPECT_X, status: 0, stdout: PRESENT_ID },
    ];

    const result = runCase(
      lifecycleScript('probe_remove_owned rm x'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([RM_X, INSPECT_X]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-test: cleanup failed: docker rm -f x');
    expect(result.bounded).toEqual(boundBy('5', [RM_X, INSPECT_X]));
    expect(result.timeoutViolations).toBe('');
  });
});

describe('lifecycle probe_remove_owned absence proof', { timeout: CASE_TIMEOUT_MS }, () => {
  it.each(PREFIXES)(
    'releases a failed rm only after one inspect reports exact absence with %s',
    (prefix) => {
      const replies = [
        { argv: RM_X, status: 1, stderr: 'Error response from daemon: removal failed\n' },
        { argv: INSPECT_X, status: 1, stderr: `${prefix} No such container: x\n` },
      ];

      const result = runCase(
        lifecycleScript('probe_remove_owned rm x'),
        LIFECYCLE_DOCKER_SECONDS,
        replies,
      );

      expect(result.cleanupFailed).toBe('0');
      expect(result.calls).toEqual([RM_X, INSPECT_X]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('cleanup failed');
      expect(result.bounded).toEqual(boundBy('5', [RM_X, INSPECT_X]));
      expect(result.timeoutViolations).toBe('');
    },
  );

  it('records a failure when inspect reports absence of a different name', () => {
    const replies = [
      { argv: RM_X, status: 1, stderr: DAEMON_NO_SUCH_X },
      {
        argv: INSPECT_X,
        status: 1,
        stderr: 'Error response from daemon: No such container: other\n',
      },
    ];

    const result = runCase(
      lifecycleScript('probe_remove_owned rm x'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([RM_X, INSPECT_X]);
    expect(result.stderr).toContain('probe-test: cleanup failed: docker rm -f x');
    expect(result.bounded).toEqual(boundBy('5', [RM_X, INSPECT_X]));
    expect(result.timeoutViolations).toBe('');
  });

  it('accepts a successful rm without any inspect', () => {
    const replies = [{ argv: RM_X, status: 0, stdout: 'x\n' }];

    const result = runCase(
      lifecycleScript('probe_remove_owned rm x'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('0');
    expect(result.calls).toEqual([RM_X]);
    expect(result.status).toBe(0);
    expect(result.bounded).toEqual(boundBy('5', [RM_X]));
    expect(result.timeoutViolations).toBe('');
  });

  it('records a failure when rm fails otherwise and inspect still finds the container', () => {
    const replies = [
      { argv: RM_X, status: 1, stderr: 'Error response from daemon: device or resource busy\n' },
      { argv: INSPECT_X, status: 0, stdout: PRESENT_ID },
    ];

    const result = runCase(
      lifecycleScript('probe_remove_owned rm x'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([RM_X, INSPECT_X]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-test: cleanup failed: docker rm -f x');
    expect(result.bounded).toEqual(boundBy('5', [RM_X, INSPECT_X]));
    expect(result.timeoutViolations).toBe('');
  });

  it('releases a failed untagged rmi when inspect reports the latest reference absent', () => {
    const rmi = ['rmi', '-f', 'y'];
    const inspect = ['image', 'inspect', '--format', '{{.Id}}', 'y'];
    const replies = [
      { argv: rmi, status: 1, stderr: 'Error response from daemon: No such image: y:latest\n' },
      { argv: inspect, status: 1, stderr: 'Error response from daemon: No such image: y:latest\n' },
    ];

    const result = runCase(
      lifecycleScript('probe_remove_owned rmi y'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('0');
    expect(result.calls).toEqual([rmi, inspect]);
    expect(result.status).toBe(0);
    expect(result.bounded).toEqual(boundBy('5', [rmi, inspect]));
    expect(result.timeoutViolations).toBe('');
  });
});

describe('lifecycle probe_scrub_binds', { timeout: CASE_TIMEOUT_MS }, () => {
  it('releases a failed run when inspect reports the untagged image absent', () => {
    const run = scrubRun('img', 'h');
    const imageInspect = ['image', 'inspect', '--format', '{{.Id}}', 'img'];
    const replies = [
      { argv: run, status: 125, stderr: "Unable to find image 'img:latest' locally\n" },
      {
        argv: imageInspect,
        status: 1,
        stderr: 'Error response from daemon: No such image: img:latest\n',
      },
      { argv: ['rm', '-f', 'h'], status: 0, stdout: 'h\n' },
    ];

    const result = runCase(
      lifecycleScript('probe_scrub_binds img /h /w h'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('0');
    expect(result.calls).toEqual([run, imageInspect, ['rm', '-f', 'h']]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('cleanup failed');
    expect(result.bounded).toEqual(boundBy('5', [run, imageInspect, ['rm', '-f', 'h']]));
    expect(result.timeoutViolations).toBe('');
  });

  it('records scrub failure when run reports a missing image that inspect still finds', () => {
    const run = scrubRun('img', 'h');
    const imageInspect = ['image', 'inspect', '--format', '{{.Id}}', 'img'];
    const replies = [
      { argv: run, status: 125, stderr: "Unable to find image 'img:latest' locally\n" },
      { argv: imageInspect, status: 0, stdout: PRESENT_ID },
      { argv: ['rm', '-f', 'h'], status: 0, stdout: 'h\n' },
    ];

    const result = runCase(
      lifecycleScript('probe_scrub_binds img /h /w h'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([run, imageInspect, ['rm', '-f', 'h']]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-test: cleanup failed: scrub bind dirs');
    expect(result.bounded).toEqual(boundBy('5', [run, imageInspect, ['rm', '-f', 'h']]));
    expect(result.timeoutViolations).toBe('');
  });

  it('records helper removal failure when rm reports absence but inspect finds the helper', () => {
    const run = scrubRun('img', 'h');
    const inspectHelper = ['container', 'inspect', '--format', '{{.Id}}', 'h'];
    const replies = [
      { argv: run, status: 0 },
      {
        argv: ['rm', '-f', 'h'],
        status: 1,
        stderr: 'Error response from daemon: No such container: h\n',
      },
      { argv: inspectHelper, status: 0, stdout: PRESENT_ID },
    ];

    const result = runCase(
      lifecycleScript('probe_scrub_binds img /h /w h'),
      LIFECYCLE_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([run, ['rm', '-f', 'h'], inspectHelper]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-test: cleanup failed: docker rm -f h');
    expect(result.bounded).toEqual(boundBy('5', [run, ['rm', '-f', 'h'], inspectHelper]));
    expect(result.timeoutViolations).toBe('');
  });
});

describe('sandbox remove_owned', { timeout: CASE_TIMEOUT_MS }, () => {
  it('records a cleanup failure when rm reports absence but an independent inspect finds the container', () => {
    const replies = [
      { argv: RM_X, status: 1, stderr: DAEMON_NO_SUCH_X },
      { argv: INSPECT_X, status: 0, stdout: PRESENT_ID },
    ];

    const result = runCase(sandboxScriptText('remove_owned rm x'), SANDBOX_DOCKER_SECONDS, replies);

    expect(result.cleanupFailed).toBe('1');
    expect(result.calls).toEqual([RM_X, INSPECT_X]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-sandbox: cleanup failed: docker rm -f x: ');
    expect(result.bounded).toEqual(boundBy('30', [INSPECT_X]));
    expect(result.timeoutViolations).toBe('');
    expect(sandboxVariableBlock()).toMatch(/^docker_seconds=30$/m);
  });
});

describe('sandbox remove_owned absence proof', { timeout: CASE_TIMEOUT_MS }, () => {
  it.each(PREFIXES)(
    'releases a failed rm only after one inspect reports exact absence with %s',
    (prefix) => {
      const replies = [
        { argv: RM_X, status: 1, stderr: 'Error response from daemon: removal failed\n' },
        { argv: INSPECT_X, status: 1, stderr: `${prefix} No such container: x\n` },
      ];

      const result = runCase(
        sandboxScriptText('remove_owned rm x'),
        SANDBOX_DOCKER_SECONDS,
        replies,
      );

      expect(result.cleanupFailed).toBe('0');
      expect(result.calls).toEqual([RM_X, INSPECT_X]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('cleanup failed');
      expect(result.bounded).toEqual(boundBy('30', [INSPECT_X]));
      expect(result.timeoutViolations).toBe('');
      expect(sandboxVariableBlock()).toMatch(/^docker_seconds=30$/m);
    },
  );
});

describe('sandbox wait_for_container', { timeout: CASE_TIMEOUT_MS }, () => {
  it('records a kill failure while inspect still reports the container running and keeps the wait status', () => {
    const inspectRunning = ['container', 'inspect', '--format', '{{.State.Running}}', 'c'];
    const inspectId = ['container', 'inspect', '--format', '{{.Id}}', 'c'];
    const replies = [
      { argv: ['wait', 'c'], status: 3, stderr: 'wait interrupted\n' },
      { argv: ['kill', 'c'], status: 1, stderr: 'Error response from daemon: kill refused\n' },
      { argv: inspectId, status: 0, stdout: PRESENT_ID },
      { argv: inspectRunning, status: 0, stdout: 'true\n' },
    ];

    const result = runCase(
      sandboxScriptText('st=0\nwait_for_container c || st=$?\nprintf \'wait_status=%s\\n\' "$st"'),
      SANDBOX_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('1');
    expect(result.waitStatus).toBe('3');
    expect(result.calls).toEqual([['wait', 'c'], ['kill', 'c'], inspectId, inspectRunning]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('probe-sandbox: cleanup failed: docker kill c');
    expect(result.bounded).toEqual([
      ['7', 'wait', 'c'],
      ...boundBy('30', [inspectId, inspectRunning]),
    ]);
    expect(result.timeoutViolations).toBe('');
    expect(sandboxVariableBlock()).toMatch(/^docker_seconds=30$/m);
  });

  it('releases a kill failure when inspect reports the container no longer running', () => {
    const inspectRunning = ['container', 'inspect', '--format', '{{.State.Running}}', 'c'];
    const inspectId = ['container', 'inspect', '--format', '{{.Id}}', 'c'];
    const replies = [
      { argv: ['wait', 'c'], status: 3, stderr: 'wait interrupted\n' },
      { argv: ['kill', 'c'], status: 1, stderr: 'Error response from daemon: not running\n' },
      { argv: inspectId, status: 0, stdout: PRESENT_ID },
      { argv: inspectRunning, status: 0, stdout: 'false\n' },
    ];

    const result = runCase(
      sandboxScriptText('st=0\nwait_for_container c || st=$?\nprintf \'wait_status=%s\\n\' "$st"'),
      SANDBOX_DOCKER_SECONDS,
      replies,
    );

    expect(result.cleanupFailed).toBe('0');
    expect(result.waitStatus).toBe('3');
    expect(result.calls).toEqual([['wait', 'c'], ['kill', 'c'], inspectId, inspectRunning]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('cleanup failed');
    expect(result.bounded).toEqual([
      ['7', 'wait', 'c'],
      ...boundBy('30', [inspectId, inspectRunning]),
    ]);
    expect(result.timeoutViolations).toBe('');
  });
});

const NETWORK_RM_N = ['network', 'rm', 'n'];
const NETWORK_INSPECT_N = ['network', 'inspect', '--format', '{{.Id}}', 'n'];

describe('lifecycle probe_remove_network', { timeout: CASE_TIMEOUT_MS }, () => {
  it('accepts a successful network removal without any inspect', () => {
    const result = runCase(lifecycleScript('probe_remove_network n'), LIFECYCLE_DOCKER_SECONDS, [
      { argv: NETWORK_RM_N, status: 0, stdout: 'n\n' },
    ]);

    expect(result.cleanupFailed).toBe('0');
    expect(result.calls).toEqual([NETWORK_RM_N]);
    expect(result.bounded).toEqual(boundBy('5', [NETWORK_RM_N]));
    expect(result.timeoutViolations).toBe('');
  });

  it('releases a failed removal only after an inspect reports that exact network absent', () => {
    const result = runCase(lifecycleScript('probe_remove_network n'), LIFECYCLE_DOCKER_SECONDS, [
      {
        argv: NETWORK_RM_N,
        status: 1,
        stderr: 'Error response from daemon: network n not found\n',
      },
      {
        argv: NETWORK_INSPECT_N,
        status: 1,
        stdout: '[]\n',
        stderr: 'Error response from daemon: network n not found\n',
      },
    ]);

    expect(result.cleanupFailed).toBe('0');
    expect(result.calls).toEqual([NETWORK_RM_N, NETWORK_INSPECT_N]);
    expect(result.stderr).not.toContain('cleanup failed');
  });

  it('records a failure when the network still exists after a failed removal', () => {
    const result = runCase(lifecycleScript('probe_remove_network n'), LIFECYCLE_DOCKER_SECONDS, [
      {
        argv: NETWORK_RM_N,
        status: 1,
        stderr: 'Error response from daemon: has active endpoints\n',
      },
      { argv: NETWORK_INSPECT_N, status: 0, stdout: `${'e'.repeat(64)}\n` },
    ]);

    expect(result.cleanupFailed).toBe('1');
    expect(result.stderr).toContain('probe-test: cleanup failed: docker network rm n');
  });
});

describe('lifecycle fixed-address helpers', { timeout: CASE_TIMEOUT_MS }, () => {
  const networks = ['network', 'ls', '--quiet', '--no-trunc'];
  const subnets = [
    'network',
    'inspect',
    '--format',
    '{{range .IPAM.Config}}{{println .Subnet}}{{end}}',
    'a1',
    'b2',
  ];

  // giap-vps `/proc/net/route` (2026-10-31): a local proxy tun `Meta` owns 198.18.0.0/30 and the
  // default bridge 172.17.0.0/16; the default route is skipped.
  const ROUTE_HEADER =
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
  const DOCKER0_ROUTE = 'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  const GIAP_ROUTES =
    ROUTE_HEADER +
    'eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
    'Meta\t000012C6\t00000000\t0001\t0\t0\t0\tFCFFFFFF\t0\t0\t0\n' +
    DOCKER0_ROUTE;
  const allocate = lifecycleScript(
    'if allocation="$(probe_allocate_subnet)"; then printf "allocation=%s\\n" "$allocation"; ' +
      'else printf "allocation-status=%s\\n" "$?"; fi',
  );

  it('chooses the first free /28 of the test pool through the orchestrator allocator', () => {
    const result = runCase(
      allocate,
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: networks, status: 0, stdout: 'a1\nb2\n' },
        { argv: subnets, status: 0, stdout: '198.18.0.0/28\nfd00::/64\n\n172.17.0.0/16\n' },
      ],
      ROUTE_HEADER + DOCKER0_ROUTE,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allocation=198.18.0.16/28 198.18.0.18\n');
    expect(result.bounded).toEqual(boundBy('5', [networks, subnets]));
  });

  it('excludes host kernel routes, so the giap-vps proxy tun pushes allocation past both sources', () => {
    const result = runCase(
      allocate,
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: networks, status: 0, stdout: 'a1\nb2\n' },
        { argv: subnets, status: 0, stdout: '198.18.0.16/28\n172.17.0.0/16\n' },
      ],
      GIAP_ROUTES,
    );

    // Docker IPAM alone leaves 198.18.0.0/28 free; only the host route table excludes it.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allocation=198.18.0.32/28 198.18.0.34\n');
  });

  it('fails the probe when the host route table is missing', () => {
    const result = runCase(
      allocate,
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: networks, status: 0, stdout: 'a1\nb2\n' },
        { argv: subnets, status: 0, stdout: '172.17.0.0/16\n' },
      ],
      null,
    );

    expect(result.stdout).toMatch(/^allocation-status=[1-9]\d*$/m);
    expect(result.stdout).not.toContain('allocation=');
    expect(result.stderr).toContain('probe-test: host route table unreadable or malformed');
  });

  it('fails the probe on a malformed host route row instead of dropping it', () => {
    const result = runCase(
      allocate,
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: networks, status: 0, stdout: 'a1\nb2\n' },
        { argv: subnets, status: 0, stdout: '172.17.0.0/16\n' },
      ],
      ROUTE_HEADER + 'Meta\t000012C6\t00000000\t0001\t0\t0\t0\tFCFFFFF\t0\t0\t0\n',
    );

    expect(result.stdout).toMatch(/^allocation-status=[1-9]\d*$/m);
    expect(result.stdout).not.toContain('allocation=');
    expect(result.stderr).toContain('probe-test: host route table unreadable or malformed');
  });

  const running = ['inspect', '-f', '{{.State.Running}}', 'c'];
  const logs = ['logs', 'c'];
  const token = 'A'.repeat(43);

  it('reads the launch token only from the line naming the container base+2 address', () => {
    const result = runCase(
      lifecycleScript('printf "token=%s\\n" "$(probe_wait_launch_token c 1 198.18.0.18)"'),
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: running, status: 0, stdout: 'true\n' },
        {
          argv: logs,
          status: 0,
          stdout: `dsh web: http://127.0.0.1:3080/?token=${'B'.repeat(43)}\ndsh web: http://198.18.0.18:3080/?token=${token}\n`,
        },
      ],
    );

    expect(result.stdout).toContain(`token=${token}\n`);
  });

  it('never accepts a launch line naming another address', () => {
    const result = runCase(
      lifecycleScript('probe_wait_launch_token c 1 198.18.0.18 || printf "rejected\\n"'),
      LIFECYCLE_DOCKER_SECONDS,
      [
        { argv: running, status: 0, stdout: 'true\n' },
        { argv: logs, status: 0, stdout: `dsh web: http://127.0.0.1:3080/?token=${token}\n` },
      ],
    );

    expect(result.stdout).toContain('rejected\n');
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).toContain('no launch-token line within 1s');
  });
});
