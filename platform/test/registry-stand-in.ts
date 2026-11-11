export const PROBE_PLUGIN = 'dsh-team-probe-plugin';
export const PROBE_TARBALL = `/${PROBE_PLUGIN}/-/${PROBE_PLUGIN}-1.0.0.tgz`;
export const METADATA_REQUEST = `GET /${PROBE_PLUGIN}`;
export const TARBALL_REQUEST = `GET ${PROBE_TARBALL}`;
// The probe plugin's metadata (the preflight and pnpm) and tarball, and pnpm's own version check.
export const STAND_IN_REQUESTS = [
  METADATA_REQUEST,
  TARBALL_REQUEST,
  'GET /pnpm',
  // The add preflight's `pnpm view` runs npm, whose own version check fetches the npm packument.
  'GET /npm',
];

export interface RegistryStandInOptions {
  /** Loopback port to listen on; `0` takes an ephemeral one. */
  readonly port: number;
  /** File that receives one `METHOD url` line per request, appended before the response. */
  readonly requestLog?: string;
  /** File written (atomically, by rename) with the registry URL once the server listens. */
  readonly readyMarker?: string;
}

/**
 * ES module source of the offline npm registry stand-in, holding only the probe plugin: its
 * packument (with `dsh.bundle` and `dist.integrity`), its tarball, and `404 {}` for anything
 * else (`/pnpm`, `/npm` included). Runs alone under `node --input-type=module -e`, kept alive by
 * its listening server, or as the head of a probe script, which then reads the one binding it
 * declares: `registryStandIn = { registry, requests, server }`. Nothing is written to stdout.
 */
export function registryStandInScript(options: RegistryStandInOptions): string {
  return `
const registryStandIn = await (async (port, requestLog, readyMarker) => {
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const NAME = ${JSON.stringify(PROBE_PLUGIN)};
  const TARBALL = ${JSON.stringify(PROBE_TARBALL)};
  // No engines.dsh and no @deepseek-ai peer: DSH's preflight reads the manifest as compatible.
  const work = mkdtempSync('/tmp/dsh-team-registry-');
  mkdirSync(work + '/package');
  writeFileSync(work + '/package/package.json', JSON.stringify({ name: NAME, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  writeFileSync(work + '/package/cordis.patch.yml', '[]\\n');
  const packed = spawnSync('tar', ['-czf', work + '/probe.tgz', '-C', work, 'package'], { encoding: 'utf8', timeout: 30000 });
  if (packed.status !== 0) throw new Error('probe tarball not packed: ' + packed.stderr);
  const tarball = readFileSync(work + '/probe.tgz');
  rmSync(work, { recursive: true, force: true });
  const requests = [];
  let documentText = '';
  const server = createServer((request, response) => {
    const line = request.method + ' ' + request.url;
    requests.push(line);
    if (requestLog !== null) appendFileSync(requestLog, line + '\\n');
    if (request.url === '/' + NAME) {
      response.setHeader('content-type', 'application/json');
      response.end(documentText);
    } else if (request.url === TARBALL) response.end(tarball);
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const registry = 'http://127.0.0.1:' + String(server.address().port) + '/';
  const version = { name: NAME, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, dist: {
    tarball: registry.slice(0, -1) + TARBALL,
    integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
    shasum: createHash('sha1').update(tarball).digest('hex') } };
  documentText = JSON.stringify({ name: NAME, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } });
  if (readyMarker !== null) {
    writeFileSync(readyMarker + '.partial', registry);
    renameSync(readyMarker + '.partial', readyMarker);
  }
  return { registry, requests, server };
})(${String(options.port)}, ${JSON.stringify(options.requestLog ?? null)}, ${JSON.stringify(options.readyMarker ?? null)});
`;
}
