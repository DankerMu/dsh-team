import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

export const name = 'dsh-team-model-refusal-recorder';

/** Owned loopback-only server: counts every request, never retains headers or bodies. */
export function apply(ctx, config) {
  const ledger = { total: 0, inflight: 0, overflow: false, requests: [] };
  const persist = () => writeFileSync(config.ledger, JSON.stringify(ledger));
  const server = createServer((req, res) => {
    ledger.total++;
    ledger.inflight++;
    if (ledger.requests.length < 64) {
      ledger.requests.push({
        sequence: ledger.total,
        method: ['GET', 'POST', 'HEAD'].includes(req.method) ? req.method : 'other',
        kind: req.url === '/owned-control' ? 'control' : 'alternate',
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
    // Drain without retaining model request bytes; the recorder is not a model service.
    req.resume();
    res.writeHead(req.url === '/owned-control' ? 204 : 503);
    res.end();
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.timeout = 5_000;
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
