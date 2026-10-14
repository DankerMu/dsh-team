import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';

async function failedPath(ctx, parent, fixture, inTurn, path) {
  const task = fixture.task('complete', [
    {
      name: 'build_docx',
      arguments: { path, paragraphs: [{ text: 'Owned failure control' }] },
    },
  ]);
  let run;
  try {
    await inTurn(parent, async (signal) => {
      run = await ctx.subagents.start('spawn', { parent, prompt: task.prompt, signal });
      assert.equal((await run.result).stopReason, 'completed');
    });
    const events = run.localAgent.session.snapshotEvents();
    const call = events.find(
      (event) => event.type === 'tool/call' && event.data.name === 'build_docx',
    );
    assert(call, 'failure control must actually request construction');
    const result = events.find(
      (event) =>
        event.type === 'tool/result' &&
        event.data.turn === call.data.turn &&
        event.data.step === call.data.step &&
        event.data.message.toolCallId === call.data.callId,
    );
    assert.equal(result.data.message.isError, true);
    assert.equal(result.data.meta, undefined);
  } finally {
    if (run) await run.dispose();
  }
}

async function cancelledConstruction(ctx, parent, fixture, inTurn, path) {
  const entered = Promise.withResolvers();
  const stop = ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'build_docx' || exec.arguments.path !== path) return next();
    entered.resolve();
    await new Promise((resolve) => {
      if (exec.signal.aborted) resolve();
      else exec.signal.addEventListener('abort', resolve, { once: true });
    });
    return { kind: 'cancel' };
  });
  const task = fixture.task('complete', [
    { name: 'build_docx', arguments: { path, paragraphs: [{ text: 'Cancelled construction' }] } },
  ]);
  let run;
  try {
    await inTurn(parent, async (signal) => {
      run = await ctx.subagents.start('spawn', { parent, prompt: task.prompt, signal });
      await entered.promise;
      await run.dispose();
      assert.equal((await run.result).stopReason, 'aborted');
    });
    assert.equal(existsSync(path), false);
    const results = run.localAgent.session
      .snapshotEvents()
      .filter((event) => event.type === 'tool/result');
    assert(
      results.every(
        (event) => event.data.message.isError === true && event.data.meta === undefined,
      ),
    );
  } finally {
    stop();
    if (run) await run.dispose();
  }
}

export async function constructionFailures(ctx, parent, fixture, inTurn) {
  const id = randomUUID();
  const sentinel = '/data/work/office-sentinel-' + id + '.docx';
  const link = '/data/work/office-link-' + id + '.docx';
  const dangling = '/data/work/office-dangling-' + id + '.docx';
  const directory = '/data/work/office-directory-' + id + '.docx';
  const ancestor = '/data/work/office-ancestor-' + id;
  const outside = '/data/home/office-outside-' + id + '.docx';
  writeFileSync(sentinel, 'Owned existing document bytes');
  symlinkSync(sentinel, link);
  symlinkSync(outside, dangling);
  mkdirSync(directory);
  symlinkSync('/data/home', ancestor);
  const paths = [
    sentinel,
    link,
    dangling,
    directory,
    outside,
    '../home/' + outside.split('/').at(-1),
    ancestor + '/' + outside.split('/').at(-1),
  ];
  for (const path of paths) await failedPath(ctx, parent, fixture, inTurn, path);
  assert.equal(readFileSync(sentinel, 'utf8'), 'Owned existing document bytes');
  assert.equal(existsSync(outside), false);
  await cancelledConstruction(
    ctx,
    parent,
    fixture,
    inTurn,
    '/data/work/office-cancel-' + id + '.docx',
  );
  return {
    rejectedPaths: paths.length,
    sentinelUnchanged: true,
    outsideAbsent: true,
    cancelledBeforeBody: true,
  };
}
