// Generator for schemas/openapi.json, the committed HTTP contract of the platform.
//   --write  regenerate the committed file
//   --check  exit 1 when the committed file differs from a fresh render (CI mode)
import { readFileSync, writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.ts';

const TARGET = new URL('../../schemas/openapi.json', import.meta.url);
const USAGE = 'usage: node platform/scripts/openapi.ts --write | --check';

async function render(): Promise<string> {
  const app = await buildApp({
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    dataDir: './data',
  });
  await app.ready();
  const document = app.swagger();
  await app.close();
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readCommitted(): string {
  try {
    return readFileSync(TARGET, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  process.stderr.write(`openapi: ${USAGE}\n`);
  process.exit(2);
}

const fresh = await render();
if (mode === '--write') {
  writeFileSync(TARGET, fresh);
  process.stdout.write('openapi: wrote schemas/openapi.json\n');
} else if (readCommitted() === fresh) {
  process.stdout.write('openapi: schemas/openapi.json matches the routes, 1 file checked.\n');
} else {
  process.stderr.write(
    'openapi: schemas/openapi.json is out of date with the registered routes:\n' +
      '  schemas/openapi.json  committed contract differs from the fresh render\n' +
      "  fix: run 'pnpm contract:write', review the diff, and commit it with the route change\n",
  );
  process.exit(1);
}
