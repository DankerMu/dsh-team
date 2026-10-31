import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

export const name = 'dsh-team-owned-completion-recorder';

/**
 * Owned loopback-only model endpoint: answers each completion with the configured reply and
 * records only the request count and the SHA-256 of its Authorization header, never the header,
 * credential or body.
 */
export function apply(ctx, config) {
  const ledger = { total: 0, inflight: 0, overflow: false, requests: [] };
  const persist = () => writeFileSync(config.ledger, JSON.stringify(ledger), { mode: 0o600 });
  const server = createServer((req, res) => {
    ledger.total++;
    ledger.inflight++;
    const authorization = req.headers.authorization;
    if (ledger.requests.length < 16) {
      ledger.requests.push({
        sequence: ledger.total,
        path: req.url === '/v1/chat/completions' ? 'chat-completions' : 'other',
        authorizationSha256:
          typeof authorization === 'string'
            ? createHash('sha256').update(authorization).digest('hex')
            : null,
      });
    } else ledger.overflow = true;
    persist();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      ledger.inflight--;
      persist();
    };
    res.once('close', finish);
    res.once('finish', finish);
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 4_194_304) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const common = { id: 'owned-completion', created: 1, model: body?.model ?? 'owned' };
      // The released openai-completions adapter streams; a non-streaming caller gets JSON.
      if (body?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const choice of [
          { index: 0, delta: { role: 'assistant', content: config.reply }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ])
          res.write(
            `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
          );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...common,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: config.reply },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  ctx.effect(() => {
    persist();
    server.listen(config.port, '127.0.0.1');
    return () => {
      server.closeAllConnections();
      server.close();
    };
  });
}
