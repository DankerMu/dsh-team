import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const checkpointPath = require.resolve('@deepseek-ai/dsh-session-checkpoint-policy');
/** Hold the actual released durability checkpoint AFTER guard admission, not an outer gate. */
export async function postGuardRevocation(ctx, agent, approval, { target, write, state }) {
  const checkpointManifest =
    require.resolve('@deepseek-ai/dsh-session-checkpoint-policy/package.json');
  assert.equal(JSON.parse(readFileSync(checkpointManifest, 'utf8')).version, '0.2.0-rc.2');
  assert.equal(
    createHash('sha256').update(readFileSync(checkpointPath)).digest('hex'),
    '80a4475de0594399bfdd3203e000cfe0bf1967af163f8747c45b9b80e9549f2a',
  );
  for (const [start, changes] of [
    ['danger-full-access', []],
    ['danger-full-access', ['approval']],
    ['danger-full-access', ['approval', 'danger-full-access']],
    ['approval', ['danger-full-access', 'approval']],
  ]) {
    ctx.permissionPresets.set(agent.session, start);
    approval.answer = 'allowed-once';
    const before = approval.requests.length;
    const path = target('post-guard');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const commandSignal = new AbortController().signal;
    const disposers = [];
    let active,
      held,
      pending,
      guardCount = 0,
      settled = false;
    try {
      disposers.push(
        ctx.tools.guard((exec) => {
          if (exec.agent === agent && exec.arguments.file_path === path) {
            guardCount++;
            assert.equal(exec.signal.aborted, false);
          }
          return undefined;
        }),
      );
      disposers.push(
        ctx.on(
          'tools/execute',
          async (exec, next) => {
            if (exec.agent !== agent || exec.arguments.file_path !== path) return next();
            active = exec;
            try {
              return await next();
            } finally {
              active = undefined;
            }
          },
          { prepend: true },
        ),
      );
      disposers.push(
        ctx.on('session/flush', async (session) => {
          if (session !== agent.session || !active || held) return;
          held = active;
          // The package hash qualifies the release; the synchronous caller proves
          // this is its real awaited flush, not the Agent pre-step checkpoint.
          const previous = Error.stackTraceLimit;
          let stack;
          try {
            Error.stackTraceLimit = 64;
            stack = new Error().stack;
          } finally {
            Error.stackTraceLimit = previous;
          }
          assert(stack.includes(checkpointPath));
          assert.equal(held.parent, undefined);
          assert.equal(guardCount, 1);
          assert.equal(held.signal.aborted, false);
          assert.equal(settled, false);
          assert(!existsSync(path));
          entered.resolve();
          await release.promise;
        }),
      );
      pending = write(ctx, agent, path).finally(() => {
        settled = true;
      });
      const reached = await Promise.race([
        entered.promise.then(() => true),
        pending.then(() => false),
      ]);
      assert.equal(reached, true, 'The mutation must reach the released post-guard checkpoint');
      assert.equal(approval.requests.length, before + Number(start === 'approval'));
      for (const tier of changes) {
        const result = await ctx.commands.execute(agent, '/permission ' + tier, [], commandSignal);
        assert.equal(result.result.kind, 'success');
        assert.equal(result.result.text, 'preset ' + tier);
      }
      assert.equal(state(ctx, agent).preset, changes.at(-1) ?? start);
      assert.equal(held.signal.aborted, changes.length > 0);
      assert.equal(settled, false);
      assert(!existsSync(path), 'No effect may happen while the actual checkpoint is held');
      release.resolve();
      const result = await pending;
      assert.equal(result.isError, changes.length > 0);
      if (changes.length) {
        assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH');
        assert(!existsSync(path), 'Revoked authority must never reach the native write body');
      } else {
        assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
      }
    } finally {
      release.resolve();
      if (!settled) agent.cancel({ kind: 'user' });
      if (pending) await pending;
      for (const dispose of disposers.reverse()) dispose();
    }
  }
}
