import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function copyCounterexample(
  ctx,
  fixture,
  { create, createUserMessage, eventsOf, settledWake },
) {
  const control = '/data/home/office-copy-control.json';
  const evidence = '/data/home/office-copy-evidence.json';
  const config = JSON.parse(readFileSync(control, 'utf8'));
  const observer = await import(pathToFileURL('/data/home/office-copy-observer.mjs').href);
  observer.apply(ctx, { control, evidence });
  const { notice, copied, nonce } = config;
  const staged = notice.path + '.prepared';
  const fields = [notice.title, notice.addressee, notice.matter, notice.issuer, notice.date];
  const make = (path) =>
    '/usr/bin/python3 -I -c ' +
    JSON.stringify(
      'from docx import Document; d=Document(); ' +
        fields.map((field) => 'd.add_paragraph(' + JSON.stringify(field) + ')').join('; ') +
        '; d.save(' +
        JSON.stringify(path) +
        ')',
    );
  const childTask = fixture.task('complete', [
    copied
      ? {
          name: 'bash',
          arguments: {
            description: 'Owned child copy operation',
            command: 'cp -- ' + JSON.stringify(staged) + ' ' + JSON.stringify(notice.path),
            timeoutMs: 10000,
          },
        }
      : {
          name: 'build_docx',
          arguments: {
            path: notice.path,
            paragraphs: fields.map((text) => ({ text })),
          },
        },
  ]);
  const parentTask = fixture.task('complete', [
    {
      name: 'bash',
      arguments: {
        description: 'Owned parent preparation',
        command: copied ? make(staged) : 'true',
        timeoutMs: 10000,
      },
    },
    {
      name: 'subagent',
      arguments: {
        description: 'Owned notice control',
        prompt: childTask.prompt[0].text,
      },
    },
    ...(!copied
      ? [
          // The delegation returns at once: review only in the turn the settlement wakes.
          { text: 'Owned parent awaits the writer settlement.' },
          {
            name: 'bash',
            arguments: {
              description: 'Owned parent review after writer construction',
              command:
                '/usr/bin/python3 -I -c ' +
                JSON.stringify(
                  'from docx import Document; p=' +
                    JSON.stringify(notice.path) +
                    '; d=Document(p); d.add_paragraph("已复核"); d.save(p)',
                ),
              timeoutMs: 10000,
            },
          },
        ]
      : []),
  ]);
  const parent = await create(ctx);
  const observe = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', config.reader], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 0, 'office-copy-final-reader');
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(observe().status, 'missing', 'office-docx-not-fresh');
    parent.agent.followup(
      createUserMessage({
        source: { kind: 'user', rpcId: randomUUID() },
        content: parentTask.prompt,
      }),
    );
    await parentTask.entered.promise;
    await settledWake(parent.agent);
    const signal = AbortSignal.timeout(5000);
    const parentProjection = await ctx.sessionController.projections(
      { sessionId: parent.agent.id },
      signal,
    );
    const listed = await ctx.sessionController.list({}, signal);
    const children = listed.items.filter((row) => row.parentSessionId === parent.agent.id);
    assert.equal(children.length, 1);
    const child = children[0];
    const projection = await ctx.sessionController.projections(
      { sessionId: child.sessionId },
      signal,
    );
    const history = await ctx.sessionController.page(
      {
        address: {
          kind: 'subagent',
          parentSessionId: parent.agent.id,
          childSessionId: child.sessionId,
          mode: projection.values.subagent.mode,
        },
        throughSeq: projection.asOfSeq,
        maxMessages: 500,
      },
      signal,
    );
    const parentEvents = eventsOf(parent.agent);
    return {
      artifact: observe(),
      preparedSha256: copied
        ? createHash('sha256').update(readFileSync(staged)).digest('hex')
        : null,
      records: history.records,
      cursor: projection.asOfSeq,
      hasMore: history.hasMore,
      preset: projection.values.agentPreset,
      prompt: childTask.prompt[0].text,
      delegation: {
        parent: {
          records: parentEvents.map((event) => ({ event })),
          cursor: parentProjection.asOfSeq,
          hasMore: false,
          preset: parentProjection.values.agentPreset,
          catalog: parentProjection.values.subagentCatalog,
          sessionId: parent.agent.id,
          cwd: '/data/work',
          prompt: parentTask.prompt[0].text,
        },
        child,
        identity: projection.values.subagent,
        nonce,
        notice,
        contribution: JSON.parse(readFileSync(evidence, 'utf8')),
      },
    };
  } finally {
    await parent.dispose();
  }
}
