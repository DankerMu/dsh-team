import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// Invocation-owned model dependency only; never loaded by production or external-provider lanes.
const path = process.argv[2];
if (!path) throw new Error('Missing owned model configuration');
const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
if (
  typeof config !== 'object' ||
  config === null ||
  !('key' in config) ||
  typeof config.key !== 'string' ||
  !('model' in config) ||
  typeof config.model !== 'string' ||
  !('reply' in config) ||
  typeof config.reply !== 'string' ||
  !('marker' in config) ||
  typeof config.marker !== 'string'
)
  throw new Error('Invalid owned model configuration');
const { key, model, reply, marker } = config;
let markedRequests = 0;
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify({ ready: true, markedRequests }));
    return;
  }
  if (
    request.method !== 'POST' ||
    request.url !== '/v1/chat/completions' ||
    request.headers.authorization !== `Bearer ${key}`
  ) {
    response.writeHead(403).end();
    return;
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_048_576) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (
        typeof body !== 'object' ||
        body === null ||
        !('model' in body) ||
        body.model !== model ||
        !('messages' in body) ||
        !Array.isArray(body.messages)
      )
        throw new Error('Invalid owned model request');
      if (JSON.stringify(body.messages).includes(marker)) markedRequests++;
      const common = { id: 'owned-completion', created: 1, model };
      if ('stream' in body && body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const choice of [
          { index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ])
          response.write(
            `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
          );
        response.end('data: [DONE]\n\n');
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ...common,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      }
    } catch {
      response.writeHead(400).end();
    }
  });
  request.on('error', () => response.destroy());
});
server.listen(3099, '0.0.0.0');
