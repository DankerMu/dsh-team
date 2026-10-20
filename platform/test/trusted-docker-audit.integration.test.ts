import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assessTrustedDockerCleanup } from '../../scripts/trusted-docker-audit.mjs';
import { writeReceipt } from '../../scripts/probe-browser-receipt.mjs';
import { liveProcessBirth, processBirth } from '../../scripts/probe-browser-native.mjs';
import { record } from './container-start-docker-fixture.ts';
import type { DockerCommand } from './docker-command.ts';

interface AuditContext {
  pointer: string;
  receipt: Record<string, unknown>;
  temporary: string;
  journal: string;
  command: DockerCommand;
  assess: (settled?: boolean, external?: DockerCommand) => Promise<{ state: string }>;
}

async function withAuditReceipt(run: (context: AuditContext) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-custody-audit-')));
  try {
    const directory = join(root, 'custody');
    const temporary = join(root, 'temporary');
    await mkdir(directory, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(join(directory, 'resources.jsonl'), '', { mode: 0o600 });
    const browser = join(temporary, `dsh-browser-command-${randomUUID()}`);
    await mkdir(browser, { mode: 0o700 });
    const profile = join(browser, 'profile');
    await mkdir(profile, { mode: 0o700 });
    const receiptFile = join(browser, 'chrome.receipt.json');
    const imageId = `sha256:${'a'.repeat(64)}`;
    const input = {
      profile,
      receiptFile,
      runtime: {
        kind: 'docker-isolated-network',
        imageId,
        chromeSha256: 'b'.repeat(64),
        runId: 'owned-audit-fixture',
      },
    };
    // Canonical registration runs in a real short-lived owner; no browser/Engine is started.
    const module = new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url).href;
    const cleanupModule = new URL('./docker-cleanup.ts', import.meta.url).href;
    const runId = randomUUID();
    const target = { kind: 'network', name: `dsh-team-audit-${runId}` };
    const registered = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {registerChrome} from ${JSON.stringify(module)};
import {registerCleanupTarget} from ${JSON.stringify(cleanupModule)};
registerCleanupTarget([],${JSON.stringify(runId)},${JSON.stringify(target)});
await registerChrome(${JSON.stringify(input)});`,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          LANG: 'C',
          DSH_TEAM_CI_RESOURCE_JOURNAL: join(directory, 'resources.jsonl'),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(registered.status, registered.stderr).toBe(0);
    const raw: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
    const registeredReceipt = record(raw);
    const receipt: Record<string, unknown> = {
      ...registeredReceipt,
      receiptFile,
      state: 'stopped',
      acquisition: { state: 'settled', producer: registeredReceipt.driver },
      socketDirectory: join(temporary, `retired-sockets-${String(registeredReceipt.nonce)}`),
    };
    const pointer = join(browser, `${String(receipt.nonce)}.launch.json`);
    await writeReceipt(pointer, receipt);
    const invocation = randomUUID();
    await writeReceipt(join(browser, 'image.json'), {
      invocation,
      imageId,
      tag: `dsh-team-browser-runtime-${invocation}`,
      cleanup: { image: 'confirmed', browserResources: 'confirmed' },
    });
    const identity = await stat(temporary);
    const request = {
      root,
      temporary,
      temporaryDevice: String(identity.dev),
      temporaryInode: String(identity.ino),
    };
    const command: DockerCommand = (args) => {
      if (args[1] === 'inspect')
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such ${String(args[0])}: ${String(args.at(-1))}`,
        };
      if (args[1] === 'ls') return { status: 0, stdout: '', stderr: '' };
      throw new Error('Cleanup assessment must not mutate Docker resources');
    };
    await run({
      pointer,
      receipt,
      temporary,
      journal: join(directory, 'resources.jsonl'),
      command,
      assess: (settled = true, external = command) =>
        assessTrustedDockerCleanup(request, directory, settled, external),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['driver', 'producer'])(
  'refuses missing browser %s authority despite empty resource observations',
  async (missing) => {
    await withAuditReceipt(async ({ pointer, receipt, assess }) => {
      expect(await assess()).toEqual({ state: 'confirmed' });
      if (missing === 'driver') delete receipt.driver;
      else delete record(receipt.acquisition).producer;
      await writeReceipt(pointer, receipt);

      expect(await assess()).toEqual({ state: 'unconfirmed' });
    });
  },
);

it('refuses a started browser receipt that omits its socket retirement authority', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    expect(await assess()).toEqual({ state: 'confirmed' });
    delete receipt.socketDirectory;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed' });
  });
});

it('accepts a never-started registration without invented producer or socket identities', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    receipt.acquisition = { state: 'not-started' };
    delete receipt.socketDirectory;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'confirmed' });
  });
});

it('refuses the invocation root itself as browser receipt authority', async () => {
  await withAuditReceipt(async ({ pointer, receipt, temporary, assess }) => {
    expect(await assess()).toEqual({ state: 'confirmed' });
    receipt.receiptFile = temporary;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed' });
  });
});

it.each(['driver', 'producer'])(
  'preserves an actually live browser %s and reports cleanup unconfirmed',
  async (role) => {
    await withAuditReceipt(async ({ pointer, receipt, assess }) => {
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      const closed = Promise.withResolvers<undefined>();
      sentinel.once('close', () => {
        closed.resolve(undefined);
      });
      try {
        await once(sentinel, 'spawn');
        if (sentinel.pid === undefined) throw new Error('Missing live sentinel');
        const identity = { pid: sentinel.pid, birth: await processBirth(sentinel.pid) };
        if (role === 'driver') receipt.driver = identity;
        else record(receipt.acquisition).producer = identity;
        await writeReceipt(pointer, receipt);

        expect(await assess()).toEqual({ state: 'unconfirmed' });
        expect(await liveProcessBirth(identity.pid)).toBe(identity.birth);
      } finally {
        if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill('SIGTERM');
        await closed.promise;
      }
    });
  },
);

it('does not turn an unsettled command into cleanup confirmation from empty inventories', async () => {
  await withAuditReceipt(async ({ assess }) => {
    expect(await assess(false)).toEqual({ state: 'unconfirmed' });
  });
});

it.each(['journal', 'browser-receipt'])(
  'retains uncertainty for malformed %s evidence',
  async (kind) => {
    await withAuditReceipt(async ({ pointer, journal, assess }) => {
      await writeFile(kind === 'journal' ? journal : pointer, '{invalid-json', { mode: 0o600 });

      expect(await assess()).toEqual({ state: 'unconfirmed' });
    });
  },
);

it.each(['inspect-failed', 'inventory-nonempty'])(
  'does not infer retirement when %s',
  async (fault) => {
    await withAuditReceipt(async ({ assess, command }) => {
      const observed: DockerCommand = (args, timeout) => {
        if (fault === 'inspect-failed' && args[1] === 'inspect')
          return { status: 1, stdout: '', stderr: 'owned-observer-denied' };
        if (fault === 'inventory-nonempty' && args[1] === 'ls')
          return { status: 0, stdout: 'registered-resource-remains\n', stderr: '' };
        return command(args, timeout);
      };

      expect(await assess(true, observed)).toEqual({ state: 'unconfirmed' });
    });
  },
);

it('does not turn an uncertain browser acquisition into retirement when its producer is absent', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    record(receipt.acquisition).state = 'uncertain';
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed' });
  });
});
