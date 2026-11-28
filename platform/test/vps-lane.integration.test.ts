import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CHROME_VERSION } from '../../scripts/verify-browser-runtime.mjs';
import { verifyDockerEvidence } from './docker-evidence.ts';
import { BODY, LANE_MS, NODE_PIN, STDOUT, createLane, passed } from './vps-lane-fixture.ts';
import type { Lane, LaneOptions, Scenario } from './vps-lane-fixture.ts';

// A case runs at most three lane children (run, post, rerun) back to back.
const CASE_MS = LANE_MS * 3;
const OTHER = 'e'.repeat(40);
const lanes: Lane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

async function fixture(options: LaneOptions = {}) {
  const lane = await createLane(options);
  lanes.push(lane);
  return lane;
}

const run = (lane: Lane, label: string, sha = lane.sha, branch = 'main') =>
  lane.lane('lane:vps', [label, sha, branch]);
const post = (lane: Lane, label: string, ...extra: string[]) =>
  lane.lane('lane:vps:post', ['42', label, ...extra]);
const summary = (lane: Lane, label: string) =>
  JSON.parse(readFileSync(join(lane.runDir(label), 'summary.json'), 'utf8')) as {
    state: string;
    head: string;
    failed: string[];
    remoteRoot: string;
    failure: { step: string; reason: string } | null;
    custody: { state: string; invocation: string; observer?: string } | null;
    deploy: { exit: number | null; reason: string | null } | null;
  };
const tools = (lane: Lane, tool: string) => lane.calls().filter((call) => call.tool === tool);
const sshCommands = (lane: Lane) => tools(lane, 'ssh').map((call) => call.args.at(-1) ?? '');
const ownImages = (lane: Lane) =>
  existsSync(join(lane.state, 'images')) ? readdirSync(join(lane.state, 'images')) : [];
const pnpmCalls = (lane: Lane, step: string) =>
  existsSync(join(lane.state, `pnpm-${step}-env.json`));

/** No call removes, stops or cancels anything except the lane's own local image tags. */
function expectNoRemoteMutation(lane: Lane) {
  for (const command of sshCommands(lane))
    expect(command).not.toMatch(/\b(rm|rmdir|unlink|cancel|stop|prune|kill)\b/);
  for (const call of tools(lane, 'docker')) {
    if (call.args[0] === 'image' && call.args[1] === 'rm')
      expect(call.args[2]).toMatch(/^dsh-team-test-[a-f0-9-]{36}:(platform|user|browser)$/);
    else expect(call.args.join(' ')).not.toMatch(/\b(rm|rmi|prune|kill|stop)\b/);
  }
  for (const call of tools(lane, 'systemctl')) expect(call.args).not.toContain('stop');
}

function sections(body: string) {
  const start = body.indexOf('## Runtime evidence');
  const end = body.indexOf('## Risk');
  return { before: body.slice(0, start), evidence: body.slice(start, end), after: body.slice(end) };
}

it('exports the Chrome pin without running the browser runtime main path', () => {
  const url = new URL('../../scripts/verify-browser-runtime.mjs', import.meta.url).href;

  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `process.stdout.write((await import(${JSON.stringify(url)})).CHROME_VERSION)`,
    ],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  );

  expect(result).toMatchObject({ status: 0, stdout: '156.0.8078.80', stderr: '' });
  expect(CHROME_VERSION).toBe('156.0.8078.80');
});

it.each([
  ['../x', 'a'.repeat(40)],
  ['ok', 'abcdef1'],
  ['ok', 'A'.repeat(40)],
])(
  'refuses label %s or sha %s before any local write or remote command',
  async (label, sha) => {
    const lane = await fixture();

    const result = await run(lane, label, sha);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage: pnpm lane:vps <label> <sha> <branch>');
    expect(lane.calls()).toEqual([]);
    expect(existsSync(join(lane.repo, '.run'))).toBe(false);
  },
  CASE_MS,
);

it(
  'refuses a branch that is not at the sha, without building',
  async () => {
    const lane = await fixture();

    const result = await run(lane, 'drift', OTHER);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`branch main is not at ${OTHER}`);
    expect(lane.calls()).toEqual([]);
  },
  CASE_MS,
);

it(
  'refuses a missing .tool-versions pin, naming it, before any remote command',
  async () => {
    const lane = await fixture({ toolVersions: `nodejs ${NODE_PIN}\n` });

    const result = await run(lane, 'pins');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pin missing: pnpm in .tool-versions');
    expect(lane.calls()).toEqual([]);
  },
  CASE_MS,
);

it(
  'refuses a missing CHROME_VERSION pin at the sha, naming it, before any remote command',
  async () => {
    const lane = await fixture({ chromePin: null });

    const result = await run(lane, 'pins');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'pin missing: CHROME_VERSION in scripts/verify-browser-runtime.mjs',
    );
    expect(lane.calls()).toEqual([]);
  },
  CASE_MS,
);

it(
  'checks the remote Chrome path for the pin at the sha, not the lane checkout pin',
  async () => {
    const lane = await fixture({ chromePin: '151.0.7100.2' });

    const result = await run(lane, 'chrome');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'remote toolchain missing: chrome (~/.local/share/dsh-team/toolchain/chrome-151.0.7100.2/',
    );
    expect(tools(lane, 'scp')).toEqual([]);
  },
  CASE_MS,
);

it.each(['node', 'pnpm', 'hurl', 'chrome'] as const)(
  'refuses a missing remote %s toolchain entry, naming it, before upload or custody',
  async (missingTool) => {
    const lane = await fixture({ missingTool });

    const result = await run(lane, 'tools');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`remote toolchain missing: ${missingTool}`);
    expect(tools(lane, 'scp')).toEqual([]);
    expect(tools(lane, 'docker')).toEqual([]);
    expect(existsSync(lane.runDir('tools'))).toBe(false);
  },
  CASE_MS,
);

it.each<[string, LaneOptions, string]>([
  [
    'a browser Dockerfile naming a file the context lacks',
    { browserCopy: 'COPY --from=browser-runtime /absent.mjs /opt/dsh-team/absent.mjs\n' },
    'browser Dockerfile names absent.mjs, which scripts/ lacks',
  ],
  [
    'a build input that is not world-readable',
    { tarUmask: '0077' },
    'build input not world-readable: ',
  ],
  [
    'a saved layer with the wrong mode',
    { migrationMode: 0o600 },
    'saved layer mode: app/platform/dist/db/migrations/1-initial.sql is -rw-------, want -rw-r--r--',
  ],
])(
  'refuses %s without upload and clears its own images and build directory',
  async (_name, options, message) => {
    const lane = await fixture(options);

    const result = await run(lane, 'inputs');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(tools(lane, 'scp')).toEqual([]);
    expect(existsSync(lane.runDir('inputs'))).toBe(false);
    expect(ownImages(lane)).toEqual([]);
  },
  CASE_MS,
);

it(
  'a failed image build removes its own labelled images and build directory; the next run starts',
  async () => {
    const lane = await fixture();
    await lane.scenario((scenario) => {
      scenario.buildFail = 'user';
    });

    const failed = await run(lane, 'retry');
    const leftImages = ownImages(lane);
    const leftDirectory = existsSync(lane.runDir('retry'));
    await lane.scenario((scenario) => {
      delete scenario.buildFail;
    });
    const retried = await run(lane, 'retry');

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('image build failed: user');
    expect(leftImages).toEqual([]);
    expect(leftDirectory).toBe(false);
    const runs = tools(lane, 'docker')
      .filter((call) => call.args[0] === 'buildx')
      .map((call) => call.args[call.args.indexOf('-t') + 1]?.split(':')[0]);
    expect(new Set(runs).size).toBe(2);
    expect(retried.status).toBe(0);
    expect(summary(lane, 'retry').state).toBe('completed');
    expect(ownImages(lane)).toEqual([]);
  },
  CASE_MS,
);

it(
  'remote prepare refuses a tar altered after hashing; summary records it and no install runs',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'scp-tamper'), 'user-image.tar');

    const result = await run(lane, 'tamper');

    expect(result.status).not.toBe(0);
    const recorded = summary(lane, 'tamper');
    expect(recorded).toMatchObject({ state: 'failed', failure: { step: 'prepare' } });
    expect(recorded.failure?.reason).toContain('hash mismatch: user-image.tar');
    expect(pnpmCalls(lane, 'install')).toBe(false);
    expect(existsSync(join(lane.state, 'custody-started'))).toBe(false);
    expect(existsSync(join(lane.runDir('tamper'), 'build'))).toBe(false);
  },
  CASE_MS,
);

it(
  'a full pass records custody, deploy and fence, and post publishes it on the exact head',
  async () => {
    const lane = await fixture();

    const result = await run(lane, 'pass');
    const posted = await post(lane, 'pass', '--note', 'Rebased on main.');

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const lanes = summary(lane, 'pass');
    expect(lanes).toMatchObject({ state: 'completed', head: lane.sha, failed: [] });
    const images = join(lanes.remoteRoot, 'images.json');
    expect(statSync(images).mode & 0o777).toBe(0o600);
    const mapping = JSON.parse(readFileSync(images, 'utf8')) as {
      roles: Record<string, { layout: string; manifestDigest: string; configId: string }>;
    };
    expect(Object.keys(mapping.roles).sort()).toEqual(['browser', 'platform', 'user']);
    for (const role of Object.values(mapping.roles)) {
      expect(role.layout.startsWith(lanes.remoteRoot)).toBe(true);
      expect(role.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(role.configId).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    const start = JSON.parse(readFileSync(join(lane.state, 'custody-start-env.json'), 'utf8')) as {
      names: string[];
      images: string;
      cwd: string;
    };
    expect(start.images).toBe(images);
    expect(start.names).toEqual(expect.arrayContaining(['HTTP_PROXY', 'NO_PROXY', 'CHROME_BIN']));
    expect(
      sshCommands(lane).some((command) => command.includes(`node-v${NODE_PIN}-linux-x64`)),
    ).toBe(true);
    expectNoRemoteMutation(lane);

    expect(posted.stderr).toBe('');
    expect(posted.status).toBe(0);
    const gh = lane.ghState();
    expect(gh.statuses).toHaveLength(1);
    expect(gh.statuses[0]).toMatchObject({
      sha: lane.sha,
      state: 'success',
      context: 'dsh-team/docker',
    });
    expect(
      verifyDockerEvidence({
        target: { kind: 'pull-request', headSha: lane.sha },
        evidence: { sha: lane.sha, statuses: gh.statuses as never },
      }),
    ).toBe(true);
    const [old, updated] = [sections(BODY), sections(gh.body)];
    expect(updated.before).toBe(old.before);
    expect(updated.after).toBe(old.after);
    expect(updated.evidence).toContain(lane.sha);
    expect(updated.evidence).toContain(lanes.custody?.invocation);
    expect(updated.evidence).toContain('41 files and 377 tests passed');
    expect(updated.evidence).toContain('Rebased on main.');
    const reruns = tools(lane, 'gh').filter(
      (call) => call.args[0] === 'run' && call.args[1] === 'rerun',
    );
    expect(reruns.map((call) => call.args[2])).toEqual(['11']);

    const evidence = readdirSync(lane.runDir('pass')).map((name) =>
      readFileSync(join(lane.runDir('pass'), name), 'utf8'),
    );
    const records = [readFileSync(join(lane.state, 'calls.log'), 'utf8'), ...evidence];
    for (const text of [...records, result.stdout, posted.stdout, JSON.stringify(start)])
      expect(text).not.toContain(lane.secret);
    for (const local of [lane.local, homedir()])
      expect(readFileSync(join(lane.state, 'calls.log'), 'utf8')).not.toContain(local);
    expect(readFileSync(join(lane.runDir('pass'), 'custody-stdout.log'), 'utf8')).toBe(STDOUT);
  },
  CASE_MS,
);

it(
  'retries a transient status query failure and still passes',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), '3 custody-status');

    const result = await run(lane, 'flaky');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('custody status query failed (1), retrying');
    expect(summary(lane, 'flaky')).toMatchObject({ state: 'completed', failed: [] });
  },
  CASE_MS,
);

it(
  'reports custody UNKNOWN once status stays unreachable past its bound, removing nothing',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), '100000 custody-status');

    const result = await run(lane, 'offline');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('custody status unreachable; state UNKNOWN, nothing removed');
    expect(summary(lane, 'offline').custody?.state).toBe('unknown');
    expect(summary(lane, 'offline').failed).toContain('custody-state');
    expect(pnpmCalls(lane, 'test-deploy')).toBe(false);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it.each<[string, (scenario: Scenario, head: string) => void, string]>([
  [
    'custody reports unknown',
    (s, head) => (s.statuses = [{ head, state: 'unknown' }]),
    'custody-state',
  ],
  ['custody reports another head', (s) => (s.statuses = [passed(OTHER)]), 'custody-head'],
  ['the stdout digest differs from the status', (s) => (s.stdout = `${STDOUT}x`), 'custody-stdout'],
])(
  'records %s as not a pass without cancelling or deleting',
  async (_name, change, criterion) => {
    const lane = await fixture();
    await lane.scenario((scenario) => {
      change(scenario, lane.sha);
    });

    const result = await run(lane, 'custody');

    expect(result.status).not.toBe(0);
    expect(summary(lane, 'custody').failed).toContain(criterion);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'does not retry a remote answer that is not a transport failure',
  async () => {
    const lane = await fixture();
    await lane.scenario((scenario) => {
      scenario.logsFail = true;
    });

    const result = await run(lane, 'answer');

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('custody stdout fetch answered: ');
    expect(sshCommands(lane).filter((command) => command.includes(' custody-logs '))).toHaveLength(
      1,
    );
    expect(summary(lane, 'answer').failed).toEqual(['custody-stdout']);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'gives the host fence its own bound, so a fence slower than a query is not retried',
  async () => {
    const lane = await fixture({ queryMs: '5000' });
    await writeFile(join(lane.state, 'ssh-delay'), "7 mjs' fence ");

    const result = await run(lane, 'slowfence');

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('host fence observation failed');
    expect(sshCommands(lane).filter((command) => command.includes("mjs' fence "))).toHaveLength(1);
    expect(summary(lane, 'slowfence')).toMatchObject({ state: 'completed', failed: [] });
  },
  CASE_MS,
);

it(
  'continues with the recorded custody invocation when the observing SSH drops after launch',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-drop'), "mjs' launch ");

    const result = await run(lane, 'dropped');

    expect(result.status).toBe(0);
    const recorded = summary(lane, 'dropped');
    expect(recorded).toMatchObject({ state: 'completed', failed: [], failure: null });
    expect(recorded.custody?.invocation).toBe(
      readFileSync(join(lane.state, 'custody-started'), 'utf8'),
    );
    expect(recorded.custody?.observer).toBe('lost');
    expect(sshCommands(lane).filter((command) => command.includes("mjs' launch "))).toHaveLength(1);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'records custody UNKNOWN, not a custody-start failure, when the start record stays unreadable',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-drop'), "mjs' launch ");
    await writeFile(join(lane.state, 'ssh-fail'), '100000 custody-start.json');

    const result = await run(lane, 'unread');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('state UNKNOWN, nothing removed');
    const recorded = summary(lane, 'unread');
    expect(recorded.failure).toBeNull();
    expect(recorded.custody).toMatchObject({ state: 'unknown', observer: 'lost' });
    expect(recorded.failed).toContain('custody-state');
    expect(pnpmCalls(lane, 'test-deploy')).toBe(false);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'records custody-start failed when the launch SSH fails and no start was recorded',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), "1 mjs' launch ");

    const result = await run(lane, 'nostart');

    expect(result.status).not.toBe(0);
    expect(summary(lane, 'nostart')).toMatchObject({
      state: 'failed',
      failure: { step: 'custody-start' },
    });
    expect(existsSync(join(lane.state, 'custody-started'))).toBe(false);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'polls the deploy unit it started when the start SSH drops after the remote command ran',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-drop'), "'test:deploy'");

    const result = await run(lane, 'deploydrop');

    expect(result.status).toBe(0);
    expect(summary(lane, 'deploydrop')).toMatchObject({
      state: 'completed',
      failed: [],
      deploy: { exit: 0, reason: null },
    });
    expect(pnpmCalls(lane, 'test-deploy')).toBe(true);
  },
  CASE_MS,
);

it(
  'fails closed with the unit state UNKNOWN, not a hang, when a transport failure kept the unit from starting',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), "1 'install' 'build'");

    const result = await run(lane, 'neverstarted');

    expect(result.status).not.toBe(0);
    expect(summary(lane, 'neverstarted')).toMatchObject({
      state: 'failed',
      failure: {
        step: 'install',
        reason: expect.stringContaining('UNKNOWN: start unconfirmed, no step record') as string,
      },
    });
    expect(pnpmCalls(lane, 'install')).toBe(false);
  },
  CASE_MS,
);

it(
  'issues no host fence when the deploy unit start was unconfirmed and the unit never ran',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), "1 'test:deploy'");

    const result = await run(lane, 'unregistered');

    expect(result.status).not.toBe(0);
    const recorded = summary(lane, 'unregistered');
    expect(recorded.failed).toEqual(expect.arrayContaining(['deploy-exit', 'fence-snapshot']));
    expect(recorded.deploy?.reason).toContain('UNKNOWN: start unconfirmed, no step record');
    expect(pnpmCalls(lane, 'test-deploy')).toBe(false);
    expect(sshCommands(lane).some((command) => command.includes("mjs' fence "))).toBe(false);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'issues no host fence while the deploy unit state is UNKNOWN, and is not a pass',
  async () => {
    const lane = await fixture();
    await writeFile(join(lane.state, 'ssh-fail'), "100000 unit-state 'dsh-team-lane-stuck-deploy-");

    const result = await run(lane, 'stuck');

    expect(result.status).not.toBe(0);
    const recorded = summary(lane, 'stuck');
    expect(recorded.failed).toEqual(expect.arrayContaining(['deploy-exit', 'fence-snapshot']));
    expect(recorded.deploy?.reason).toContain('UNKNOWN');
    expect(sshCommands(lane).some((command) => command.includes("mjs' fence "))).toBe(false);
    expectNoRemoteMutation(lane);
  },
  CASE_MS,
);

it(
  'redacts the proxy values from test:deploy output before it reaches either log',
  async () => {
    const lane = await fixture();
    await lane.scenario((scenario) => {
      const deploy = scenario.output['test:deploy'] ?? '';
      scenario.output['test:deploy'] = `${deploy}proxy http://lane:${lane.secret}@127.0.0.1:9\n`;
      scenario.errput = { 'test:deploy': `auth ${lane.secret} rejected\n` };
    });

    const result = await run(lane, 'redact');

    expect(result.status).toBe(0);
    const recorded = summary(lane, 'redact');
    expect(recorded).toMatchObject({ failed: [], deploy: { exit: 0 } });
    for (const file of [
      join(lane.runDir('redact'), 'test-deploy.log'),
      join(recorded.remoteRoot, 'test-deploy.log'),
    ]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(lane.secret);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('Tests  9 passed (9)');
      expect(text).toContain('auth [REDACTED] rejected');
    }
  },
  CASE_MS,
);

it.each<[string, (recorded: Record<string, unknown>) => void, string]>([
  ['the run is still running', (s) => (s.state = 'running'), 'lane-state'],
  ['the fence is missing', (s) => delete s.fence, 'fence-snapshot'],
  ['the deploy record is missing', (s) => delete s.deploy, 'deploy-exit'],
  [
    'the custody cleanup is missing',
    (s) => delete (s.custody as Record<string, unknown>).cleanup,
    'custody-cleanup',
  ],
])(
  'post refuses a passed summary edited so that %s, naming the criterion',
  async (_name, edit, criterion) => {
    const lane = await fixture();
    await run(lane, 'edited');
    const file = join(lane.runDir('edited'), 'summary.json');
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    edit(recorded);
    await writeFile(file, JSON.stringify(recorded));

    const posted = await post(lane, 'edited');

    expect(posted.status).not.toBe(0);
    expect(posted.stderr).toContain(`lane summary is not a full pass: ${criterion}`);
    expect(lane.ghState()).toMatchObject({ statuses: [], body: BODY, edits: 0 });
  },
  CASE_MS,
);

const failedStatus = (head: string) => ({
  ...passed(head),
  state: 'failed',
  command: { exitCode: 1, signal: null, settled: true },
});
it.each<[string, (scenario: Scenario, head: string) => void, string]>([
  ['custody failed', (s, head) => (s.statuses = [failedStatus(head)]), 'custody-state'],
  [
    'custody cleanup unconfirmed',
    (s, head) => (s.statuses = [{ ...passed(head), cleanup: { state: 'unconfirmed' } }]),
    'custody-cleanup',
  ],
  ['test:deploy exit 1', (s) => (s.exits['test:deploy'] = 1), 'deploy-exit'],
  [
    'a registered target still present',
    (s) => (s.hostAfter.present = ['dsh-team-case-1']),
    'fence-registered-targets',
  ],
  [
    'a deploy target still present',
    (s) => (s.hostAfter.present = ['dsh-team-volume-1']),
    'fence-registered-targets',
  ],
  [
    'an owned leftover',
    (s) => s.hostAfter.volumes.push('dsh-team-leftover'),
    'fence-owned-leftovers',
  ],
  ['a changed daemon PID', (s) => (s.hostAfter.daemonPid = '4343'), 'fence-daemon-pid'],
  ['a changed docker0', (s) => (s.hostAfter.docker0.mtu = 1450), 'fence-docker0'],
  [
    'a changed foreign container',
    (s) =>
      (s.hostAfter.containers[0] = {
        id: 'f00d',
        name: 'ragflow-rc2-ragflow-cpu-1',
        detail: 'f00dfeed|running|2026-11-27T00:00:00Z|1',
      }),
    'fence-foreign-containers',
  ],
])(
  'post refuses a run with %s, naming the criterion, with no status or body edit',
  async (_name, change, criterion) => {
    const lane = await fixture();
    await lane.scenario((scenario) => {
      change(scenario, lane.sha);
    });

    const result = await run(lane, 'criteria');
    const posted = await post(lane, 'criteria');

    expect(result.status).not.toBe(0);
    expect(summary(lane, 'criteria').failed).toContain(criterion);
    expect(posted.status).not.toBe(0);
    expect(posted.stderr).toContain(`lane summary is not a full pass: ${criterion}`);
    expect(lane.ghState()).toMatchObject({ statuses: [], body: BODY, edits: 0 });
  },
  CASE_MS,
);

it(
  'refuses a label whose run directory holds a completed run',
  async () => {
    const lane = await fixture();
    await run(lane, 'once');
    const before = lane.calls().length;

    const again = await run(lane, 'once');

    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('label once already holds a completed run');
    expect(lane.calls().length).toBe(before);
  },
  CASE_MS,
);

it(
  'refuses a label whose run directory holds a live run',
  async () => {
    const lane = await fixture();
    await mkdir(lane.runDir('live'), { recursive: true });
    const live = { state: 'running', pid: process.pid, head: lane.sha };
    await writeFile(join(lane.runDir('live'), 'summary.json'), JSON.stringify(live));

    const result = await run(lane, 'live');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('label live already holds a live run');
    expect(lane.calls()).toEqual([]);
  },
  CASE_MS,
);

it.each<[string, (lane: Lane) => Promise<void>, string]>([
  [
    'the PR head differs from the summary head',
    (l) => l.gh((g) => (g.head = OTHER)),
    `PR head ${OTHER} is not the lane head`,
  ],
  [
    'the gh identity is not the accepted login',
    (l) => l.gh((g) => (g.login = 'someone')),
    'gh identity someone is not the evidence gate login',
  ],
  [
    'the body lacks ## Runtime evidence',
    (l) => l.gh((g) => (g.body = g.body.replace('## Runtime evidence', '## Evidence'))),
    'PR body lacks ## Runtime evidence followed by ## Risk',
  ],
  [
    'the body lacks ## Risk',
    (l) => l.gh((g) => (g.body = g.body.replace('## Risk', '## Hazards'))),
    'PR body lacks ## Runtime evidence followed by ## Risk',
  ],
])(
  'post refuses when %s, before any write',
  async (_name, change, message) => {
    const lane = await fixture();
    await run(lane, 'gate');
    await change(lane);
    const body = lane.ghState().body;

    const posted = await post(lane, 'gate');

    expect(posted.status).not.toBe(0);
    expect(posted.stderr).toContain(message);
    expect(lane.ghState()).toMatchObject({ statuses: [], body, edits: 0 });
    expect(tools(lane, 'gh').some((call) => call.args[1] === 'rerun')).toBe(false);
  },
  CASE_MS,
);

it(
  'a post rerun completes a partial post with one more status; a further rerun leaves the body',
  async () => {
    const lane = await fixture();
    await run(lane, 'partial');
    await lane.gh((gh) => (gh.failEdit = 1));

    const partial = await post(lane, 'partial');
    const afterPartial = lane.ghState();
    const completed = await post(lane, 'partial');
    const afterCompleted = lane.ghState();
    const repeated = await post(lane, 'partial');
    const afterRepeated = lane.ghState();

    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('status posted, body not updated');
    expect(afterPartial).toMatchObject({ body: BODY, edits: 0 });
    expect(afterPartial.statuses).toHaveLength(1);
    expect(completed.status).toBe(0);
    expect(afterCompleted.statuses).toHaveLength(2);
    expect(afterCompleted.edits).toBe(1);
    expect(afterCompleted.body).not.toBe(BODY);
    expect(repeated.status).toBe(0);
    expect(afterRepeated.statuses).toHaveLength(3);
    expect(afterRepeated).toMatchObject({ body: afterCompleted.body, edits: 1 });
    const reruns = tools(lane, 'gh').filter((call) => call.args[1] === 'rerun');
    expect(reruns.map((call) => call.args[2])).toEqual(['11', '11']);
  },
  CASE_MS,
);
