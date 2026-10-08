import { expect, it } from 'vitest';
import { readKernelOomEvidence, validateResourceOomEvidence } from './resource-oom-fixture.ts';
import type { DockerCommandResult } from './docker-command.ts';

const identity = { runId: 'owned-invocation', containerId: 'c'.repeat(64) };
const limits = { 'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '512' };
const live = { Id: identity.containerId, State: { Running: true, OOMKilled: false, ExitCode: 0 } };
const killed = {
  Id: identity.containerId,
  State: { Running: false, OOMKilled: true, ExitCode: 137 },
};
const proof = {
  ...identity,
  requestedBytes: 536_870_912,
  touchedBytes: 8_388_608,
  oomKillBefore: 4,
  oomKillAfter: null,
  childSignal: null,
  limits,
};
const pressure: DockerCommandResult = { status: 137, stdout: '', stderr: '' };

it('accepts durable physical-touch evidence when the exact previously-live instance is OOM-killed', () => {
  const evidence = validateResourceOomEvidence(proof, identity, live, killed, pressure);

  expect(evidence).toEqual({
    requestedBytes: 536_870_912,
    touchedBytes: 8_388_608,
    oomKillBefore: 4,
    oomKillAfter: null,
    childSignal: null,
    limits,
    termination: 'instance',
  });
});

it('accepts child SIGKILL only with a fresh cgroup OOM counter increase', () => {
  const child = { ...proof, childSignal: 9, oomKillAfter: 5 };

  const evidence = validateResourceOomEvidence(child, identity, live, live, {
    ...pressure,
    status: 0,
  });

  expect(evidence).toEqual({
    requestedBytes: 536_870_912,
    touchedBytes: 8_388_608,
    oomKillBefore: 4,
    oomKillAfter: 5,
    childSignal: 9,
    limits,
    termination: 'child',
  });
});

it.each([
  ['no physical touch', { ...proof, touchedBytes: 0 }],
  ['completed oversized allocation', { ...proof, touchedBytes: 536_870_912 }],
  ['fractional progress', { ...proof, touchedBytes: 1.5 }],
  ['non-page-aligned progress', { ...proof, touchedBytes: 4097 }],
  ['nonfinite progress', { ...proof, touchedBytes: Infinity }],
  ['different allocation request', { ...proof, requestedBytes: 268_435_456 }],
  ['stale invocation', { ...proof, runId: 'previous-invocation' }],
  ['other container', { ...proof, containerId: 'd'.repeat(64) }],
  ['extra swap', { ...proof, limits: { ...limits, 'memory.swap.max': '268435456' } }],
  ['different memory ceiling', { ...proof, limits: { ...limits, 'memory.max': '536870912' } }],
  ['missing cgroup baseline', { ...proof, oomKillBefore: null }],
  ['negative cgroup baseline', { ...proof, oomKillBefore: -1 }],
])('rejects %s even when Docker reports instance OOM termination', (_name, invalid) => {
  expect(() => validateResourceOomEvidence(invalid, identity, live, killed, pressure)).toThrow();
});

it.each([
  ['exit137 alone', { ...killed, State: { ...killed.State, OOMKilled: false } }],
  ['a still-running instance', { ...killed, State: { ...killed.State, Running: true } }],
  ['normal termination', { ...killed, State: { ...killed.State, ExitCode: 0 } }],
  ['another instance', { ...killed, Id: 'd'.repeat(64) }],
])('rejects %s despite durable progress', (_name, after) => {
  expect(() => validateResourceOomEvidence(proof, identity, live, after, pressure)).toThrow();
});

it.each([
  ['already-dead instance', { ...live, State: { ...live.State, Running: false } }],
  ['previous OOM', { ...live, State: { ...live.State, OOMKilled: true } }],
  ['different original identity', { ...live, Id: 'd'.repeat(64) }],
])(
  'rejects %s rather than attributing startup failure to the pressure command',
  (_name, before) => {
    expect(() => validateResourceOomEvidence(proof, identity, before, killed, pressure)).toThrow();
  },
);

it.each([
  ['missing termination status', null],
  ['allocation exception', 1],
  ['timeout exit', 124],
])('rejects %s despite matching durable proof and Docker OOM state', (_name, status) => {
  expect(() =>
    validateResourceOomEvidence(proof, identity, live, killed, { ...pressure, status }),
  ).toThrow();
});

it.each([
  ['unchanged OOM counter', { ...proof, childSignal: 9, oomKillAfter: 4 }],
  ['non-OOM signal', { ...proof, childSignal: 14, oomKillAfter: 5 }],
  ['missing post-OOM counter', { ...proof, childSignal: 9 }],
])('rejects %s when only the child termination path is available', (_name, child) => {
  expect(() =>
    validateResourceOomEvidence(child, identity, live, live, { ...pressure, status: 0 }),
  ).toThrow();
});

it('retains the original external command error instead of accepting leftover OOM evidence', () => {
  const original = new Error('external timeout');
  let observed: unknown;
  try {
    validateResourceOomEvidence(proof, identity, live, killed, { ...pressure, error: original });
  } catch (error) {
    observed = error;
  }

  expect(observed).toBe(original);
});

const captured = {
  runId: '27b053eb-29b6-4a79-b74e-7916046fd4eb',
  containerId: '2bf41f8d86f88e11f0191819156658db89bfee4ac87d92a79e0946533ee4d324',
  pressureStartedAtMs: 1_791_437_119_796,
  pressureFinishedAtMs: 1_791_437_120_055,
};
const capturedBefore = {
  Id: captured.containerId,
  State: { Running: true, OOMKilled: false, ExitCode: 0 },
};
const capturedAfter = {
  Id: captured.containerId,
  State: { Running: false, OOMKilled: false, ExitCode: 137 },
};
const capturedProof = {
  ...proof,
  runId: captured.runId,
  containerId: captured.containerId,
  touchedBytes: 155_189_248,
  oomKillBefore: 0,
};
const capturedKernel = {
  containerId: captured.containerId,
  timestampUs: '1791437120034078',
  constraint: 'CONSTRAINT_MEMCG',
  oomMemcg: `/system.slice/docker-${captured.containerId}.scope`,
};
// Literal captured host record; task/process details must not survive projection.
const journalRow = {
  __REALTIME_TIMESTAMP: '1791437120034078',
  _TRANSPORT: 'kernel',
  MESSAGE:
    'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-2bf41f8d86f88e11f0191819156658db89bfee4ac87d92a79e0946533ee4d324.scope,mems_allowed=0,oom_memcg=/system.slice/docker-2bf41f8d86f88e11f0191819156658db89bfee4ac87d92a79e0946533ee4d324.scope,task_memcg=/system.slice/docker-2bf41f8d86f88e11f0191819156658db89bfee4ac87d92a79e0946533ee4d324.scope,task=MainThread,pid=261230,uid=1001',
};

it('accepts the captured exact-instance memcg kill when Docker loses the OOM flag but positive kernel proof is supplied', () => {
  const evidence = validateResourceOomEvidence(
    capturedProof,
    captured,
    capturedBefore,
    capturedAfter,
    pressure,
    capturedKernel,
  );

  expect(evidence).toEqual({
    requestedBytes: 536_870_912,
    touchedBytes: 155_189_248,
    oomKillBefore: 0,
    oomKillAfter: null,
    childSignal: null,
    termination: 'instance',
    limits,
    kernelOom: capturedKernel,
  });
});

it.each([
  ['missing host proof', undefined],
  ['malformed host proof', { ...capturedKernel, timestampUs: ['1791437120034078'] }],
  ['foreign container', { ...capturedKernel, containerId: 'd'.repeat(64) }],
  ['global OOM', { ...capturedKernel, constraint: 'CONSTRAINT_NONE' }],
  [
    'foreign memcg',
    { ...capturedKernel, oomMemcg: `/system.slice/docker-${'d'.repeat(64)}.scope` },
  ],
  ['child sub-cgroup', { ...capturedKernel, oomMemcg: `${capturedKernel.oomMemcg}/child` }],
  ['before pressure', { ...capturedKernel, timestampUs: '1791437119795999' }],
  ['after pressure', { ...capturedKernel, timestampUs: '1791437120056000' }],
])('rejects %s rather than using exit137 as OOM proof', (_name, kernel) => {
  expect(() =>
    validateResourceOomEvidence(
      capturedProof,
      captured,
      capturedBefore,
      capturedAfter,
      pressure,
      kernel,
    ),
  ).toThrow('Missing OOM-specific abnormal child or instance termination');
});

it('does not trust kernel claims embedded in child-owned durable proof', () => {
  expect(() =>
    validateResourceOomEvidence(
      { ...capturedProof, kernelOom: capturedKernel },
      captured,
      capturedBefore,
      capturedAfter,
      pressure,
    ),
  ).toThrow('Missing OOM-specific abnormal child or instance termination');
});

it.each([
  [
    'still-running instance',
    { ...capturedAfter, State: { ...capturedAfter.State, Running: true } },
  ],
  ['normal instance exit', { ...capturedAfter, State: { ...capturedAfter.State, ExitCode: 0 } }],
  ['foreign stopped instance', { ...capturedAfter, Id: 'd'.repeat(64) }],
])('rejects %s despite positive kernel OOM proof', (_name, after) => {
  expect(() =>
    validateResourceOomEvidence(
      capturedProof,
      captured,
      capturedBefore,
      after,
      pressure,
      capturedKernel,
    ),
  ).toThrow();
});

it.each([
  ['no physical touch', { ...capturedProof, touchedBytes: 0 }],
  ['virtual allocation completed', { ...capturedProof, touchedBytes: 536_870_912 }],
  ['additional swap', { ...capturedProof, limits: { ...limits, 'memory.swap.max': '268435456' } }],
  ['raised memory limit', { ...capturedProof, limits: { ...limits, 'memory.max': '536870912' } }],
  ['foreign invocation', { ...capturedProof, runId: 'another-invocation' }],
  ['missing initial counter', { ...capturedProof, oomKillBefore: null }],
])('rejects %s despite positive kernel OOM proof', (_name, invalid) => {
  expect(() =>
    validateResourceOomEvidence(
      invalid,
      captured,
      capturedBefore,
      capturedAfter,
      pressure,
      capturedKernel,
    ),
  ).toThrow();
});

it('projects only causal fields from the exact current-boot host kernel query', () => {
  const evidence = readKernelOomEvidence(captured, (executable, args, options) => {
    expect(executable).toBe('/usr/bin/sudo');
    expect(args).toEqual([
      '-n',
      '/usr/bin/journalctl',
      '--boot=0',
      '--kernel',
      '--quiet',
      '--no-pager',
      '--since',
      '@1791437119.796000',
      '--until',
      '@1791437120.055999',
      '--grep',
      '^oom-kill:constraint=CONSTRAINT_MEMCG,([^,]*,)*oom_memcg=/system[.]slice/docker-2bf41f8d86f88e11f0191819156658db89bfee4ac87d92a79e0946533ee4d324[.]scope(,|$)',
      '--output=json',
      '--output-fields=__REALTIME_TIMESTAMP,_TRANSPORT,MESSAGE',
    ]);
    expect(options).toEqual({
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
    });
    return {
      status: 0,
      stdout: JSON.stringify({ ...journalRow, SECRET: 'never return' }),
      stderr: '',
    };
  });

  expect(evidence).toEqual(capturedKernel);
});

it.each([
  ['absent record', ''],
  ['malformed JSON', '{sensitive malformed journal'],
  ['non-object record', 'null'],
  ['non-kernel transport', JSON.stringify({ ...journalRow, _TRANSPORT: 'stdout' })],
  [
    'array timestamp',
    JSON.stringify({ ...journalRow, __REALTIME_TIMESTAMP: ['1791437120034078'] }),
  ],
  ['before pressure', JSON.stringify({ ...journalRow, __REALTIME_TIMESTAMP: '1791437119795999' })],
  ['after pressure', JSON.stringify({ ...journalRow, __REALTIME_TIMESTAMP: '1791437120056000' })],
  [
    'global OOM',
    JSON.stringify({
      ...journalRow,
      MESSAGE: journalRow.MESSAGE.replace('CONSTRAINT_MEMCG', 'CONSTRAINT_NONE'),
    }),
  ],
  [
    'foreign oom memcg with matching cpuset and task memcg',
    JSON.stringify({
      ...journalRow,
      MESSAGE: journalRow.MESSAGE.replace(
        `oom_memcg=${capturedKernel.oomMemcg}`,
        `oom_memcg=/system.slice/docker-${'d'.repeat(64)}.scope`,
      ),
    }),
  ],
  [
    'duplicate causal field',
    JSON.stringify({ ...journalRow, MESSAGE: `${journalRow.MESSAGE},constraint=CONSTRAINT_MEMCG` }),
  ],
  ['valid record followed by malformed data', `${JSON.stringify(journalRow)}\ninvalid`],
  ['too many records', `${JSON.stringify(journalRow)}\n`.repeat(33)],
  ['oversized output', 's'.repeat(65_537)],
])('fails closed on %s from the host journal', (_name, stdout) => {
  const evidence = readKernelOomEvidence(captured, () => ({ status: 0, stdout, stderr: '' }));

  expect(evidence).toBeNull();
});

it.each([
  ['permission failure', { status: 1, stdout: '', stderr: 'private host error' }],
  [
    'timeout',
    {
      status: null,
      stdout: JSON.stringify(journalRow),
      stderr: '',
      error: new Error('private timeout'),
    },
  ],
  [
    'overflow',
    {
      status: null,
      stdout: JSON.stringify(journalRow),
      stderr: '',
      error: new Error('private maxBuffer'),
    },
  ],
  [
    'warning with otherwise valid output',
    { status: 0, stdout: JSON.stringify(journalRow), stderr: 'private warning' },
  ],
])('fails closed without exposing host errors on %s', (_name, result) => {
  expect(readKernelOomEvidence(captured, () => result)).toBeNull();
});

it('fails closed when the external journal process throws', () => {
  expect(
    readKernelOomEvidence(captured, () => {
      throw new Error('private host failure');
    }),
  ).toBeNull();
});

it.each([
  ['missing window', { runId: captured.runId, containerId: captured.containerId }],
  ['invalid container ID', { ...captured, containerId: '.*' }],
  ['reversed window', { ...captured, pressureFinishedAtMs: 1_791_437_119_795 }],
  ['unbounded window', { ...captured, pressureFinishedAtMs: 1_791_437_149_797 }],
  ['fractional time', { ...captured, pressureStartedAtMs: 1.5 }],
  ['nonfinite time', { ...captured, pressureFinishedAtMs: Infinity }],
])('does not query unrelated journal logs for %s', (_name, invalid) => {
  let invoked = false;
  const evidence = readKernelOomEvidence(invalid, () => {
    invoked = true;
    return { status: 0, stdout: JSON.stringify(journalRow), stderr: '' };
  });

  expect(evidence).toBeNull();
  expect(invoked).toBe(false);
});

it.each(['1791437119796000', '1791437120055999'])(
  'accepts a kernel kill at the inclusive pressure-window boundary %s',
  (timestampUs) => {
    const evidence = readKernelOomEvidence(captured, () => ({
      status: 0,
      stdout: JSON.stringify({ ...journalRow, __REALTIME_TIMESTAMP: timestampUs }),
      stderr: '',
    }));

    expect(evidence).toEqual({ ...capturedKernel, timestampUs });
  },
);

it('accepts bounded host proof at the row and byte limits without leaking unrelated fields', () => {
  const rows = `${JSON.stringify(journalRow)}\n`.repeat(32);
  const prefix = JSON.stringify({ ...journalRow, unrelated: '' });
  const atByteLimit = JSON.stringify({
    ...journalRow,
    unrelated: 'x'.repeat(65_536 - Buffer.byteLength(prefix)),
  });

  expect(
    readKernelOomEvidence(captured, () => ({
      status: 0,
      stdout: rows,
      stderr: '',
    })),
  ).toEqual(capturedKernel);
  expect(
    readKernelOomEvidence(captured, () => ({
      status: 0,
      stdout: atByteLimit,
      stderr: '',
    })),
  ).toEqual(capturedKernel);
});

it.each([
  ['already stopped', { ...capturedBefore, State: { ...capturedBefore.State, Running: false } }],
  ['previous OOM', { ...capturedBefore, State: { ...capturedBefore.State, OOMKilled: true } }],
])('rejects an instance %s before pressure despite positive kernel proof', (_name, before) => {
  expect(() =>
    validateResourceOomEvidence(
      capturedProof,
      captured,
      before,
      capturedAfter,
      pressure,
      capturedKernel,
    ),
  ).toThrow('OOM pressure requires the exact live instance without a prior OOM');
});

it.each([0, 1, 124, null])(
  'rejects pressure status %s for the kernel instance-termination path',
  (status) => {
    expect(() =>
      validateResourceOomEvidence(
        capturedProof,
        captured,
        capturedBefore,
        capturedAfter,
        { ...pressure, status },
        capturedKernel,
      ),
    ).toThrow();
  },
);
