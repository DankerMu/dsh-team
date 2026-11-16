import { expect, it } from 'vitest';
import {
  aSetupScript,
  bProbeScript,
  EXPECTED_ISOLATION,
  officeIsolationLine,
  redactSecrets,
} from './office-isolation-stack-fixture.ts';

const A = '10.0.0.2';
const B = '10.0.1.2';

it("writes both files, requests A's config with a loopback Host and waits for k1 without k0 (c1)", () => {
  const script = aSetupScript(A);

  for (const part of [
    'const secret = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET;',
    'writeFileSync("/data/work/隔离来源.docx"',
    'const file = "/data/work/隔离目标.docx";',
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    "'/sidebar/onlyoffice/config?sessionId=t&path='",
    "'/data/home/plugins/dsh-sidebar-onlyoffice/registry.json'",
    'while ((!seen.k1 || seen.k0) && Date.now() < deadline)',
    'observed.k1 = k1;',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('process.argv');
});

it('probes A then B over TCP and signs T_B over the claims in argv[1] (c2)', () => {
  const script = bProbeScript(A, B);

  for (const part of [
    'observed.connect = { a: await probe("10.0.0.2"), b: await probe("10.0.1.2") };',
    "setTimeout(() => { socket.destroy(); resolve('blocked'); }, 3000)",
    "socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });",
    'request({ host: "10.0.1.2", port: 3080',
    'const tB = mint(JSON.parse(process.argv[1]), secret);',
    "'/sidebar/onlyoffice/file?token=' + encodeURIComponent(tB)",
    'observed.kB = k1;',
  ])
    expect(script).toContain(part);
  // Only the probe reaches A; every HTTP request goes to B's own address.
  expect(script).not.toContain('request({ host: "10.0.0.2"');
});

it('expects A to register only k1 and B to reach only itself with a valid B token', () => {
  expect(EXPECTED_ISOLATION).toEqual({
    a: { config: { status: 200, signed: true }, registry: { k0: false, k1: true } },
    b: {
      connect: { a: 'blocked', b: 'connected' },
      config: { status: 200, signed: true },
      file: { status: 404, body: 'file not found' },
    },
  });
});

it('redacts k1, k1_B and T_B from an error text', () => {
  const [k1, kB, tB] = ['k1-value', 'kb-value', 'tb.value'];
  const message = `observed={"k1":"${k1}","kB":"${kB}","tB":"${tB}"} again ${k1}`;

  const redacted = redactSecrets(message, [k1, kB, tB, undefined, '']);

  expect(redacted).toBe(
    'observed={"k1":"<redacted>","kB":"<redacted>","tB":"<redacted>"} again <redacted>',
  );
});

it('prints the verified observations and fails when the scenario left none', () => {
  const evidence = { a: EXPECTED_ISOLATION.a, b: EXPECTED_ISOLATION.b };

  expect(officeIsolationLine(evidence)).toBe(evidence);
  expect(() => officeIsolationLine(undefined)).toThrow('Office isolation evidence missing');
});
