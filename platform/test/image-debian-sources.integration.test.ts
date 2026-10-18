import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const program = fileURLToPath(
  new URL('../../images/build-tools/debian-sources.mjs', import.meta.url),
);
const security = `Types: deb
URIs: http://deb.debian.org/debian-security
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
`;

it('changes only the active ordinary source while preserving comments, security and archive trust', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-apt-source-'));
  const path = join(directory, 'debian.sources');
  const before = `# URIs: http://deb.debian.org/debian
Types: deb
URIs: http://deb.debian.org/debian
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

${security}`;
  const expected = `# URIs: http://deb.debian.org/debian
Types: deb
URIs: http://mirrors.tuna.tsinghua.edu.cn/debian
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

${security}`;
  try {
    await writeFile(path, before);

    const result = spawnSync(process.execPath, [program, path], {
      env: {},
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16_384,
    });

    expect(result.status).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ['missing', security],
  ['comment-only', `# URIs: http://deb.debian.org/debian\n${security}`],
  [
    'duplicate',
    `URIs: http://deb.debian.org/debian\nURIs: http://deb.debian.org/debian\n${security}`,
  ],
])('rejects %s ordinary sources without changing the file', async (_case, before) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-apt-source-'));
  const path = join(directory, 'debian.sources');
  try {
    await writeFile(path, before);

    const result = spawnSync(process.execPath, [program, path], {
      env: {},
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16_384,
    });

    expect(result.status).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
