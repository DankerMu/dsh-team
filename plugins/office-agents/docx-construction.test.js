import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from './docx-construction.js';

const roots = new Set();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

// Only the native shell service is substituted. Path fixtures use the real filesystem;
// the fixed Python body, atomic publication and sandbox enforcement need native coverage.
function construction() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-docx-')));
  roots.add(root);
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const path = join(cwd, 'draft.docx');
  const controller = new AbortController();
  const agent = { session: { id: 'writer', header: { cwd } } };
  const registered = new Map();
  const policy = { mode: 'workspace-write', approval: 'ask' };
  const sandboxPolicy = { resolve: () => policy };
  const result = {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stdout: { text: '' },
    stderr: { text: '' },
    sandbox: { mode: 'workspace-write', denied: false },
  };
  const shell = {
    sandboxMode: 'workspace-write',
    resolve: vi.fn((request) => request),
    execute: vi.fn(async () => ({ result: async () => result })),
  };
  apply({
    tools: { register: (tool) => registered.set(tool.name, tool) },
    shell,
    sandboxPolicy,
    get: (name) => (name === 'sandboxPolicy' ? sandboxPolicy : undefined),
  });
  const tool = registered.get('build_docx');
  const args = { path, paragraphs: [{ text: 'Ordinary draft', style: 'normal' }] };
  const exec = { agent, signal: controller.signal, callId: 'construction-call' };
  return {
    root,
    cwd,
    path,
    controller,
    shell,
    result,
    args,
    exec,
    execute: (input = args) => tool.execute(input, exec),
  };
}

async function rejectedBeforeExecution(entry, input) {
  await expect(entry.execute(input)).rejects.toBeInstanceOf(Error);
  expect(entry.shell.execute).not.toHaveBeenCalled();
  expect(existsSync(entry.path)).toBe(false);
}

const receipt = (path) => ({
  path,
  bytes: 4096,
  sha256: '0123456789abcdef'.repeat(4),
  uid: 1001,
});

const maximumTextArray = () => [
  ...Array.from({ length: 6 }, () => ({ text: 'a'.repeat(4092) })),
  { text: 'b'.repeat(4095) },
  { text: 'c'.repeat(4096) },
];

describe('structured document input', () => {
  it.each([
    { label: 'null root', input: () => null },
    { label: 'array root', input: () => [] },
    { label: 'missing path', input: () => ({ paragraphs: [{ text: 'Draft' }] }) },
    { label: 'empty path', input: (args) => ({ ...args, path: '' }) },
    { label: 'nonstring path', input: (args) => ({ ...args, path: 42 }) },
    { label: 'NUL path', input: (args) => ({ ...args, path: 'draft\u0000.docx' }) },
    { label: 'missing paragraphs', input: (args) => ({ path: args.path }) },
    { label: 'nonarray paragraphs', input: (args) => ({ ...args, paragraphs: 'Draft' }) },
    { label: 'empty document', paragraphs: [] },
    { label: 'string paragraph', paragraphs: ['Draft'] },
    { label: 'null paragraph', paragraphs: [null] },
    { label: 'array paragraph', paragraphs: [['Draft']] },
    { label: 'missing text', paragraphs: [{ style: 'normal' }] },
    { label: 'nonstring text', paragraphs: [{ text: 42 }] },
    { label: 'unknown style', paragraphs: [{ text: 'Draft', style: 'Heading 1' }] },
    { label: 'nonstring style', paragraphs: [{ text: 'Draft', style: null }] },
    { label: 'unknown paragraph property', paragraphs: [{ text: 'Draft', source: 'other.docx' }] },
    { label: 'completed document bytes', input: (args) => ({ ...args, base64: 'UEsDBA==' }) },
    { label: 'source passthrough', input: (args) => ({ ...args, source: 'other.docx' }) },
    { label: 'model code', input: (args) => ({ ...args, code: 'print(1)' }) },
    { label: 'too many paragraphs', paragraphs: Array.from({ length: 65 }, () => ({ text: 'a' })) },
    { label: 'oversized paragraph', paragraphs: [{ text: 'a'.repeat(4097) }] },
    { label: 'oversized Unicode paragraph', paragraphs: [{ text: '😀'.repeat(4097) }] },
    {
      label: 'oversized UTF-8 content',
      paragraphs: Array.from({ length: 3 }, () => ({ text: '中'.repeat(4096) })),
    },
    {
      label: 'oversized JSON-escaped content',
      paragraphs: Array.from({ length: 8 }, () => ({ text: '"'.repeat(2048) })),
    },
  ])('rejects $label before constructing a file', async (change) => {
    const entry = construction();
    const input = change.input
      ? change.input(entry.args)
      : { ...entry.args, paragraphs: change.paragraphs };

    await rejectedBeforeExecution(entry, input);
  });

  it('rejects text beyond the serialized UTF-8 array bound', async () => {
    const entry = construction();
    const paragraphs = maximumTextArray();
    paragraphs[6].text += 'b';

    await rejectedBeforeExecution(entry, { ...entry.args, paragraphs });
  });

  it.each([
    {
      label: 'all supported styles',
      paragraphs: [
        { text: 'Title', style: 'title' },
        { text: 'Section', style: 'heading1' },
        { text: 'Subsection', style: 'heading2' },
        { text: 'Body', style: 'normal' },
        { text: '' },
      ],
    },
    { label: '64 paragraphs', paragraphs: Array.from({ length: 64 }, () => ({ text: 'Draft' })) },
    { label: '4096 Unicode code points', paragraphs: [{ text: '😀'.repeat(4096) }] },
    { label: '32768 serialized UTF-8 bytes', paragraphs: maximumTextArray() },
  ])('admits $label to the native constructor', async ({ paragraphs }) => {
    const entry = construction();
    const unavailable = new Error('Native constructor unavailable');
    entry.shell.execute.mockRejectedValue(unavailable);

    await expect(entry.execute({ ...entry.args, paragraphs })).rejects.toBe(unavailable);
    expect(existsSync(entry.path)).toBe(false);
  });
});

describe('workspace destination safety', () => {
  it.each([
    { label: 'relative traversal', destination: () => '../outside.docx' },
    { label: 'absolute outside path', destination: (entry) => join(entry.root, 'outside.docx') },
    { label: 'common-prefix sibling', destination: (entry) => `${entry.cwd}-other/draft.docx` },
  ])('rejects a $label destination', async ({ destination }) => {
    const entry = construction();
    await rejectedBeforeExecution(entry, { ...entry.args, path: destination(entry) });
  });

  it('does not replace an existing regular destination', async () => {
    const entry = construction();
    writeFileSync(entry.path, 'existing document');

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);

    expect(entry.shell.execute).not.toHaveBeenCalled();
    expect(readFileSync(entry.path, 'utf8')).toBe('existing document');
  });

  it('rejects a directory destination without modifying its contents', async () => {
    const entry = construction();
    mkdirSync(entry.path);
    const retained = join(entry.path, 'retained');
    writeFileSync(retained, 'retained content');

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);

    expect(entry.shell.execute).not.toHaveBeenCalled();
    expect(readFileSync(retained, 'utf8')).toBe('retained content');
  });

  it.each(['existing', 'dangling'])('rejects a %s destination symlink', async (kind) => {
    const entry = construction();
    const outside = join(entry.root, 'outside.docx');
    if (kind === 'existing') writeFileSync(outside, 'outside content');
    symlinkSync(outside, entry.path);

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);

    expect(entry.shell.execute).not.toHaveBeenCalled();
    if (kind === 'existing') expect(readFileSync(outside, 'utf8')).toBe('outside content');
    else expect(existsSync(outside)).toBe(false);
  });

  it('rejects an ancestor symlink escaping the workspace', async () => {
    const entry = construction();
    const outside = join(entry.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(entry.cwd, 'linked'));

    await rejectedBeforeExecution(entry, {
      ...entry.args,
      path: join(entry.cwd, 'linked', 'draft.docx'),
    });
    expect(existsSync(join(outside, 'draft.docx'))).toBe(false);
  });

  it('admits a relative destination within the workspace', async () => {
    const entry = construction();
    const unavailable = new Error('Native constructor unavailable');
    entry.shell.execute.mockRejectedValue(unavailable);

    await expect(entry.execute({ ...entry.args, path: 'draft.docx' })).rejects.toBe(unavailable);
    expect(existsSync(entry.path)).toBe(false);
  });
});

describe('failed construction cannot issue a receipt', () => {
  it.each(['resolve', 'execute'])('rejects when native shell %s fails', async (operation) => {
    const entry = construction();
    const unavailable = new Error('Native shell unavailable');
    if (operation === 'resolve')
      entry.shell.resolve.mockImplementation(() => {
        throw unavailable;
      });
    else entry.shell.execute.mockRejectedValue(unavailable);

    await expect(entry.execute()).rejects.toBe(unavailable);
    expect(existsSync(entry.path)).toBe(false);
  });

  it.each([
    { label: 'nonzero exit', change: { exitCode: 1 } },
    { label: 'signal exit', change: { exitCode: null } },
    { label: 'timeout', change: { timedOut: true } },
    { label: 'abort', change: { aborted: true } },
    { label: 'sandbox denial', sandbox: { mode: 'workspace-write', denied: true } },
    { label: 'sandbox runner failure', sandbox: { mode: 'workspace-write', runnerFailed: true } },
  ])('rejects a $label even when stdout claims success', async ({ change, sandbox }) => {
    const entry = construction();
    entry.result.stdout.text = JSON.stringify(receipt(entry.path));
    Object.assign(entry.result, change);
    if (sandbox) entry.result.sandbox = sandbox;

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);
  });

  it('rejects a truncated stdout tail even when it contains a complete receipt', async () => {
    const entry = construction();
    entry.result.stdout = { text: JSON.stringify(receipt(entry.path)), truncated: true };

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the native constructor cannot report its settled result', async () => {
    const entry = construction();
    const unavailable = new Error('Native result unavailable');
    entry.shell.execute.mockResolvedValue({
      result: async () => {
        throw unavailable;
      },
    });

    await expect(entry.execute()).rejects.toBe(unavailable);
  });

  it.each([
    { label: 'empty output', output: () => '' },
    { label: 'malformed output', output: () => 'not JSON' },
    { label: 'null output', output: () => 'null' },
    { label: 'array output', output: () => '[]' },
    { label: 'missing fields', output: () => '{}' },
    { label: 'different destination', change: { path: '/other/draft.docx' } },
    { label: 'relative receipt path', change: { path: 'draft.docx' } },
    { label: 'zero bytes', change: { bytes: 0 } },
    { label: 'oversized document', change: { bytes: 1048577 } },
    { label: 'fractional bytes', change: { bytes: 1.5 } },
    { label: 'nonnumber bytes', change: { bytes: '4096' } },
    { label: 'invalid digest', change: { sha256: 'not a digest' } },
    { label: 'uppercase digest', change: { sha256: 'A'.repeat(64) } },
    { label: 'negative uid', change: { uid: -1 } },
    { label: 'fractional uid', change: { uid: 1001.5 } },
    { label: 'unsafe uid', change: { uid: 9007199254740992 } },
    { label: 'extra receipt fields', change: { source: 'other.docx' } },
  ])('rejects $label instead of publishing construction metadata', async ({ output, change }) => {
    const entry = construction();
    entry.result.stdout.text = output
      ? output()
      : JSON.stringify({ ...receipt(entry.path), ...change });

    await expect(entry.execute()).rejects.toBeInstanceOf(Error);
  });

  it('does not start a cancelled construction', async () => {
    const entry = construction();
    entry.controller.abort();

    await expect(entry.execute()).rejects.toMatchObject({ name: 'AbortError' });
    expect(entry.shell.execute).not.toHaveBeenCalled();
  });

  it('cancels an in-flight native constructor without accepting its late receipt', async () => {
    const entry = construction();
    const entered = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    let nativeCancelled = false;
    entry.result.stdout.text = JSON.stringify(receipt(entry.path));
    entry.shell.execute.mockImplementation(async (request) => {
      request.signal.addEventListener(
        'abort',
        () => {
          nativeCancelled = true;
          stopped.resolve();
        },
        { once: true },
      );
      entered.resolve();
      return {
        result: async () => {
          await stopped.promise;
          return entry.result;
        },
      };
    });
    const pending = entry.execute();
    const phase = await Promise.race([
      entered.promise.then(() => 'executing'),
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
    ]);

    entry.controller.abort();
    // Independently settle the stand-in even if the caller signal was not forwarded.
    stopped.resolve();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(phase).toBe('executing');
    expect(nativeCancelled).toBe(true);
  });

  it('rejects a successful shell result when caller cancellation wins settlement', async () => {
    const entry = construction();
    entry.result.stdout.text = JSON.stringify(receipt(entry.path));
    entry.shell.execute.mockImplementation(async () => ({
      result: async () => {
        entry.controller.abort();
        return entry.result;
      },
    }));

    await expect(entry.execute()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
