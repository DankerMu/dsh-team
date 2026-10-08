import type { DockerClient } from './client.ts';
import { extractLaunchToken } from './web-launch-token.ts';

const MAX_LINE_BYTES = 1024;
const MAX_RETAINED_LINES = 50;

function safeLine(text: string, cookies: readonly string[]): string | undefined {
  // Also reject incomplete/malformed announcements; the canonical parser handles valid ones.
  if (
    extractLaunchToken(text) !== undefined ||
    /\bdsh\s+web\b/i.test(text) ||
    /(?:token|api[-_]?key|authorization|set-cookie|cookie)\s*[:=]/i.test(text) ||
    /dsh-auth-/i.test(text) ||
    /^[A-Za-z0-9_.=-]{16,}$/.test(text.trim())
  )
    return undefined;
  let sanitized = text;
  for (const cookie of cookies) {
    const value = cookie.slice(cookie.indexOf('=') + 1);
    for (const secret of [cookie, value]) {
      if (secret.length > 0) sanitized = sanitized.replaceAll(secret, '[redacted]');
    }
  }
  sanitized = sanitized
    .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\p{Cc}/gu, (character) =>
      character > '\u007f' || '\t\n\r'.includes(character) ? character : '',
    );
  // Bounds apply to retained UTF8, including replacement characters and redaction expansion.
  return sanitized.length === 0 || Buffer.byteLength(sanitized, 'utf8') > MAX_LINE_BYTES
    ? undefined
    : sanitized;
}

/** A finite Docker tail, never a raw log/error export. Overlong lines are discarded whole. */
export async function startupLogTail(
  client: DockerClient,
  containerId: string,
  signal: AbortSignal,
  cookies: readonly string[],
): Promise<string[]> {
  const retained: string[] = [];
  const streams = {
    stdout: { bytes: Buffer.alloc(MAX_LINE_BYTES), used: 0, discarded: false },
    stderr: { bytes: Buffer.alloc(MAX_LINE_BYTES), used: 0, discarded: false },
  };
  function finish(line: (typeof streams)['stdout']) {
    if (!line.discarded) {
      const text = line.bytes.toString('utf8', 0, line.used).replace(/\r$/, '');
      const safe = safeLine(text, cookies);
      if (safe !== undefined) {
        if (retained.length === MAX_RETAINED_LINES) retained.shift();
        retained.push(safe);
      }
    }
    line.used = 0;
    line.discarded = false;
  }
  try {
    for await (const chunk of client.logs(
      `/containers/${containerId}/logs?stdout=true&stderr=true&follow=false&tail=1000`,
      signal,
    )) {
      signal.throwIfAborted();
      const line = streams[chunk.stream];
      let offset = 0;
      while (offset < chunk.data.length) {
        const newline = chunk.data.indexOf(10, offset);
        const end = newline === -1 ? chunk.data.length : newline;
        const count = end - offset;
        if (line.used + count > MAX_LINE_BYTES) line.discarded = true;
        if (!line.discarded) {
          chunk.data.copy(line.bytes, line.used, offset, end);
          line.used += count;
        }
        offset = newline === -1 ? end : end + 1;
        if (newline !== -1) finish(line);
      }
    }
    for (const line of Object.values(streams)) {
      if (line.used > 0 || line.discarded) finish(line);
    }
    return retained.length === 0 ? ['Startup logs unavailable: no retained safe lines'] : retained;
  } catch {
    // Partial frames/lines are not evidence. Keep only completed safe lines and a safe diagnostic.
    if (retained.length === MAX_RETAINED_LINES) retained.shift();
    retained.push('Startup logs unavailable: incomplete or unreadable Docker tail');
    return retained;
  }
}
