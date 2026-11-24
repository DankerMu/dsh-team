import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import {
  fontsShown,
  heldRunning,
  idleMinutes,
  idleRetired,
  loaded,
  officeIdleLine,
  officeIdleScenario,
  OPERATOR_FONTS,
  operatorFonts,
} from './office-idle-stack-fixture.ts';
import type { Admin } from './office-idle-stack-fixture.ts';

const A = 'office@deployment.example.test';
const COOKIE = 'dsh_team_session=stub-administrator-cookie';
const ADMIN = '/_platform/api/admin';
const CONFIG = {
  ...{ idleMinutes: 30, cpuCores: 2, memoryMiB: 4096, maxRunningInstances: 4 },
  defaultPermissionTier: 'standard',
};
const RUNNING = { email: A, status: 'running', lastStartedAt: 1_000 };
const STOPPED = { ...RUNNING, status: 'stopped' };
const OTHER = { email: 'isolation@deployment.example.test', status: 'running', lastStartedAt: 5 };
// Every answer starts with the profile lane's earlier administrator stop, at `sinceId` itself.
const SINCE = 7;
const OLD = { id: SINCE, actorEmail: 'admin@example.test', details: { reason: 'admin' } };
const IDLE = { id: SINCE + 1, actorEmail: null, details: { reason: 'idle' } };
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

type Row = typeof RUNNING;
type Audit = typeof IDLE | typeof OLD;
type Seen = Record<'method' | 'url' | 'body', string> & {
  at: number;
  headers: IncomingHttpHeaders;
};

/** Three admin routes, `latency` ms late; `instances` and `stops` (after OLD) answer in turn, the
 * last repeating. Another cookie gets 401, an audit query without A's stop filter 400. */
async function platform(instances: Row[][], stops: Audit[][] = [[]], latency = 0) {
  const seen: Seen[] = [];
  let config: unknown = CONFIG;
  const turn = <T>(answers: T[][], path: string) => {
    const reads = seen.filter(({ url }) => url.startsWith(path)).length;
    return answers[Math.min(reads, answers.length) - 1] ?? [];
  };
  const answer = ({ method, url, body }: Seen): [number, unknown] => {
    const { pathname, searchParams } = new URL(url, 'http://stub');
    if (pathname === `${ADMIN}/runtime-config`) {
      if (method === 'PUT') config = JSON.parse(body);
      return [200, config];
    }
    if (pathname === `${ADMIN}/instances`) return [200, { items: turn(instances, pathname) }];
    const filtered = searchParams.get('eventType') === 'instance.stopped';
    if (pathname !== `${ADMIN}/audit-events` || !filtered || searchParams.get('email') !== A)
      return [400, {}];
    return [200, { items: [OLD, ...turn(stops, pathname)], page: 1, pageSize: 50 }];
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const { method = '', url = '', headers } = req;
      const sent = {
        method,
        url,
        at: performance.now(),
        headers,
        body: String(Buffer.concat(chunks)),
      };
      seen.push(sent);
      const [status, reply] = headers.cookie === COOKIE ? answer(sent) : [401, {}];
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      }, latency);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { admin: { base: `http://127.0.0.1:${String(port)}`, cookie: COOKIE }, seen };
}

it('PUTs the whole runtime configuration with only idleMinutes changed, then PUTs the original back', async () => {
  const { admin, seen } = await platform([[RUNNING]]);

  const restore = await idleMinutes(admin, 1);
  await restore();

  expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
    `GET ${ADMIN}/runtime-config`,
    ...Array<string>(2).fill(`PUT ${ADMIN}/runtime-config`),
  ]);
  const puts = seen
    .slice(1)
    .map(({ body, headers }) => [body, headers.origin, headers['content-type']]);
  const sent = (config: object) => [JSON.stringify(config), admin.base, 'application/json'];
  expect(puts).toEqual([sent({ ...CONFIG, idleMinutes: 1 }), sent(CONFIG)]);
});

it('measures the hold between two reads of a running A and ignores the stop at sinceId', async () => {
  const { admin, seen } = await platform([[OTHER, RUNNING]], [[]], 20);

  const { held, sinceId } = await heldRunning(admin, A, 150);

  expect(held).toEqual({ heldMs: held.heldMs, status: 'running', restarted: false, idleStops: 0 });
  expect(held.heldMs).toBeGreaterThanOrEqual(150);
  expect(sinceId).toBe(SINCE);
  const reads = seen.filter(({ url }) => url === `${ADMIN}/instances`).map(({ at }) => at);
  expect(reads).toHaveLength(2);
  expect((reads[1] ?? 0) - (reads[0] ?? 0)).toBeGreaterThanOrEqual(150);
});

const holding = (instances: Row[][], stops?: Audit[][]) => async () =>
  heldRunning((await platform(instances, stops)).admin, A, 20);
const retiring = (instances: Row[][], stops: Audit[][]) => async () =>
  idleRetired((await platform(instances, stops)).admin, A, SINCE, 300);
const restarted = { ...RUNNING, lastStartedAt: 2_000 };
const ADMIN_STOP = { ...IDLE, details: { reason: 'admin' } };
const AUDITS = /stop audits after the hold/;

it.each([
  ['A is not running before the hold', holding([[STOPPED]]), /running before the hold/],
  ['A stops during the hold', holding([[RUNNING], [STOPPED]]), /held running/],
  ['A restarts during the hold', holding([[RUNNING], [restarted]]), /held running/],
  ['a stop audit follows the hold', holding([[RUNNING]], [[], [IDLE]]), /held running/],
  ["A's row is missing", holding([[OTHER]]), /has 0 instance rows/],
  ["A's row is duplicated", holding([[RUNNING, OTHER, RUNNING]]), /has 2 instance rows/],
  ['A keeps running past the bound', retiring([[RUNNING]], [[IDLE]]), /last status running/],
  ['no stop audit follows', retiring([[STOPPED]], [[]]), AUDITS],
  ['two stop audits follow', retiring([[STOPPED]], [[IDLE, { ...IDLE, id: SINCE + 2 }]]), AUDITS],
  ['the stop is an administrator one', retiring([[STOPPED]], [[ADMIN_STOP]]), AUDITS],
  ['the stop has an actor', retiring([[STOPPED]], [[{ ...IDLE, actorEmail: A }]]), AUDITS],
])('fails when %s', async (_case, run, message) => {
  await expect(run()).rejects.toThrow(message);
});

it('polls until A is stopped, then returns the single idle stop after sinceId', async () => {
  const { admin, seen } = await platform([[RUNNING], [STOPPED]], [[IDLE]]);

  const stopped = await idleRetired(admin, A, SINCE, 1_000);

  expect(stopped).toEqual({ stoppedMs: stopped.stoppedMs, reason: 'idle' });
  const reads = seen.filter(({ url }) => url === `${ADMIN}/instances`).map(({ at }) => at);
  expect(reads).toHaveLength(2);
  expect(stopped.stoppedMs).toBeGreaterThanOrEqual((reads[1] ?? 0) - (reads[0] ?? 0) - 1);
});

it('names the method, path and status of a refused request, never the cookie', async () => {
  const { admin } = await platform([[RUNNING]]);
  const stranger = { ...admin, cookie: 'dsh_team_session=secret-cookie-value' };

  const refused = idleMinutes(stranger, 1);

  await expect(refused).rejects.toThrow(`GET ${ADMIN}/runtime-config answered 401`);
  await expect(refused).rejects.not.toThrow(/secret-cookie-value/);
});

it('prints the editor session by its screenshots and error counts', () => {
  const lists = {
    consoleErrors: ['a', 'b'],
    pageErrors: [],
    failedRequests: [],
    externalRequests: [],
  };
  const unloadViolations = ['web-apps/apps/documenteditor/main/app/controller/Main.js:2145'];
  const editor = {
    screenshots: ['office-editor-docx-saved.png'],
    unloadViolations,
    ...lists,
    requests: 9,
    websockets: 2,
  };
  const held = { heldMs: 210_004, status: 'running', restarted: false, idleStops: 0 };
  const file = { before: { size: 1, sha256: 'a' }, after: { size: 2, sha256: 'b' } };
  const fonts = { files: 11, families: ['SimHei'] };
  const stopped = { stoppedMs: 95_000, reason: 'idle' as const };
  const evidence = { held, fonts, file, editor, stopped, restored: true as const };

  const line = officeIdleLine(evidence);

  const counts = { consoleErrors: 2, pageErrors: 0, failedRequests: 0, externalRequests: 0 };
  const printed = { screenshots: editor.screenshots, unloadViolations, ...counts };
  expect(line).toEqual({ ...evidence, editor: printed });
  expect(() => officeIdleLine(undefined)).toThrow('Office idle evidence missing');
});

const CUSTOM = '/usr/share/fonts/truetype/custom';
// fc-scan's lines as the pinned Document Server prints them (§51-g): one per face, a .ttc twice.
const SCANNED = [
  `${CUSTOM}/simhei.ttf\tSimHei,黑体`,
  `${CUSTOM}/gb2312/fangsong.ttf\tFangSong_GB2312,仿宋_GB2312`,
  `${CUSTOM}/SourceHanSans.ttc\tSource Han Sans SC,思源黑体`,
  `${CUSTOM}/SourceHanSans.ttc\tSource Han Sans TC,思源黑體`,
  '',
].join('\n');
const FONTS = [
  { file: `${CUSTOM}/simhei.ttf`, families: ['SimHei', '黑体'] },
  { file: `${CUSTOM}/gb2312/fangsong.ttf`, families: ['FangSong_GB2312', '仿宋_GB2312'] },
  {
    file: `${CUSTOM}/SourceHanSans.ttc`,
    families: ['Source Han Sans SC', '思源黑体', 'Source Han Sans TC', '思源黑體'],
  },
];

it('runs fc-scan over the bound operator font directory inside the Document Server', () => {
  expect(OPERATOR_FONTS).toEqual([
    'exec',
    'dsh-team-documentserver',
    'fc-scan',
    '--format',
    '%{file}\t%{family}\n',
    '/usr/share/fonts/truetype/custom',
  ]);
});

it("groups fc-scan's faces by file with every family of each face", () => {
  expect(operatorFonts(SCANNED)).toEqual(FONTS);
  expect(() => operatorFonts('')).toThrow(/font directory .*custom has no font file/);
});

it('counts the files and sorts the matched families when every file has one in the editor', () => {
  const names = ['Arial', '黑体', 'FangSong_GB2312', 'Source Han Sans TC', 'SimHei', 'SimHei'];

  const shown = fontsShown(FONTS, names);

  expect(shown).toEqual({
    files: 3,
    families: ['FangSong_GB2312', 'SimHei', 'Source Han Sans TC', '黑体'],
  });
});

it.each([
  [
    'a file has no family among the names',
    ['SimHei', 'Source Han Sans SC'],
    /fangsong\.ttf.*FangSong_GB2312, 仿宋_GB2312/,
  ],
  ['the names are not an array', { Name: 'SimHei' }, /not a string array/],
  ['a name is not a string', ['SimHei', 7], /not a string array/],
])('fails the font check when %s', (_case, names, message) => {
  expect(() => fontsShown(FONTS, names)).toThrow(message);
});

const HELD = { heldMs: 210_004, status: 'running', restarted: false, idleStops: 0 };
const NAMES = ['SimHei', 'FangSong_GB2312', 'Source Han Sans SC'];
const SHOWN = { files: 3, families: ['FangSong_GB2312', 'SimHei', 'Source Han Sans SC'] };
const noRestore = () => Promise.resolve();
const putBodies = (seen: Seen[]) =>
  seen.filter(({ method }) => method === 'PUT').map(({ body }): unknown => JSON.parse(body));

/** A stand-in hold recording its arguments and how many requests the platform had seen by then. */
function standInHold(seen: Seen[]) {
  const calls: unknown[] = [];
  const hold = (admin: Admin, email: string, holdMs: number) => {
    calls.push({ admin, email, holdMs, requestsBefore: seen.length });
    return Promise.resolve({ held: HELD, sinceId: SINCE });
  };
  return { calls, hold };
}

it("sets one idle minute after the font check, holds for 210s and leaves the original's restore", async () => {
  const { admin, seen } = await platform([[RUNNING]]);
  const { calls, hold } = standInHold(seen);
  const idle = { restore: noRestore };

  const shown = await loaded(admin, A, FONTS, idle, () => Promise.resolve(NAMES), hold);
  const putsBefore = putBodies(seen);
  await idle.restore();

  expect(shown).toEqual({ fonts: SHOWN, hold: { held: HELD, sinceId: SINCE } });
  expect(calls).toEqual([{ admin, email: A, holdMs: 210_000, requestsBefore: 2 }]);
  expect(putsBefore).toEqual([{ ...CONFIG, idleMinutes: 1 }]);
  expect(putBodies(seen)).toEqual([{ ...CONFIG, idleMinutes: 1 }, CONFIG]);
});

it('leaves the runtime configuration and the restore untouched when the font check fails', async () => {
  const { admin, seen } = await platform([[RUNNING]]);
  const { calls, hold } = standInHold(seen);
  const idle = { restore: noRestore };

  const failed = loaded(admin, A, FONTS, idle, () => Promise.resolve(['SimHei']), hold);

  await expect(failed).rejects.toThrow(/fangsong\.ttf/);
  expect(putBodies(seen)).toEqual([]);
  expect(idle.restore).toBe(noRestore);
  expect(calls).toEqual([]);
});

const unused = () => Promise.reject(new Error('the stand-in body reads only the administrator'));
const RUN = {
  held: HELD,
  fonts: SHOWN,
  file: { before: { size: 1, sha256: 'a' }, after: { size: 2, sha256: 'b' } },
  editor: {
    ...{ screenshots: [], consoleErrors: [], pageErrors: [], failedRequests: [] },
    ...{ unloadViolations: [], externalRequests: [], requests: 0, websockets: 0 },
  },
  stopped: { stoppedMs: 95_000, reason: 'idle' as const },
};

/** A full idle lane whose members, but the administrator, reject: only the stand-in body runs. */
function idleLane(admin: Admin) {
  const session = { base: admin.base, directory: '', email: A, password: '', timeout: 1 };
  const readBack = { marker: '', command: '', nonce: '' };
  return {
    ...{ session, exec: unused, provider: unused, run: unused, namespaceRead: unused },
    ...{ reply: '', readBack, secondEmployee: unused, secondEmail: '', retire: unused },
    administrator: admin,
  };
}

/** A stand-in body that sets one idle minute through the real helper and counts its restores;
 * `restores: false` keeps the no-op restore, `fails` throws after the idle change. */
function standIn(options: { restores?: boolean; fails?: boolean } = {}) {
  const restored = { count: 0 };
  const body = async (lane: { administrator: Admin }, idle: { restore: () => Promise<void> }) => {
    const restore = await idleMinutes(lane.administrator, 1);
    if (options.restores !== false)
      idle.restore = () =>
        restore().then(() => {
          restored.count += 1;
        });
    if (options.fails === true) throw new Error('Office idle body failed');
    return RUN;
  };
  return { restored, body };
}

it('snapshots the runtime configuration, restores it once on success and reads it back equal', async () => {
  const { admin, seen } = await platform([[RUNNING]]);
  const { restored, body } = standIn();

  const evidence = await officeIdleScenario(idleLane(admin), body);

  expect(evidence).toEqual({ ...RUN, restored: true });
  expect(restored.count).toBe(1);
  const config = `${ADMIN}/runtime-config`;
  expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual(
    ['GET', 'GET', 'PUT', 'PUT', 'GET'].map((method) => `${method} ${config}`),
  );
  expect(putBodies(seen)).toEqual([{ ...CONFIG, idleMinutes: 1 }, CONFIG]);
});

it('fails when the read-back differs from the snapshot', async () => {
  const { admin } = await platform([[RUNNING]]);

  const run = officeIdleScenario(idleLane(admin), standIn({ restores: false }).body);

  await expect(run).rejects.toThrow(/runtime-config restored to its snapshot/);
});

it('restores the runtime configuration once and rethrows when the body fails', async () => {
  const { admin, seen } = await platform([[RUNNING]]);
  const { restored, body } = standIn({ fails: true });

  const run = officeIdleScenario(idleLane(admin), body);

  await expect(run).rejects.toThrow('Office idle body failed');
  expect(restored.count).toBe(1);
  expect(putBodies(seen)).toEqual([{ ...CONFIG, idleMinutes: 1 }, CONFIG]);
});
