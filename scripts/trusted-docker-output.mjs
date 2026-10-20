import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const REDACTED = Buffer.from('[REDACTED]');

function nextMatch(buffer, secrets) {
  let selected;
  for (const secret of secrets) {
    const index = buffer.indexOf(secret);
    if (index >= 0 && (!selected || index < selected.index))
      selected = { index, length: secret.length };
  }
  return selected;
}

/** Retain every nonsecret byte without buffering a complete command or splitting a secret. */
export async function capturePrivateOutput(input, path, secretValues) {
  const secrets = [...new Set(secretValues.filter((value) => value.length > 0))]
    .map((value) => Buffer.from(value))
    .sort((left, right) => right.length - left.length);
  const retainedBytes = Math.max(0, (secrets[0]?.length ?? 1) - 1);
  const hash = createHash('sha256');
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    const write = async (buffer) => {
      let offset = 0;
      while (offset < buffer.length) {
        const result = await file.write(buffer, offset, buffer.length - offset);
        if (result.bytesWritten === 0) throw new Error('Output write made no progress');
        hash.update(buffer.subarray(offset, offset + result.bytesWritten));
        offset += result.bytesWritten;
        bytes += result.bytesWritten;
      }
    };
    const drain = async (final) => {
      while (pending.length > 0) {
        const safe = final ? pending.length : pending.length - retainedBytes;
        if (safe <= 0) return;
        const match = nextMatch(pending, secrets);
        if (match && match.index < safe) {
          await write(pending.subarray(0, match.index));
          await write(REDACTED);
          pending = pending.subarray(match.index + match.length);
        } else {
          await write(pending.subarray(0, safe));
          pending = pending.subarray(safe);
        }
      }
    };
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      await drain(false);
    }
    await drain(true);
    await file.sync();
    await file.close();
    file = undefined;
    return { bytes, sha256: hash.digest('hex') };
  } catch {
    if (file) await file.close().catch(() => undefined);
    throw Object.assign(new Error('Trusted Docker output capture failed'), {
      code: 'output-capture-failed',
    });
  }
}
