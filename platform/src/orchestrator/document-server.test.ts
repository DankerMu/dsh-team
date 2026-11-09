import { ok } from 'node:assert';
import { afterEach, expect, it } from 'vitest';
import { writeSettings } from '../db/index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupEvidence,
} from '../../test/container-start-fixture.ts';
import type { StartupDaemon } from '../../test/container-start-fixture.ts';
import {
  DS_ID,
  DS_NAME,
  DS_PLATFORM,
  documentServerAttachment,
  documentServerFixture,
  documentServerRecord,
  losingClient,
  mutations,
  rejectDocumentServer,
  stopDocumentServer,
} from '../../test/container-document-server-fixture.ts';
import { officeOverlay } from './document-server.ts';
import type { DocumentServerDecision } from './document-server.ts';

const fixtures: Awaited<ReturnType<typeof documentServerFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function fixture(upstreamMode: 'network' | 'published-loopback' = 'network') {
  const context = await documentServerFixture(upstreamMode);
  fixtures.push(context);
  return context;
}

const PLATFORM_CONNECT = {
  Container: DS_PLATFORM,
  EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.3' } },
};
const DS_CONNECT = {
  Container: DS_ID,
  EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.4' } },
};

function connects(daemon: StartupDaemon, from = 0): unknown[] {
  return daemon.requests
    .slice(from)
    .filter(({ method, path }) => method === 'POST' && path.endsWith('/connect'))
    .map(({ body }) => body);
}

function resolutions(daemon: StartupDaemon): string[] {
  return daemon.requests
    .filter(
      ({ method, path }) =>
        method === 'GET' &&
        (path === `/containers/${DS_NAME}/json` || path === `/containers/${DS_ID}/json`),
    )
    .map(({ path }) => path);
}

function endpoints(daemon: StartupDaemon): string[] {
  return Object.keys(daemon.networks.get(START_NETWORK)?.Containers ?? {}).sort();
}

const ONLYOFFICE = 'dsh-sidebar-onlyoffice';
const OFFICE_KEYS = ['documentServerUrl', 'jwtSecret', 'internalBaseUrl', 'publicBaseUrl'];

function keyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keyNames);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keyNames(nested)]);
}

/** The written overlay's ONLYOFFICE rows and every Office configuration key anywhere in it. */
async function officeEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const parsed: unknown = JSON.parse((await startupEvidence(f.database, f.input)).bytes.toString());
  ok(Array.isArray(parsed));
  return {
    rows: parsed.filter(
      (row: unknown) =>
        typeof row === 'object' && row !== null && 'id' in row && row.id === ONLYOFFICE,
    ),
    keys: keyNames(parsed).filter((key) => OFFICE_KEYS.includes(key)),
  };
}

const UNAVAILABLE_OFFICE = { rows: [{ id: ONLYOFFICE, disabled: true }], keys: [] };

function startedAt(daemon: StartupDaemon): number {
  return daemon.requests.findIndex(
    ({ method, path }) => method === 'POST' && path === `/containers/${START_CONTAINER}/start`,
  );
}

it('a bundled network start records the resolved Document Server before connecting it at base+4', async () => {
  const f = await fixture();
  let recordedAtConnect: unknown;
  f.daemon.beforeRequest((request) => {
    if (request.path.endsWith('/connect') && request.body.Container === DS_ID)
      recordedAtConnect = documentServerRecord(f.database);
  });

  const started = await f.owner.startUserContainer(f.input);

  const record = {
    document_server_mode: 'bundled',
    document_server_container_id: DS_ID,
    document_server_reason: null,
  };
  expect(started).toMatchObject({ outcome: 'starting', upstreamHost: '172.30.0.2' });
  expect(documentServerRecord(f.database)).toEqual(record);
  expect(recordedAtConnect).toEqual(record);
  expect(resolutions(f.daemon).slice(0, 2)).toEqual([
    `/containers/${DS_NAME}/json`,
    `/containers/${DS_ID}/json`,
  ]);
  expect(connects(f.daemon)).toEqual([PLATFORM_CONNECT, DS_CONNECT]);
  expect(endpoints(f.daemon)).toEqual([START_CONTAINER, DS_ID, DS_PLATFORM].sort());
  expect(f.daemon.networks.get(START_NETWORK)?.Containers[DS_ID]).toEqual({
    Name: DS_NAME,
    IPv4Address: '172.30.0.4/28',
    EndpointID: DS_ID,
  });
  expect(documentServerAttachment(f.daemon)).toMatchObject({
    NetworkID: START_NETWORK,
    IPAddress: '172.30.0.4',
    IPAMConfig: { IPv4Address: '172.30.0.4' },
  });
  expect(f.daemon.containers.get(DS_ID)?.NetworkSettings.Networks).toHaveProperty('bridge');
});

it('a bundled network start writes the base+4 Document Server and the deployment JWT into the overlay', async () => {
  const f = await fixture();

  await f.owner.startUserContainer(f.input);

  expect(await officeEvidence(f)).toEqual({
    rows: [
      {
        id: ONLYOFFICE,
        config: {
          documentServerUrl: 'http://172.30.0.4',
          jwtSecret: f.input.config.documentServer.jwtSecret,
          internalBaseUrl: 'http://172.30.0.2:3080',
          publicBaseUrl: f.input.config.publicUrl,
        },
      },
    ],
    keys: OFFICE_KEYS,
  });
});

it.each([
  ['external', 'external'],
  ['unconfigured', 'unconfigured'],
  ['published-loopback', 'bundled'],
] as const)('a %s start records mode %s and never resolves or attaches', async (kind, mode) => {
  const f = await fixture(kind === 'published-loopback' ? kind : 'network');
  if (kind === 'external')
    writeSettings(f.database, {
      documentServerUrl: 'http://office.example',
      documentServerJwtSecret: 'fixture-external-jwt',
    });
  const input =
    kind === 'unconfigured'
      ? { ...f.input, config: { ...f.input.config, documentServer: null } }
      : f.input;

  await expect(f.owner.startUserContainer(input)).resolves.toMatchObject({ outcome: 'starting' });

  expect(documentServerRecord(f.database)).toEqual({
    document_server_mode: mode,
    document_server_container_id: null,
    document_server_reason: null,
  });
  expect(resolutions(f.daemon)).toEqual([]);
  expect(connects(f.daemon).filter((body) => JSON.stringify(body).includes(DS_ID))).toEqual([]);
  expect(endpoints(f.daemon)).not.toContain(DS_ID);
  expect(await officeEvidence(f)).toEqual(
    kind === 'external'
      ? {
          rows: [
            {
              id: ONLYOFFICE,
              config: {
                documentServerUrl: 'http://office.example',
                jwtSecret: 'fixture-external-jwt',
                internalBaseUrl: 'http://172.30.0.2:3080',
                publicBaseUrl: f.input.config.publicUrl,
              },
            },
          ],
          keys: OFFICE_KEYS,
        }
      : UNAVAILABLE_OFFICE,
  );
});

it('a missing Document Server name records absent and the instance starts without it', async () => {
  const f = await fixture();
  f.daemon.removeContainer(DS_ID);

  await expect(f.owner.startUserContainer(f.input)).resolves.toMatchObject({
    outcome: 'starting',
  });

  expect(documentServerRecord(f.database)).toEqual({
    document_server_mode: 'bundled',
    document_server_container_id: null,
    document_server_reason: 'absent',
  });
  expect(connects(f.daemon)).toEqual([PLATFORM_CONNECT]);
  expect(endpoints(f.daemon)).toEqual([START_CONTAINER, DS_PLATFORM].sort());
  expect(await officeEvidence(f)).toEqual(UNAVAILABLE_OFFICE);
});

it.each(['stopped', 'restarting', 'renamed', 'replaced', 'malformed', 'vanished'])(
  'a %s Document Server records identity-mismatch and the instance starts without it',
  async (kind) => {
    const f = await fixture();
    const container = f.daemon.containers.get(DS_ID);
    if (container === undefined) throw new Error('Missing fixture Document Server');
    if (kind === 'stopped') stopDocumentServer(f.daemon);
    // Restart-policy backoff: Docker reports `Running` and `Restarting` together.
    if (kind === 'restarting') stopDocumentServer(f.daemon, 'restarting');
    const exact = `GET /containers/${DS_ID}/json`;
    if (kind === 'renamed')
      f.daemon.overrides.set(exact, { status: 200, document: { ...container, Name: '/other' } });
    if (kind === 'replaced')
      f.daemon.overrides.set(exact, {
        status: 200,
        document: { ...container, Id: '8'.repeat(64) },
      });
    if (kind === 'malformed')
      f.daemon.overrides.set(`GET /containers/${DS_NAME}/json`, {
        status: 200,
        document: { ...container, Id: 'not-a-container-id' },
      });
    if (kind === 'vanished') f.daemon.overrides.set(exact, { status: 404 });

    await expect(f.owner.startUserContainer(f.input)).resolves.toMatchObject({
      outcome: 'starting',
    });

    expect(documentServerRecord(f.database)).toEqual({
      document_server_mode: 'bundled',
      document_server_container_id: null,
      document_server_reason: 'identity-mismatch',
    });
    expect(connects(f.daemon)).toEqual([PLATFORM_CONNECT]);
    expect(endpoints(f.daemon)).toEqual([START_CONTAINER, DS_PLATFORM].sort());
    expect(await officeEvidence(f)).toEqual(UNAVAILABLE_OFFICE);
  },
);

it.each([
  ['a Docker error', DS_NAME, { status: 500, document: { message: 'fixture daemon failure' } }],
  ['an unparsable answer', DS_NAME, { status: 200, document: [] }],
  ['an exact-ID Docker error', DS_ID, { status: 500, document: { message: 'fixture failure' } }],
])(
  '%s while resolving the Document Server fails the start before any resource',
  async (_kind, target, reply) => {
    const f = await fixture();
    f.daemon.overrides.set(`GET /containers/${target}/json`, reply);

    await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
      'Container startup failed during document server identity',
    );

    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(
      mutations(f.daemon.requests).filter(({ request }) => request.includes('/networks')),
    ).toEqual([]);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  },
);

it('a rejected Document Server connect fails the start through started-container compensation', async () => {
  const f = await fixture();
  rejectDocumentServer(f.daemon, 'connect');

  await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
    'Container startup failed during document server attachment; started container and owned network removed',
  );

  expect(
    f.database
      .prepare('SELECT status, last_error FROM instances WHERE user_id = ?')
      .get(START_USER),
  ).toEqual({
    status: 'error',
    last_error: 'Platform attachment/startup failed; started container and owned network removed',
  });
  expect(documentServerRecord(f.database)).toEqual({
    document_server_mode: 'bundled',
    document_server_container_id: DS_ID,
    document_server_reason: null,
  });
  expect(f.database.prepare('SELECT event_type FROM audit_events ORDER BY id').all()).toEqual([
    { event_type: 'instance.created' },
    { event_type: 'instance.start-failed' },
  ]);
  expect(mutations(f.daemon.requests, startedAt(f.daemon) + 1)).toEqual([
    { request: `POST /networks/${START_NETWORK}/connect`, body: PLATFORM_CONNECT },
    { request: `POST /networks/${START_NETWORK}/connect`, body: DS_CONNECT },
    { request: `POST /containers/${START_CONTAINER}/stop?t=1`, body: {} },
    { request: `DELETE /containers/${START_CONTAINER}`, body: {} },
    {
      request: `POST /networks/${START_NETWORK}/disconnect`,
      body: { Container: DS_PLATFORM, Force: false },
    },
    { request: `DELETE /networks/${START_NETWORK}`, body: {} },
  ]);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerAttachment(f.daemon)).toBeUndefined();
});

it('a lost connect response that inspection confirms settles as attached', async () => {
  const f = await fixture();
  const owner = f.ownerFor(losingClient(f.client, 'connect', true));

  await expect(owner.startUserContainer(f.input)).resolves.toMatchObject({
    outcome: 'starting',
  });

  expect(endpoints(f.daemon)).toEqual([START_CONTAINER, DS_ID, DS_PLATFORM].sort());
  expect(f.daemon.networks.get(START_NETWORK)?.Containers[DS_ID]?.IPv4Address).toBe(
    '172.30.0.4/28',
  );
});

it('a lost connect that inspection cannot confirm fails the start as unconfirmed', async () => {
  const f = await fixture();
  const owner = f.ownerFor(losingClient(f.client, 'connect', false));

  await expect(owner.startUserContainer(f.input)).rejects.toThrow(
    'Container startup failed during document server attachment; started container and owned network removed',
  );

  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerAttachment(f.daemon)).toBeUndefined();
});

it('a Document Server replaced before connect fails the start and is never connected', async () => {
  const f = await fixture();
  f.daemon.beforeRequest((request) => {
    if (request.path.endsWith('/connect') && request.body.Container === DS_PLATFORM) {
      f.daemon.removeContainer(DS_ID);
      seedPlatform(f.daemon, DS_NAME, '7'.repeat(64));
    }
  });

  await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
    'Container startup failed during document server attachment',
  );

  expect(connects(f.daemon)).toEqual([PLATFORM_CONNECT]);
  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
  expect(f.daemon.containers.get('7'.repeat(64))?.NetworkSettings.Networks).not.toHaveProperty(
    `dsh-team-net-${START_USER}`,
  );
});

it('compensation that cannot delete the network keeps the error row and its Document Server record', async () => {
  const f = await fixture();
  rejectDocumentServer(f.daemon, 'connect');
  f.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });

  await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
    'compensation failed or unconfirmed',
  );

  expect(f.database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'error',
    last_error:
      'Platform attachment/startup failed; started container compensation failed or unconfirmed',
  });
  expect(documentServerRecord(f.database)).toEqual({
    document_server_mode: 'bundled',
    document_server_container_id: DS_ID,
    document_server_reason: null,
  });
});

it('a replaced instance reuses its bridge when the Document Server endpoint is this start’s resolved ID', async () => {
  const f = await fixture();
  await f.owner.startUserContainer(f.input);
  f.daemon.removeContainer(START_CONTAINER);
  const from = f.daemon.requests.length;

  await expect(f.owner.startUserContainer(f.input)).resolves.toMatchObject({
    outcome: 'starting',
  });

  expect(connects(f.daemon, from)).toEqual([]);
  expect(endpoints(f.daemon)).toEqual([START_CONTAINER, DS_ID, DS_PLATFORM].sort());
  expect(documentServerRecord(f.database)).toMatchObject({ document_server_container_id: DS_ID });
});

it.each(['external', 'stopped'])(
  'a replaced instance whose recorded Document Server is not this start’s %s decision fails closed before persistence',
  async (kind) => {
    const f = await fixture();
    await f.owner.startUserContainer(f.input);
    f.daemon.removeContainer(START_CONTAINER);
    if (kind === 'external')
      writeSettings(f.database, {
        documentServerUrl: 'http://office.example',
        documentServerJwtSecret: 'fixture-external-jwt',
      });
    else stopDocumentServer(f.daemon);
    const row = f.database.prepare('SELECT * FROM instances').get();
    const audits = f.database.prepare('SELECT * FROM audit_events').all();
    const from = f.daemon.requests.length;

    await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
      'Container startup failed during network allocation',
    );

    expect(f.database.prepare('SELECT * FROM instances').get()).toEqual(row);
    expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
    expect(
      mutations(f.daemon.requests, from).filter(
        ({ request }) =>
          request.startsWith(`POST /containers/create?name=dsh-team-u-`) ||
          request.includes('/networks/'),
      ),
    ).toEqual([]);
    expect(documentServerAttachment(f.daemon)).toMatchObject({ NetworkID: START_NETWORK });
  },
);

it('a Document Server that leaves the bridge before the post-attach validation fails the start', async () => {
  const f = await fixture();
  let connected = false;
  f.daemon.beforeRequest((request) => {
    if (request.path.endsWith('/connect') && request.body.Container === DS_ID) connected = true;
    else if (connected && request.path === `/containers/${START_CONTAINER}/json`) {
      connected = false;
      f.daemon.removeContainer(DS_ID);
    }
  });

  await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
    'Container startup failed during document server attachment; started container and owned network removed',
  );

  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
});

it('an invalid recorded Document Server identity fails reuse closed', async () => {
  const f = await fixture();
  await f.owner.startUserContainer(f.input);
  f.database.exec("UPDATE instances SET document_server_container_id = 'not-a-container-id'");
  const from = f.daemon.requests.length;

  await expect(f.owner.startUserContainer(f.input)).rejects.toThrow(
    'Container startup failed during current container validation',
  );

  expect(mutations(f.daemon.requests, from)).toEqual([]);
});

const CONFIGURED = { containerName: DS_NAME, jwtSecret: 'unit-test-bundled-jwt' };
const ADMITTED: DocumentServerDecision = { mode: 'bundled', containerId: DS_ID, reason: null };
const NO_EXTERNAL = { documentServerUrl: '', documentServerJwtSecret: '' };
const PUBLIC_URL = 'https://team.example:8443';

function external(documentServerUrl: string, documentServerJwtSecret = 'unit-test-external-jwt') {
  return { documentServerUrl, documentServerJwtSecret };
}

const EXTERNAL_DECISION: DocumentServerDecision = {
  mode: 'external',
  containerId: null,
  reason: null,
};

it.each([
  [
    'a bundled admitted peer',
    ADMITTED,
    NO_EXTERNAL,
    CONFIGURED,
    'network',
    {
      documentServerUrl: 'http://10.9.8.36',
      jwtSecret: 'unit-test-bundled-jwt',
      publicBaseUrl: PUBLIC_URL,
    },
  ],
  [
    'a bundled absent peer',
    { mode: 'bundled', containerId: null, reason: 'absent' },
    NO_EXTERNAL,
    CONFIGURED,
    'network',
    null,
  ],
  [
    'a bundled mismatched peer',
    { mode: 'bundled', containerId: null, reason: 'identity-mismatch' },
    NO_EXTERNAL,
    CONFIGURED,
    'network',
    null,
  ],
  [
    'an unconfigured bundled peer',
    { mode: 'unconfigured', containerId: null, reason: null },
    NO_EXTERNAL,
    null,
    'network',
    null,
  ],
  ['a verified peer without its deployment config', ADMITTED, NO_EXTERNAL, null, 'network', null],
  [
    'a bundled published-loopback start',
    { mode: 'bundled', containerId: null, reason: null },
    NO_EXTERNAL,
    CONFIGURED,
    'published-loopback',
    null,
  ],
  [
    'a bundled published-loopback start with a verified peer',
    ADMITTED,
    NO_EXTERNAL,
    CONFIGURED,
    'published-loopback',
    null,
  ],
  [
    'an external server',
    EXTERNAL_DECISION,
    external('http://office.example/ds'),
    CONFIGURED,
    'network',
    {
      documentServerUrl: 'http://office.example/ds',
      jwtSecret: 'unit-test-external-jwt',
      publicBaseUrl: PUBLIC_URL,
    },
  ],
  [
    'an external server in published-loopback',
    EXTERNAL_DECISION,
    external('http://office.example'),
    CONFIGURED,
    'published-loopback',
    null,
  ],
  [
    'an external address with one trailing slash',
    EXTERNAL_DECISION,
    external('http://office.example/'),
    null,
    'network',
    {
      documentServerUrl: 'http://office.example',
      jwtSecret: 'unit-test-external-jwt',
      publicBaseUrl: PUBLIC_URL,
    },
  ],
  [
    'an external address with several trailing slashes',
    EXTERNAL_DECISION,
    external('http://office.example/ds///'),
    null,
    'network',
    {
      documentServerUrl: 'http://office.example/ds',
      jwtSecret: 'unit-test-external-jwt',
      publicBaseUrl: PUBLIC_URL,
    },
  ],
  [
    'an external server with an empty JWT',
    EXTERNAL_DECISION,
    external('http://office.example', ''),
    CONFIGURED,
    'network',
    null,
  ],
] as const)(
  'derives the Office overlay input for %s',
  (_label, decision, settings, configured, upstreamMode, expected) => {
    const office = officeOverlay(
      decision,
      settings,
      configured,
      upstreamMode,
      '10.9.8.36',
      PUBLIC_URL,
    );

    expect(office).toEqual(expected);
  },
);
