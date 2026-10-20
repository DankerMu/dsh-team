import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  cancelTrustedDocker,
  runTrustedDockerOwner,
  startTrustedDocker,
  trustedDockerStatus,
} from './trusted-docker-owner.mjs';
import { INVOCATION_PATTERN, readInvocation } from './trusted-docker-record.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function outputLog(invocation, name) {
  const context = await readInvocation(invocation);
  const status = await trustedDockerStatus(invocation);
  if (status.state === 'unknown' || (status.output && !status.output.complete))
    throw new Error('Trusted Docker output authority incomplete');
  const file = await open(
    join(context.directory, `${name}.log`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error('Invalid trusted Docker output file');
    const expected = status.output?.[name];
    if (expected && info.size !== expected.bytes)
      throw new Error('Trusted Docker output size changed');
    const hash = createHash('sha256');
    if (info.size > 0) {
      const digest = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        file.createReadStream({ autoClose: false, start: 0, end: info.size - 1 }),
        digest,
        process.stdout,
        { end: false },
      );
    }
    if (expected && hash.digest('hex') !== expected.sha256)
      throw new Error('Trusted Docker output digest changed');
  } finally {
    await file.close();
  }
}

const [operation, identity, stream, ...extra] = process.argv.slice(2);
const valid =
  extra.length === 0 &&
  ((operation === 'start' && /^[a-f0-9]{40}$/.test(identity ?? '') && stream === undefined) ||
    (['status', 'cancel', 'own'].includes(operation) &&
      INVOCATION_PATTERN.test(identity ?? '') &&
      stream === undefined) ||
    (operation === 'logs' &&
      INVOCATION_PATTERN.test(identity ?? '') &&
      ['stdout', 'stderr'].includes(stream)));
if (!valid) {
  process.stderr.write(
    'usage: verify:docker start <reviewed-sha> | status|cancel <invocation> | logs <invocation> stdout|stderr\n',
  );
  process.exitCode = 2;
} else {
  try {
    if (operation === 'own') process.exitCode = await runTrustedDockerOwner(identity);
    else if (operation === 'logs') await outputLog(identity, stream);
    else {
      const result =
        operation === 'start'
          ? await startTrustedDocker(root, identity)
          : operation === 'cancel'
            ? await cancelTrustedDocker(identity)
            : await trustedDockerStatus(identity);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    process.stderr.write(
      'Trusted Docker custody operation failed; private invocation evidence retained\n',
    );
    process.exitCode = 1;
  }
}
