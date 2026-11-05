import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { posix } from 'node:path';

// Invocation-owned model dependency only; never loaded by production or external-provider lanes.
const path = process.argv[2];
if (!path) throw new Error('Missing owned model configuration');
const portArgument = process.argv[3] ?? '3099';
if (!/^\d{1,5}$/.test(portArgument) || Number(portArgument) > 65_535)
  throw new Error('Invalid owned model port');
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

/** Optional scripted `write` call: exactly `{ path, content }`, path strictly under /data/work/. */
function ownedScript(value: unknown): { path: string; content: string } | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join() !== 'content,path' ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('content' in value) ||
    typeof value.content !== 'string' ||
    !value.path.startsWith('/data/work/') ||
    value.path === '/data/work/' ||
    posix.normalize(value.path) !== value.path
  )
    throw new Error('Invalid owned model configuration');
  return { path: value.path, content: value.content };
}
const script = ownedScript('script' in config ? config.script : undefined);

/** Optional nonsecret hold nonce: a non-empty string, absent by default. */
function ownedHold(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '')
    throw new Error('Invalid owned model configuration');
  return value;
}
/** Optional nonsecret strings no model request may carry: non-empty strings, absent by default. */
function ownedForbidden(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== ''))
    throw new Error('Invalid owned model configuration');
  return value as string[];
}
const hold = ownedHold('hold' in config ? config.hold : undefined);
const forbidden = ownedForbidden('forbidden' in config ? config.forbidden : undefined);
/** Held answers, released together by `POST /release`; at most one request is ever held. */
const heldAnswers: (() => void)[] = [];
let holding = hold !== undefined;
let forbiddenRequests = 0;

let markedRequests = 0;
let requests = 0;
let toolResults = 0;

const offersWrite = (tools: unknown) =>
  Array.isArray(tools) &&
  tools.some(
    (tool: unknown) =>
      typeof tool === 'object' &&
      tool !== null &&
      'function' in tool &&
      typeof tool.function === 'object' &&
      tool.function !== null &&
      'name' in tool.function &&
      tool.function.name === 'write',
  );
const hasToolResult = (messages: unknown[]) =>
  messages.some(
    (message: unknown) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'tool',
  );

/** Only a write-capable main turn without a tool result gets the call; titles get text. */
function scriptedCall(body: object, toolResult: boolean) {
  if (script === undefined || toolResult || !('tools' in body) || !offersWrite(body.tools))
    return undefined;
  return {
    index: 0,
    id: 'owned-write-1',
    type: 'function',
    function: {
      name: 'write',
      arguments: JSON.stringify({ file_path: script.path, content: script.content }),
    },
  };
}

function respond(response: ServerResponse, stream: boolean, call: object | undefined) {
  const common = { id: 'owned-completion', created: 1, model };
  if (stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      call === undefined
        ? { index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }
        : { index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' },
    ])
      response.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
      );
    response.end('data: [DONE]\n\n');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      ...common,
      object: 'chat.completion',
      choices: [
        call === undefined
          ? { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }
          : {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [call] },
              finish_reason: 'tool_calls',
            },
      ],
    }),
  );
}

/** The first marked write-capable request without a tool result: the scriptedCall predicate. */
function holds(body: object, text: string, toolResult: boolean) {
  if (!holding || hold === undefined || toolResult || !text.includes(hold)) return false;
  return 'tools' in body && offersWrite(body.tools);
}

/** Health stays byte-identical unless a hold or forbidden strings are configured. */
function health() {
  return JSON.stringify({
    ready: true,
    markedRequests,
    requests,
    toolResults,
    ...(hold === undefined ? {} : { held: heldAnswers.length }),
    ...(forbidden === undefined ? {} : { forbiddenRequests }),
  });
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.end(health());
    return;
  }
  if (hold !== undefined && request.method === 'POST' && request.url === '/release') {
    holding = false;
    const answers = heldAnswers.splice(0);
    for (const answer of answers) answer();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ released: answers.length }));
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
  requests++;
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
      const text = JSON.stringify(body.messages);
      if (text.includes(marker)) markedRequests++;
      if (forbidden?.some((item) => text.includes(item)) === true) forbiddenRequests++;
      const toolResult = hasToolResult(body.messages);
      if (toolResult) toolResults++;
      const answer = () => {
        respond(response, 'stream' in body && body.stream === true, scriptedCall(body, toolResult));
      };
      if (!holds(body, text, toolResult)) {
        answer();
        return;
      }
      holding = false;
      heldAnswers.push(answer);
    } catch {
      response.writeHead(400).end();
    }
  });
  request.on('error', () => response.destroy());
});
server.listen(Number(portArgument), '0.0.0.0');
