import { describe, expect, it, vi } from 'vitest';
import { review } from './review.js';

const agent = {
  options: { provider: 'current', model: 'selected' },
  session: { header: { cwd: '/data/work' }, requestHeader: () => undefined },
};
const exec = {
  name: 'write',
  arguments: { file_path: '/data/work/a', content: 'ordinary' },
  schema: { name: 'write' },
};
const text = (value) => ({ type: 'text-delta', index: 0, text: value });
const finish = (kind) => ({ type: 'finish', reason: { kind } });
const context = (chunks) => ({
  llm: {
    stream: async function* () {
      yield* chunks;
    },
  },
});

describe('Auto authorization protocol', () => {
  it('allows a complete allow on the current agent route with frozen action data', async () => {
    let request;
    const ctx = {
      llm: {
        stream: async function* (options) {
          request = options;
          yield text('{"decision":"allow"}');
          yield finish('stop');
        },
      },
    };

    expect(await review(ctx, agent, exec, new AbortController().signal)).toBe(true);
    expect(request.provider).toBe('current');
    expect(request.model).toBe('selected');
    expect(JSON.parse(request.messages[0].content[0].text)).toEqual({
      cwd: '/data/work',
      name: 'write',
      schema: { name: 'write' },
      arguments: exec.arguments,
    });
    expect(Object.isFrozen(request.messages)).toBe(true);
  });

  it.each([
    [text('{"decision":"allow"}'), finish('error')],
    [text('{"decision":"allow"}'), finish('aborted')],
    [text('{"decision":"allow"}'), finish('max-tokens')],
    [text('{"decision":"allow"}')],
    [text('{"decision":"allow"}'), finish('stop'), text(' ')],
    [text('{"decision":"allow","decision":"allow"}'), finish('stop')],
    [text('{"decision":"allow","extra":true}'), finish('stop')],
    [text('{"decision":"deny"}'), finish('stop')],
    [text('not JSON'), finish('stop')],
    [text(' '.repeat(8193)), finish('stop')],
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      text('{"decision":"allow"}'),
      finish('stop'),
    ],
    [
      text('{"decision":"allow"}'),
      { type: 'block-end', index: 0, block: { type: 'text' } },
      finish('stop'),
    ],
    [{ type: 'tool-call-delta', index: 0 }, finish('stop')],
    [{ type: 'text-delta', index: -1, text: '{"decision":"allow"}' }, finish('stop')],
    [
      { type: 'text-delta', index: 0, text: '{"decision":"allow"}' },
      { type: 'reasoning-delta', index: 0, text: 'conflicting' },
      finish('stop'),
    ],
  ])('does not authorize an incomplete or unusable stream %#', async (...chunks) => {
    expect(await review(context(chunks), agent, exec, new AbortController().signal)).toBe(false);
  });

  it('uses the most recent request route rather than creation defaults', async () => {
    const routed = {
      ...agent,
      session: {
        ...agent.session,
        requestHeader: () => ({ config: { provider: 'new', model: 'new-model' } }),
      },
    };
    let selected;
    const ctx = {
      llm: {
        stream: async function* (options) {
          selected = options;
          yield text('{"decision":"allow"}');
          yield finish('stop');
        },
      },
    };

    expect(await review(ctx, routed, exec, new AbortController().signal)).toBe(true);
    expect([selected.provider, selected.model]).toEqual(['new', 'new-model']);
  });

  it('allows completed reasoning and text blocks but refuses reopened or inconsistent text', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'ordinary local write' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'ordinary local write' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '{"decision":"allow"}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '{"decision":"allow"}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      finish('stop'),
    ];

    expect(await review(context(chunks), agent, exec, new AbortController().signal)).toBe(true);
    chunks.splice(6, 0, { type: 'text-delta', index: 1, text: 'more' });
    expect(await review(context(chunks), agent, exec, new AbortController().signal)).toBe(false);
  });

  it('does not leak adapter exceptions or authorize an aborted review', async () => {
    const signal = AbortSignal.abort();
    const ctx = {
      llm: {
        stream: async function* () {
          yield text('{"decision":"allow"}');
          throw new Error('secret adapter error');
        },
      },
    };

    expect(await review(ctx, agent, exec, new AbortController().signal)).toBe(false);
    expect(
      await review(context([text('{"decision":"allow"}'), finish('stop')]), agent, exec, signal),
    ).toBe(false);
  });

  it('expires cooperative review instead of authorizing a late allow', async () => {
    vi.useFakeTimers();
    const ctx = {
      llm: {
        stream: async function* (options) {
          const stopped = Promise.withResolvers();
          options.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
          await stopped.promise;
          yield text('{"decision":"allow"}');
          yield finish('stop');
        },
      },
    };
    try {
      const pending = review(ctx, agent, exec, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reviews the actual native tool schema when the execution carries no PTC binding schema', async () => {
    let request;
    const ctx = {
      tools: {
        schemas: (selectedAgent) => {
          expect(selectedAgent).toBe(agent);
          return [{ name: 'write', parameters: { file_path: { type: 'string' } } }];
        },
      },
      llm: {
        stream: async function* (options) {
          request = options;
          yield text('{"decision":"allow"}');
          yield finish('stop');
        },
      },
    };
    const native = { name: exec.name, arguments: exec.arguments };

    expect(await review(ctx, agent, native, new AbortController().signal)).toBe(true);
    expect(JSON.parse(request.messages[0].content[0].text).schema).toEqual({
      name: 'write',
      parameters: { file_path: { type: 'string' } },
    });
  });

  it.each([
    { options: { model: 'selected' }, session: agent.session },
    { options: { provider: 'current' }, session: agent.session },
    { ...agent, session: { ...agent.session, header: {} } },
  ])('does not authorize an action without a complete route and cwd %#', async (incomplete) => {
    expect(
      await review(
        context([text('{"decision":"allow"}'), finish('stop')]),
        incomplete,
        exec,
        new AbortController().signal,
      ),
    ).toBe(false);
  });

  it('does not authorize a native call with an unavailable schema', async () => {
    const native = { name: 'write', arguments: exec.arguments };

    expect(
      await review(
        context([text('{"decision":"allow"}'), finish('stop')]),
        agent,
        native,
        new AbortController().signal,
      ),
    ).toBe(false);
  });

  it('bounds metadata-only streams that would otherwise starve the cooperative deadline', async () => {
    let emitted = 0;
    const ctx = {
      llm: {
        stream: async function* () {
          for (;;) {
            emitted++;
            yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
          }
        },
      },
    };

    expect(await review(ctx, agent, exec, new AbortController().signal)).toBe(false);
    expect(emitted).toBe(1025);
  });
});
