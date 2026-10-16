import { readFileSync } from 'node:fs';
import { Evaluator, Lexer, Parser, data } from '@actions/expressions';
import { parse } from 'yaml';

const reasons = new Set([
  'CI concurrency invalid policy',
  'CI PR concurrency collision',
  'CI main concurrency changed',
]);

function requirePolicy(condition, reason = 'CI concurrency invalid policy') {
  if (!condition) throw new Error(reason);
}

function evaluate(source, github) {
  const tokens = new Lexer(source).lex().tokens;
  const expression = new Parser(tokens, ['github'], []).parse();
  const context = JSON.parse(JSON.stringify({ github }), data.reviver);
  return new Evaluator(expression, context).evaluate();
}

function policy(concurrency, github) {
  const group = typeof concurrency === 'string' ? concurrency : concurrency?.group;
  requirePolicy(typeof group === 'string' && group.trim() !== '');
  const rendered = group.replace(/\$\{\{(.*?)\}\}/gs, (_, source) =>
    evaluate(source, github).coerceString(),
  );
  requirePolicy(rendered.trim() !== '' && !rendered.includes('${{'));
  const cancel =
    typeof concurrency === 'string' ? false : (concurrency['cancel-in-progress'] ?? false);
  if (typeof cancel === 'boolean') return { group: rendered.toLowerCase(), cancel };
  requirePolicy(typeof cancel === 'string');
  const expression = /^\$\{\{(.*?)\}\}$/s.exec(cancel.trim());
  requirePolicy(expression !== null);
  const value = evaluate(expression[1], github);
  requirePolicy(value.kind === data.Kind.Boolean);
  return { group: rendered.toLowerCase(), cancel: value.value };
}

function verify(concurrency) {
  const groups = new Set();
  const actions = [
    'opened',
    'labeled',
    'labeled',
    'unlabeled',
    'unlabeled',
    'reopened',
    'synchronize',
    'synchronize',
  ];
  for (const [index, action] of actions.entries()) {
    const current = policy(concurrency, {
      workflow: 'CI',
      event_name: 'pull_request',
      ref: 'refs/pull/17/merge',
      sha: 'a'.repeat(40),
      run_id: String(1000 + index),
      run_attempt: '1',
      event: {
        action,
        pull_request: {
          number: 17,
          head: { sha: 'b'.repeat(40) },
          labels: action === 'unlabeled' ? [] : [{ name: 'diff-limit-exempt' }],
        },
      },
    });
    // Shared groups can evict pending work even when running cancellation is false.
    requirePolicy(!groups.has(current.group), 'CI PR concurrency collision');
    groups.add(current.group);
  }
  for (const runId of ['2000', '2001']) {
    const current = policy(concurrency, {
      workflow: 'CI',
      event_name: 'push',
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
      run_id: runId,
      run_attempt: '1',
      event: {},
    });
    requirePolicy(
      current.group === 'ci-refs/heads/main' && current.cancel === false,
      'CI main concurrency changed',
    );
  }
}

try {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  verify(workflow?.concurrency);
  process.stdout.write('CI concurrency: independent PR invocations; main policy preserved\n');
} catch (error) {
  const reason =
    error instanceof Error && reasons.has(error.message)
      ? error.message
      : 'CI concurrency invalid policy';
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
