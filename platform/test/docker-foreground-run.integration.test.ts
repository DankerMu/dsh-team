import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// A foreground `run` mirrors the container's exit, so a nonzero one-shot container leaves an
// unsettled custody row; fixtures use the one-shot helper, and long-lived ones `--detach`.
const RUN = /'run',\s*(?:'([^']*)')?/g;
// `spawn('pnpm', ['run', 'e2e'])` runs a package script, not Docker.
const EXEMPT = ['e2e-command-fixture.ts'];

function foregroundRuns(source: string): number[] {
  return [...source.matchAll(RUN)]
    .filter((match) => match[1] !== '--detach')
    .map(({ index }) => source.slice(0, index).split('\n').length);
}

it('flags a foreground run and passes a detached one', () => {
  const source = "command([\n  'run',\n  '--rm',\n]);\ncommand(['run',\n  '--detach', 'x']);";

  expect(foregroundRuns(source)).toEqual([2]);
});

it('keeps Docker test fixtures off foreground docker run', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.docker.test.ts') || file.endsWith('-fixture.ts'))
    .filter((file) => !EXEMPT.includes(file))
    .sort();
  expect(files).toEqual(
    expect.arrayContaining([
      'container-reconcile.docker.test.ts',
      'container-start-docker-fixture.ts',
    ]),
  );

  const sites = files.flatMap((file) =>
    foregroundRuns(readFileSync(join(directory, file), 'utf8')).map(
      (line) => `${file}:${String(line)}`,
    ),
  );

  expect(sites).toEqual([]);
});
