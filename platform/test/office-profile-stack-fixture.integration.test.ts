import { expect, it } from 'vitest';
import { record } from './docker-cleanup.ts';
import {
  afterScript,
  callbackScript,
  EXPECTED_PROFILE,
  officeProfileLine,
  officeProfileScenario,
  PROFILE_EDIT,
  PROFILE_RESTORE,
  registerScript,
  REWRITTEN_URL,
} from './office-profile-stack-fixture.ts';
import type { OfficeProfileLane } from './office-profile-stack-fixture.ts';

const [A, A2] = ['10.0.0.2', '10.0.2.2'];
const SECRETS = { k1: 'a1'.repeat(32), k0: 'c0'.repeat(32) };
const HEX = /[0-9a-f]{64}/;
const contains = (script: string, parts: readonly string[]) => {
  for (const part of parts) expect(script).toContain(part);
};

it('checks that port 9 has no listener in A before registering k1_old for the restart target (d1)', () => {
  const script = registerScript(A);

  contains(script, [
    'const file = "/data/work/重启登记.docx";',
    "const probe = connect({ host: '127.0.0.1', port: 9 });",
    "probe.on('error', () => resolve(false));",
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    'Object.assign(observed, { k0, k1 });',
  ]);
  expect(script.indexOf('port: 9')).toBeLessThan(script.indexOf('writeFileSync(file'));
  expect(REWRITTEN_URL).toBe('http://127.0.0.1:9');
});

it('backs the profile bytes up, then pushes the argv row and writes the file back in the editor dialect (d1)', () => {
  contains(PROFILE_EDIT, [
    "const profile = '/data/home/profiles/web/cordis.patch.yml';",
    "const backup = profile + '.dsh-team-office-profile';",
    "existsSync(profile) ? readFileSync(profile).toString('base64') : null }), { flag: 'wx' });",
    "parsed.push({ id: 'dsh-sidebar-onlyoffice', config: { documentServerUrl: process.argv[1], jwtSecret: process.argv[2] } });",
    'const bytes = dump(parsed, { lineWidth: -1 });',
    'const serializedProfile = String(editorDocument);',
    'writeFileSync(profile, serializedProfile);',
    "row?.id === 'dsh-sidebar-onlyoffice' && row.config?.documentServerUrl === process.argv[1] && row.config?.jwtSecret === process.argv[2]",
  ]);
  expect(PROFILE_EDIT.indexOf('writeFileSync(backup')).toBeLessThan(
    PROFILE_EDIT.indexOf('parsed.push'),
  );
});

it('writes the saved bytes back, or deletes a profile that did not exist, then drops the backup (d5)', () => {
  contains(PROFILE_RESTORE, [
    "const backup = profile + '.dsh-team-office-profile';",
    "const { bytes } = JSON.parse(readFileSync(backup, 'utf8'));",
    "if (bytes === null) rmSync(profile, { force: true });\nelse writeFileSync(profile, Buffer.from(bytes, 'base64'));",
    'rmSync(backup);',
    "observed.restored = (existsSync(profile) ? readFileSync(profile).toString('base64') : null) === bytes;",
    'observed.backup = existsSync(backup);',
  ]);
  expect(PROFILE_RESTORE).not.toContain('parsed.push');
});

it('reads the healthcheck at the new address with a loopback Host and keys the same input anew (d3)', () => {
  const script = afterScript(A2);

  contains(script, [
    'const file = "/data/work/重启登记.docx";',
    'kept.includes(process.argv[1]) && kept.includes(process.argv[2]);',
    'request({ host: "10.0.2.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    "exchange('GET', '/sidebar/onlyoffice/ds/healthcheck')",
    "'/data/home/plugins/dsh-sidebar-onlyoffice/registry.json'",
    'entries.some((e) => e.key === process.argv[3])',
    'observed.sameInput = k0 === process.argv[4];',
    'observed.rekeyed = k1 !== undefined && k1 !== process.argv[3];',
  ]);
});

it("calls an unregistered key back under the overlay's JWT secret, then under the rewritten one (d4)", () => {
  const script = callbackScript(A, 'KEY', 'REWRITTEN');

  contains(script, [
    'let jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;',
    "createHmac('sha256', jwtSecret).update(signed).digest('base64url')",
    "const headers = { host: '10.0.0.2:3080' };",
    "const url = 'http://10.0.0.2:3080/sidebar/onlyoffice/file?token=unregistered';",
    "'/sidebar/onlyoffice/callback', { key, status: 2, url, ...(signed ? { token: jwt() } : {}) }",
  ]);
  const order = [
    'observed.managed = await callback("KEY", true);',
    'jwtSecret = "REWRITTEN";',
    'observed.rewritten = await callback("KEY", true);',
  ].map((part) => script.indexOf(part));
  expect(order[0]).toBeGreaterThan(0);
  expect(order).toEqual([...order].sort((x, y) => x - y));
});

it('expects the overlay to win after the restart while the employee row and k1_old survive it', () => {
  expect(EXPECTED_PROFILE).toEqual({
    register: {
      listener: false,
      config: { status: 200, signed: true },
      registry: { k0: false, k1: true },
    },
    edit: { rewritten: true },
    after: {
      rewritten: true,
      health: { status: 200, body: 'true' },
      registry: { k1Old: true },
      sameInput: true,
      rekeyed: true,
    },
    callback: { managed: { status: 200, error: 1 }, rewritten: { status: 403, error: 4 } },
    restore: { restored: true, backup: false },
  });
  expect(() => officeProfileLine(undefined)).toThrow('Office profile evidence missing');
});

/** A answering as the stack does, at A2 after `restart`; each `failing` step rejects quoting argv
 * as `output()` would, or answers with both keys and a differing observation. */
function fakeLane(
  events: string[],
  calls: Record<string, readonly string[]>,
  failing = '',
  how = '',
) {
  let address = A;
  const answer = (label: string, args: readonly string[], reply: object) => {
    events.push(label);
    calls[label] = args;
    if (!failing.split(' ').includes(label)) return Promise.resolve(JSON.stringify(reply));
    if (how === 'differ')
      return Promise.resolve(
        JSON.stringify({ ...reply, ...SECRETS, rewritten: false, listener: true, restored: false }),
      );
    return Promise.reject(new Error(`docker ${args.join(' ')} failed (null): ETIMEDOUT`));
  };
  const { register, edit, after, callback, restore } = EXPECTED_PROFILE;
  const replies = [
    ['{ k0, k1 }', 'd1', { ...register, ...SECRETS }],
    ['parsed.push', 'edit', edit],
    ['observed.rekeyed', 'd3', after],
    ['rmSync(backup)', 'd5', restore],
  ] as const;
  const parsed = async (reply: Promise<string>) => record(JSON.parse(await reply));
  const lane: OfficeProfileLane = {
    ...{ session: {} as never, instance: 'dsh-team-u-a' },
    run: () => Promise.resolve(JSON.stringify({ 'dsh-team-net-a': { IPAddress: address } })),
    exec: (args) => {
      const [, label, reply] = replies.find(([part]) => args[3]?.includes(part)) ?? [
        '',
        'clean',
        [false],
      ];
      return answer(label, args, reply);
    },
    platformRead: (script) => parsed(answer('d4', [script], callback)),
    provider: () => parsed(answer('provider', [], { requests: 0, searches: 0, delegations: 0 })),
    restart: () => answer('restart', ['restart', SECRETS.k1], {}).then(() => void (address = A2)),
  };
  return lane;
}

it('registers, rewrites, restarts, checks A and the platform, restores the profile, then counts the provider', async () => {
  const [events, calls]: [string[], Record<string, readonly string[]>] = [[], {}];
  const evidence = officeProfileLine(await officeProfileScenario(fakeLane(events, calls)));

  expect(evidence).toEqual(EXPECTED_PROFILE);
  expect(events.join(' ')).toBe('provider d1 edit restart d3 d4 d5 provider clean');
  const [secret] = calls.edit?.slice(5) ?? [];
  expect(calls.edit?.slice(4)).toEqual([REWRITTEN_URL, expect.stringMatching(/^[0-9a-f]{64}$/)]);
  expect(calls.d3?.slice(4)).toEqual([REWRITTEN_URL, secret, SECRETS.k1, SECRETS.k0]);
  expect(calls.d3?.[3]).toContain('request({ host: "10.0.2.2"');
  expect(calls.d4?.[0]).toContain(`jwtSecret = "${secret ?? ''}";`);
  expect(calls.d4?.[0]).toContain("const headers = { host: '10.0.2.2:3080' };");
  expect(JSON.stringify(evidence)).not.toMatch(HEX);
});

it.each([
  ['d1', 'reject', 'ETIMEDOUT'],
  ['edit', 'reject', 'ETIMEDOUT'],
  ['d3', 'reject', 'ETIMEDOUT'],
  ['d4', 'reject', 'ETIMEDOUT'],
  ['d1', 'differ', 'differs'],
  ['edit', 'differ', 'differs'],
  ['d3', 'differ', 'differs'],
  ['d4', 'differ', 'differs'],
  ['d5', 'differ', 'differs'],
  ['restart', 'reject', 'docker restart <redacted> failed'],
  ['d5', 'reject', 'profile restore failed'],
  ['d3 d5', 'reject', /profile after failed[\s\S]*\nOffice isolation profile restore failed/],
])(
  'redacts every key and secret from the %s step answering %s and restores once the edit began',
  async (step, how, reason) => {
    const events: string[] = [];
    const lane = fakeLane(events, {}, step, how);
    const error: unknown = await officeProfileScenario(lane).catch((caught: unknown) => caught);

    if (!(error instanceof Error)) throw new Error('Office profile scenario did not fail');
    expect(error.message).toMatch(reason);
    expect(error.message).not.toMatch(HEX);
    expect(error.message).not.toContain(SECRETS.k1.slice(0, 10));
    expect(error.cause).toBeUndefined();
    expect(events.filter((event) => event === 'd5')).toHaveLength(step === 'd1' ? 0 : 1);
  },
);
