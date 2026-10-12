import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { qualifyBrowserConfinement } from '../../scripts/probe-browser-confinement.mjs';
import {
  browserDocker,
  isolatedBrowserRuntime,
  processBirth,
  registerChrome,
  rescueChrome,
  startIsolated,
} from '../../scripts/probe-browser-runtime.mjs';
import { OwnedBrowserChurn, withIsolatedBrowser } from './browser-runtime-fixture.ts';
import { record } from './container-start-docker-fixture.ts';

type NetworkFault =
  | 'valid'
  | 'wrong-nonce'
  | 'wrong-gateway-mode'
  | 'ipv6-enabled'
  | 'recorded-id-replacement'
  | 'finalized-null-identity';
const networkFaults: NetworkFault[] = [
  'wrong-nonce',
  'wrong-gateway-mode',
  'ipv6-enabled',
  'recorded-id-replacement',
  'finalized-null-identity',
];

async function pendingNetwork(fault: NetworkFault) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-network-identity-'));
  const profile = join(root, 'profile');
  const receiptFile = join(root, 'chrome.receipt.json');
  await mkdir(profile, { mode: 0o700 });
  const runtime = isolatedBrowserRuntime();
  const receipt = await registerChrome({
    runtime,
    origin: 'http://127.0.0.1:12345',
    profile,
    receiptFile,
  });
  if (typeof receipt.networkName !== 'string' || typeof receipt.nonce !== 'string')
    throw new Error('Pending network authority missing');
  const options = record(record(receipt.networkConfig).options);
  const bridge = options['com.docker.network.bridge.name'];
  if (typeof bridge !== 'string') throw new Error('Pending bridge authority missing');
  const labels = {
    'dsh-team.test-run': runtime.runId,
    'dsh-team.browser-nonce': fault === 'wrong-nonce' ? 'foreign-nonce' : receipt.nonce,
    'dsh-team.role': 'verification-browser-network',
  };
  const args = [
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    `--ipv6=${fault === 'ipv6-enabled' ? 'true' : 'false'}`,
    '--opt',
    `com.docker.network.bridge.name=${bridge}`,
    '--opt',
    `com.docker.network.bridge.gateway_mode_ipv4=${fault === 'wrong-gateway-mode' ? 'nat' : 'isolated'}`,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
  ];
  if (fault === 'ipv6-enabled') args.push('--subnet', `fd17:${receipt.nonce.slice(0, 4)}::/64`);
  args.push(receipt.networkName);
  let id: string | undefined;
  let recordedId: string | null = null;
  const cleanup = async () => {
    if (id) {
      const remaining = browserDocker([
        'network',
        'ls',
        '--filter',
        `id=${id}`,
        '--quiet',
        '--no-trunc',
      ]);
      if (remaining !== '') {
        const rows: unknown = JSON.parse(browserDocker(['network', 'inspect', id]));
        if (!Array.isArray(rows) || rows.length !== 1)
          throw new Error('Fixture network identity unavailable');
        const network = record(rows[0]);
        expect(network.Id).toBe(id);
        expect(network.Name).toBe(receipt.networkName);
        expect(record(network.Labels)).toEqual(labels);
        expect(Object.keys(record(network.Containers))).toEqual([]);
        browserDocker(['network', 'rm', id]);
      }
    }
    await rescueChrome(receiptFile);
    await rm(root, { recursive: true, force: true });
  };
  try {
    id = browserDocker(args);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    if (fault === 'recorded-id-replacement') {
      recordedId = id;
      browserDocker(['network', 'rm', id]);
      id = browserDocker(args);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      expect(id).not.toBe(recordedId);
    }
    await writeFile(
      receiptFile,
      JSON.stringify({
        ...receipt,
        networkId: recordedId,
        state: fault === 'finalized-null-identity' ? 'stopped' : 'pending-identity',
        acquisition: { state: 'settled', failure: 'network-create-output-interrupted' },
      }),
      { mode: 0o600 },
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { id, recordedId, receipt, receiptFile, runtime, profile, cleanup };
}

it('naturally reports online while the actual image remains confined to its stable isolated bridge', async () => {
  const server = createServer((_request, response) => response.end('owned'));
  await withIsolatedBrowser(server, async (browser, _origin, receipt) => {
    const result = record(
      await browser.page.send('Runtime.evaluate', {
        expression: 'navigator.onLine',
        returnByValue: true,
      }),
    );
    expect(record(result.result).value).toBe(true);

    const proof = await qualifyBrowserConfinement(receipt);

    expect(proof).toMatchObject({
      namespaceDistinct: true,
      noIPv4DefaultRoute: true,
      privateIPv4Present: true,
      onlyLoopbackIPv6: true,
      eth0IPv6Disabled: true,
      hostIPv4Blocked: true,
      linkScopeIPv6Blocked: true,
      hostBridgeNoIPv4: true,
      stableAttachment: true,
    });
    expect(browser.errors).toEqual([]);
  });
});

it('adopts a settled pending network without a container and proves repeated retirement absence', async () => {
  const fixture = await pendingNetwork('valid');
  try {
    await rescueChrome(fixture.receiptFile);
    await rescueChrome(fixture.receiptFile);

    const receipt = record(JSON.parse(await readFile(fixture.receiptFile, 'utf8')));
    expect(receipt).toMatchObject({ networkId: fixture.id, containerId: null, state: 'stopped' });
    expect(record(receipt.acquisition)).toMatchObject({
      state: 'settled',
      failure: 'network-create-output-interrupted',
    });
    expect(
      browserDocker([
        'network',
        'ls',
        '--filter',
        `label=dsh-team.browser-nonce=${String(fixture.receipt.nonce)}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
  } finally {
    await fixture.cleanup();
  }
});

it.each(networkFaults)('refuses network %s without mutating that resource', async (fault) => {
  const fixture = await pendingNetwork(fault);
  try {
    const before = browserDocker(['network', 'inspect', fixture.id]);

    await expect(rescueChrome(fixture.receiptFile)).rejects.toThrow();

    expect(browserDocker(['network', 'inspect', fixture.id]) === before).toBe(true);
    const receipt = record(JSON.parse(await readFile(fixture.receiptFile, 'utf8')));
    expect(receipt.state).toBe(
      fault === 'finalized-null-identity' ? 'stopped' : 'pending-identity',
    );
    expect(receipt.containerId).toBeNull();
    expect(receipt.networkId).toBe(fixture.recordedId);
  } finally {
    await fixture.cleanup();
  }
});

it('retains a definite network acquisition failure without claiming absence or deleting the conflicting resource', async () => {
  const fixture = await pendingNetwork('wrong-nonce');
  try {
    const before = browserDocker(['network', 'inspect', fixture.id]);

    await expect(
      startIsolated(
        {
          runtime: fixture.runtime,
          origin: 'http://127.0.0.1:12345',
          profile: fixture.profile,
          receiptFile: fixture.receiptFile,
        },
        fixture.receipt,
      ),
    ).rejects.toThrow();

    const receipt = record(JSON.parse(await readFile(fixture.receiptFile, 'utf8')));
    expect(receipt).toMatchObject({
      state: 'pending-identity',
      networkId: null,
      containerId: null,
      acquisition: { state: 'settled', failure: 'network-create' },
    });
    expect(browserDocker(['network', 'inspect', fixture.id]) === before).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it('refuses an unexpected network peer before stopping the live matching browser or removing the peer', async () => {
  const server = createServer((_request, response) => response.end('owned'));
  await withIsolatedBrowser(server, async (browser, _origin, receipt) => {
    const churn = new OwnedBrowserChurn();
    try {
      await churn.prepare();
      const peer = churn.helper;
      if (!peer) throw new Error('Foreign-peer fixture authority missing');
      browserDocker(['network', 'connect', receipt.networkId, peer.id]);
      const receiptFile = join(dirname(receipt.profile), 'chrome.receipt.json');

      await expect(rescueChrome(receiptFile)).rejects.toThrow('unexpected peers');

      expect(
        browserDocker(['container', 'inspect', '--format', '{{.State.Running}}', peer.id]),
      ).toBe('true');
      expect(
        browserDocker([
          'container',
          'inspect',
          '--format',
          '{{.State.Running}}',
          receipt.containerId,
        ]),
      ).toBe('true');
      const result = record(
        await browser.page.send('Runtime.evaluate', {
          expression: '6 * 7',
          returnByValue: true,
        }),
      );
      expect(record(result.result).value).toBe(42);
      const rows: unknown = JSON.parse(browserDocker(['network', 'inspect', receipt.networkId]));
      if (!Array.isArray(rows) || rows.length !== 1)
        throw new Error('Occupied network witness missing');
      expect(Object.keys(record(record(rows[0]).Containers)).sort()).toEqual(
        [receipt.containerId, peer.id].sort(),
      );
    } finally {
      // The fixture retires its independently owned peer; rescue never force-disconnects it.
      churn.cleanup();
    }
  });
});

it('retires a confirmed stopped browser before its detached empty network and proves repeated absence', async () => {
  const server = createServer((_request, response) => response.end('owned'));
  await withIsolatedBrowser(server, async (_browser, _origin, receipt) => {
    const receiptFile = join(dirname(receipt.profile), 'chrome.receipt.json');
    browserDocker(['stop', '--time', '8', receipt.containerId]);
    expect(
      browserDocker(['container', 'inspect', '--format', '{{.State.Status}}', receipt.containerId]),
    ).toBe('exited');
    const rows: unknown = JSON.parse(browserDocker(['network', 'inspect', receipt.networkId]));
    if (!Array.isArray(rows) || rows.length !== 1)
      throw new Error('Stopped network witness missing');
    expect(Object.keys(record(record(rows[0]).Containers))).toEqual([]);

    await rescueChrome(receiptFile);
    await rescueChrome(receiptFile);

    const retired = record(JSON.parse(await readFile(receiptFile, 'utf8')));
    expect(retired).toMatchObject({
      state: 'stopped',
      containerId: receipt.containerId,
      networkId: receipt.networkId,
    });
    expect(
      browserDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
    expect(
      browserDocker([
        'network',
        'ls',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
  });
});

it('marks a dead unsettled producer uncertain without adopting its pending network or claiming absence', async () => {
  const fixture = await pendingNetwork('valid');
  const original = await readFile(fixture.receiptFile, 'utf8');
  const producer = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const exited = once(producer, 'exit');
  try {
    await once(producer, 'spawn');
    if (!producer.pid) throw new Error('Producer process identity missing');
    const identity = { pid: producer.pid, birth: await processBirth(producer.pid) };
    producer.stdin.end();
    await exited;
    const before = browserDocker(['network', 'inspect', fixture.id]);
    await writeFile(
      fixture.receiptFile,
      JSON.stringify({
        ...record(JSON.parse(original)),
        acquisition: { state: 'creating', resource: 'network', producer: identity },
      }),
    );

    await expect(rescueChrome(fixture.receiptFile)).rejects.toThrow('unsettled');

    const receipt = record(JSON.parse(await readFile(fixture.receiptFile, 'utf8')));
    expect(receipt).toMatchObject({
      state: 'pending-identity',
      networkId: null,
      containerId: null,
      acquisition: { state: 'uncertain', failure: 'producer-exited-before-settlement' },
    });
    expect(browserDocker(['network', 'inspect', fixture.id]) === before).toBe(true);
  } finally {
    if (producer.exitCode === null && !producer.signalCode) producer.kill('SIGKILL');
    await exited;
    await writeFile(fixture.receiptFile, original);
    await fixture.cleanup();
  }
});
