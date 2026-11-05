import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { unusedPort } from './gateway-http-fixture.ts';

const wire = fileURLToPath(new URL('./deployment-model-wire.ts', import.meta.url));
const BASE = { key: 'owned-key', model: 'owned-model', reply: 'owned reply', marker: 'mark-42' };
const SCRIPT = { path: '/data/work/stack-note.txt', content: 'scripted content\n' };
const WRITE_TOOL = { type: 'function', function: { name: 'write', parameters: {} } };
const READ_TOOL = { type: 'function', function: { name: 'read', parameters: {} } };
const owned: { child: ChildProcess; directory: string }[] = [];

afterEach(async () => {
  for (const { child, directory } of owned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function launch(config: unknown, port?: number | string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-model-wire-'));
  const path = join(directory, 'model.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const args = [wire, path, ...(port === undefined ? [] : [String(port)])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  owned.push({ child, directory });
  const closed = once(child, 'close').then(([code]) => ({ code: code as number | null, stderr }));
  return { child, closed };
}

async function start(config: unknown) {
  const port = await unusedPort();
  const { closed } = await launch(config, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const deadline = performance.now() + 10_000;
  const state = { exited: false };
  void closed.then(() => (state.exited = true));
  for (;;) {
    try {
      const health = await fetch(`${origin}/health`);
      if (health.status === 200) {
        await health.arrayBuffer();
        return origin;
      }
    } catch {
      // Not listening yet.
    }
    if (state.exited || performance.now() > deadline) throw new Error('Owned model wire not ready');
    await delay(50);
  }
}

function complete(origin: string, body: unknown, key = BASE.key) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function streamed(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const text = await response.text();
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  return text
    .split('\n\n')
    .filter((line) => line !== '' && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
}

const userTurn = (tools?: unknown[], extra: unknown[] = []) => ({
  model: BASE.model,
  stream: true,
  messages: [{ role: 'user', content: `please ${BASE.marker}` }, ...extra],
  ...(tools === undefined ? {} : { tools }),
});
const toolResult = [
  { role: 'assistant', content: null, tool_calls: [{ id: 'owned-write-1', type: 'function' }] },
  { role: 'tool', content: 'written', tool_call_id: 'owned-write-1' },
];
const writeCall = {
  index: 0,
  id: 'owned-write-1',
  type: 'function',
  function: {
    name: 'write',
    arguments: '{"file_path":"/data/work/stack-note.txt","content":"scripted content\\n"}',
  },
};
const chunk = (choice: unknown) => ({
  id: 'owned-completion',
  created: 1,
  model: 'owned-model',
  object: 'chat.completion.chunk',
  choices: [choice],
});
const replyChunks = [
  chunk({ index: 0, delta: { role: 'assistant', content: 'owned reply' }, finish_reason: null }),
  chunk({ index: 0, delta: {}, finish_reason: 'stop' }),
];

it('answers without a script byte-for-byte as before, streamed and non-streamed, even with tools', async () => {
  const origin = await start(BASE);
  const sse =
    'data: {"id":"owned-completion","created":1,"model":"owned-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"owned reply"},"finish_reason":null}]}\n\n' +
    'data: {"id":"owned-completion","created":1,"model":"owned-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n';
  for (const tools of [undefined, [WRITE_TOOL]]) {
    const response = await complete(origin, userTurn(tools));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(sse);
  }
  const plain = await complete(origin, { ...userTurn([WRITE_TOOL]), stream: false });
  expect(plain.headers.get('content-type')).toBe('application/json');
  expect(await plain.text()).toBe(
    '{"id":"owned-completion","created":1,"model":"owned-model","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"owned reply"},"finish_reason":"stop"}]}',
  );
});

it('issues the scripted write call only to a write-capable request without a tool result', async () => {
  const origin = await start({ ...BASE, script: SCRIPT });
  expect(await streamed(await complete(origin, userTurn([READ_TOOL, WRITE_TOOL])))).toEqual([
    chunk({ index: 0, delta: { role: 'assistant', tool_calls: [writeCall] }, finish_reason: null }),
    chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' }),
  ]);
  const plain = await complete(origin, { ...userTurn([WRITE_TOOL]), stream: false });
  expect(plain.headers.get('content-type')).toBe('application/json');
  expect(await plain.json()).toEqual({
    id: 'owned-completion',
    created: 1,
    model: 'owned-model',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [writeCall] },
        finish_reason: 'tool_calls',
      },
    ],
  });
});

it.each([
  ['the tool-result round', userTurn([WRITE_TOOL], toolResult)],
  ['the tool-free title request', userTurn()],
  ['a request without the write tool', userTurn([READ_TOOL])],
  ['a tool history with an empty tool roster', userTurn([], toolResult)],
])('replies with text to %s under a script', async (_name, body) => {
  const origin = await start({ ...BASE, script: SCRIPT });
  expect(await streamed(await complete(origin, body))).toEqual(replyChunks);
});

it('counts authenticated requests, tool results and marked requests in its health', async () => {
  const origin = await start({ ...BASE, script: SCRIPT });
  const before = await fetch(`${origin}/health`);
  expect(await before.json()).toEqual({
    ready: true,
    markedRequests: 0,
    requests: 0,
    toolResults: 0,
  });
  const rejected = await complete(origin, userTurn([WRITE_TOOL]), 'wrong-key');
  expect(rejected.status).toBe(403);
  await rejected.arrayBuffer();
  for (const body of [
    userTurn([WRITE_TOOL]),
    userTurn([WRITE_TOOL], toolResult),
    userTurn(),
    { model: BASE.model, stream: true, messages: [{ role: 'user', content: 'unmarked' }] },
  ])
    await (await complete(origin, body)).arrayBuffer();
  const malformed = await complete(origin, { model: 'other-model', messages: [] });
  expect(malformed.status).toBe(400);
  await malformed.arrayBuffer();
  const after = await fetch(`${origin}/health`);
  expect(await after.json()).toEqual({
    ready: true,
    markedRequests: 3,
    requests: 5,
    toolResults: 1,
  });
});

it.each([
  ['an extra script key', { ...SCRIPT, mode: 'write' }],
  ['a missing content', { path: SCRIPT.path }],
  ['a non-string content', { ...SCRIPT, content: 7 }],
  ['a non-string path', { ...SCRIPT, path: 7 }],
  ['a relative path', { ...SCRIPT, path: 'data/work/x.txt' }],
  ['a path outside the work directory', { ...SCRIPT, path: '/data/home/x.txt' }],
  ['the work directory itself', { ...SCRIPT, path: '/data/work/' }],
  ['a traversing path', { ...SCRIPT, path: '/data/work/../home/x.txt' }],
  ['a non-object script', 'write'],
])('rejects %s before listening', async (_name, script) => {
  const { closed } = await launch({ ...BASE, script }, await unusedPort());
  const { code, stderr } = await closed;
  expect(code).not.toBe(0);
  expect(stderr).toContain('Invalid owned model configuration');
});

it('rejects a malformed port argument before listening', async () => {
  const { closed } = await launch(BASE, 'x');
  const { code, stderr } = await closed;
  expect(code).not.toBe(0);
  expect(stderr).toContain('Invalid owned model port');
});

const HOLD = 'hold-nonce-7';
const held = (tools?: unknown[], extra: unknown[] = []) => ({
  ...userTurn(tools, extra),
  messages: [{ role: 'user', content: `please ${HOLD}` }, ...extra],
});
const health = async (origin: string) => (await fetch(`${origin}/health`)).json() as unknown;
const release = (origin: string) => fetch(`${origin}/release`, { method: 'POST' });

it('holds only the first write-capable hold request without a tool result until released', async () => {
  const origin = await start({ ...BASE, script: SCRIPT, hold: HOLD });
  expect(await health(origin)).toEqual({
    ready: true,
    markedRequests: 0,
    requests: 0,
    toolResults: 0,
    held: 0,
  });
  const first = complete(origin, held([WRITE_TOOL]));
  for (;;) {
    const observed = (await health(origin)) as { held: number };
    if (observed.held === 1) break;
    await delay(20);
  }
  // Title requests, tool-result rounds, unmarked turns and a second hold request answer at once.
  expect(await streamed(await complete(origin, held()))).toEqual(replyChunks);
  expect(await streamed(await complete(origin, held([WRITE_TOOL], toolResult)))).toEqual(
    replyChunks,
  );
  expect(await streamed(await complete(origin, userTurn([WRITE_TOOL])))).toHaveLength(2);
  expect(await streamed(await complete(origin, held([WRITE_TOOL])))).toHaveLength(2);
  expect(await health(origin)).toMatchObject({ held: 1, requests: 5 });
  const released = await release(origin);
  expect(released.status).toBe(200);
  expect(await released.json()).toEqual({ released: 1 });
  expect(await streamed(await first)).toEqual([
    chunk({ index: 0, delta: { role: 'assistant', tool_calls: [writeCall] }, finish_reason: null }),
    chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' }),
  ]);
  expect(await health(origin)).toMatchObject({ held: 0 });
  // Released and disarmed: a later hold request answers at once and a second release is empty.
  expect(await streamed(await complete(origin, held([WRITE_TOOL])))).toHaveLength(2);
  expect(await (await release(origin)).json()).toEqual({ released: 0 });
});

it('keeps release unavailable and health unchanged without a hold', async () => {
  const origin = await start(BASE);
  const rejected = await release(origin);
  expect(rejected.status).toBe(403);
  await rejected.arrayBuffer();
  await (await complete(origin, held([WRITE_TOOL]))).arrayBuffer();
  expect(await health(origin)).toEqual({
    ready: true,
    markedRequests: 0,
    requests: 1,
    toolResults: 0,
  });
});

it('counts requests whose messages carry a forbidden string', async () => {
  const origin = await start({ ...BASE, forbidden: ['kb-scope', '知识库范围'] });
  for (const content of [
    '/kb-scope {}',
    '知识库范围：全部',
    'unrelated',
    `${BASE.marker} kb-scope`,
  ])
    await (
      await complete(origin, {
        model: BASE.model,
        stream: true,
        messages: [{ role: 'user', content }],
      })
    ).arrayBuffer();
  expect(await health(origin)).toEqual({
    ready: true,
    markedRequests: 1,
    requests: 4,
    toolResults: 0,
    forbiddenRequests: 3,
  });
});

it.each([
  ['a non-string hold', { hold: 7 }],
  ['an empty hold', { hold: '' }],
  ['a non-array forbidden', { forbidden: 'kb-scope' }],
  ['a non-string forbidden entry', { forbidden: ['kb-scope', 1] }],
  ['an empty forbidden entry', { forbidden: [''] }],
])('rejects %s before listening', async (_name, extra) => {
  const { closed } = await launch({ ...BASE, ...extra }, await unusedPort());
  const { code, stderr } = await closed;
  expect(code).not.toBe(0);
  expect(stderr).toContain('Invalid owned model configuration');
});
