// `pnpm lane:vps:post <pr> <label> [--note <text>]`: publishes a passed lane summary. Every check
// (pass criteria, gh identity, PR head, body sections) runs before the first write; writes then
// run in order: one dsh-team/docker status, the Runtime evidence body edit, failed-run reruns.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyDockerEvidence } from '../platform/test/docker-evidence.ts';
import {
  capture,
  LABEL,
  laneFailures,
  LaneRefusal,
  readSummary,
  repositoryRoot,
  runDirectory,
  runtimeEvidence,
} from './vps-lane-record.mjs';

const USAGE = 'usage: pnpm lane:vps:post <pr> <label> [--note <text>]';
const CONTEXT = 'dsh-team/docker';
const EVIDENCE = /^## Runtime evidence[ \t]*\r?$/gm;
const RISK = /^## Risk[ \t]*\r?$/gm;

const gh = (args, what, input) =>
  capture('gh', args, { what, ...(input === undefined ? {} : { input }) });

/** The evidence gate's own acceptance rule, applied to a status this identity would post. */
function acceptedIdentity(login, head) {
  return verifyDockerEvidence({
    target: { kind: 'pull-request', headSha: head },
    evidence: { sha: head, statuses: [{ context: CONTEXT, state: 'success', creator: { login } }] },
  });
}

/** Replaces exactly the one `## Runtime evidence` section up to the one `## Risk` after it. */
function replaceEvidence(body, summary, note) {
  const evidence = [...body.matchAll(EVIDENCE)];
  const risk = [...body.matchAll(RISK)];
  if (evidence.length !== 1 || risk.length !== 1 || risk[0].index < evidence[0].index) return null;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return (
    body.slice(0, evidence[0].index) +
    runtimeEvidence(summary, note, eol) +
    body.slice(risk[0].index)
  );
}

function parse(args) {
  const [pr, label, ...rest] = args;
  const note = rest[0] === '--note' && rest.length === 2 ? rest[1] : undefined;
  if (
    !/^[1-9][0-9]*$/.test(pr ?? '') ||
    !LABEL.test(label ?? '') ||
    (rest.length > 0 && !note?.trim())
  )
    throw new LaneRefusal(USAGE, 2);
  return { pr, label, note: note?.trim() };
}

function checkedSummary(label) {
  const directory = runDirectory(repositoryRoot(), label);
  if (!existsSync(join(directory, 'summary.json')))
    throw new LaneRefusal(`no lane summary for label ${label}`);
  const summary = readSummary(directory);
  const failures = laneFailures(summary);
  if (failures.length)
    throw new LaneRefusal(`lane summary is not a full pass: ${failures.join(', ')}`);
  return summary;
}

function rerunFailedRuns(head) {
  const listed = gh(
    ['run', 'list', '--commit', head, '--json', 'databaseId,conclusion,headSha', '--limit', '100'],
    'status posted, body updated; failed runs not listed',
  );
  const failed = JSON.parse(listed).filter(
    (run) => run.headSha === head && run.conclusion === 'failure',
  );
  const refused = [];
  for (const run of failed) {
    try {
      gh(['run', 'rerun', String(run.databaseId), '--failed']);
      process.stdout.write(`reran failed run ${String(run.databaseId)}\n`);
    } catch {
      refused.push(run.databaseId);
    }
  }
  if (refused.length)
    throw new LaneRefusal(`status posted, body updated; reruns failed: ${refused.join(', ')}`);
}

export function postLane(args) {
  const { pr, label, note } = parse(args);
  const summary = checkedSummary(label);
  const head = summary.head;
  const login = gh(['api', 'user', '--jq', '.login'], 'gh identity unavailable').trim();
  if (!acceptedIdentity(login, head))
    throw new LaneRefusal(`gh identity ${login} is not the evidence gate login`);
  const view = JSON.parse(gh(['pr', 'view', pr, '--json', 'headRefOid,body'], 'PR view failed'));
  if (view.headRefOid !== head)
    throw new LaneRefusal(`PR head ${String(view.headRefOid)} is not the lane head ${head}`);
  const body = replaceEvidence(view.body ?? '', summary, note);
  if (body === null) throw new LaneRefusal('PR body lacks ## Runtime evidence followed by ## Risk');

  const description = `trusted VPS test:docker + test:deploy passed on exact head ${head.slice(0, 7)} (lane ${label})`;
  gh(
    [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/statuses/${head}`,
      '-f',
      'state=success',
      '-f',
      `context=${CONTEXT}`,
      '-f',
      `description=${description}`,
    ],
    'status POST failed; nothing written',
  );
  process.stdout.write(`posted ${CONTEXT} success on ${head}\n`);
  if (body === view.body) process.stdout.write('PR body Runtime evidence already current\n');
  else {
    gh(
      ['pr', 'edit', pr, '--body-file', '-'],
      'status posted, body not updated; rerun lane:vps:post',
      body,
    );
    process.stdout.write('PR body Runtime evidence replaced\n');
  }
  rerunFailedRuns(head);
  return 0;
}
