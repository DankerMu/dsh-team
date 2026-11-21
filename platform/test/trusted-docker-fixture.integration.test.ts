import { expect, it } from 'vitest';
import { caseSpawn } from './trusted-docker-fixture.ts';

// A 3s case keeps 1.5s in reserve, so its child is cut at 1.5s; the kill and the throw take far
// less than the 1s slack, so a cut that ignored the reserve (3s) or waited for a trapped SIGTERM
// (the child's own 4s exit) misses the bound.
const CUT_CASE_MS = 3000;
const CUT_RESERVE_MS = 1500;
const CUT_SLACK_MS = 1000;
// The trapping child exits by itself past the case, so a SIGTERM cut ends the call instead of hanging it.
const TRAPPED_EXIT_MS = 4000;
// A 1s case cut at 0.5s, for the message shapes alone.
const SHORT_CASE_MS = 1000;
const SHORT_RESERVE_MS = 500;
// The longest call above ends with its trapped child's own exit, well inside this bound.
const CASE_MS = 10_000;

function cutFailure(caseMs: number, reserveMs: number, descendants?: () => string) {
  const { spawn } = caseSpawn(caseMs, reserveMs, descendants);
  const child = `process.on('SIGTERM',()=>{});setTimeout(()=>{},${String(TRAPPED_EXIT_MS)});`;
  try {
    spawn('trapped child', process.execPath, ['-e', child], { encoding: 'utf8' });
  } catch (error) {
    if (!(error instanceof Error && error.cause instanceof Error)) throw error;
    return { message: error.message, cut: error.cause.message };
  }
  throw new Error('The trapped child was not cut');
}

it(
  'kills a SIGTERM-trapping child at the reserved cut and keeps the budget message as its cause',
  () => {
    const since = Date.now();

    const { message, cut } = cutFailure(CUT_CASE_MS, CUT_RESERVE_MS, () => 'pid=1 alive, killed');
    const elapsed = Date.now() - since;

    expect(elapsed).toBeLessThan(CUT_CASE_MS - CUT_RESERVE_MS + CUT_SLACK_MS);
    expect(message).toMatch(
      /^trapped child: killed at the case deadline after \d+ms; descendants: pid=1 alive, killed$/,
    );
    expect(cut).toMatch(/^trapped child: killed at the case deadline after \d+ms$/);
    expect(message).toBe(`${cut}; descendants: pid=1 alive, killed`);
  },
  CASE_MS,
);

it.each([
  { site: 'records no descendants', descendants: undefined, reported: 'not observed' },
  {
    site: 'cannot observe its descendants',
    descendants: () => {
      throw new TypeError('/private/descendant output');
    },
    reported: 'unobservable (TypeError)',
  },
])(
  'keeps the cut phase and milliseconds when the site $site',
  ({ descendants, reported }) => {
    const { message, cut } = cutFailure(SHORT_CASE_MS, SHORT_RESERVE_MS, descendants);

    expect(cut).toMatch(/^trapped child: killed at the case deadline after \d+ms$/);
    expect(message).toBe(`${cut}; descendants: ${reported}`);
  },
  CASE_MS,
);
