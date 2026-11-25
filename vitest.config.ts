import { defineConfig } from 'vitest/config';
import { constraintNumber } from './scripts/constraints.mjs';

// Per-file threshold: a well-covered large file must not subsidize a bare one.
const minCoverage = constraintNumber('testing', 'min_line_coverage');

export default defineConfig({
  test: {
    projects: [
      {
        // Web TSX uses the same automatic React runtime as its Vite build.
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'unit',
          include: [
            'platform/src/**/*.test.ts',
            'platform/web/src/**/*.test.{ts,tsx}',
            'plugins/**/*.test.js',
            'images/dsh-user/*.test.mjs',
          ],
        },
      },
      { test: { name: 'integration', include: ['platform/test/**/*.integration.test.ts'] } },
      {
        test: {
          name: 'docker',
          include: ['platform/test/**/*.docker.test.ts'],
          // Preserve trusted owned-resource serialization; browser isolation does
          // not qualify a separate concurrency-policy change.
          fileParallelism: false,
          // Bounded build/run calls plus independent finally-cleanup need their own deadline.
          testTimeout: 900_000,
        },
      },
      {
        test: {
          name: 'model',
          include: ['platform/test/**/*.model.test.ts'],
          // Real-provider acceptance shares the trusted host; never run alongside another case.
          fileParallelism: false,
          testTimeout: 900_000,
        },
      },
      {
        test: {
          name: 'stack',
          include: ['platform/test/**/*.stack.test.ts'],
          fileParallelism: false,
          // One ledger: the 2400s base, then each lane's increment in order, summed at the end.
          // The base: two cold image builds (600s each, 1200s), compose, health, the conversation,
          // 13 in-instance proxy calls (30s each at most), drainage and the RAGFlow restore, which
          // is bounded at 300s from before `docker start` (its 60s CLI bound lies inside).
          // The legacy preview lane (#433) raised it by 600s: its preview waits are bounded at
          // 540s (240s each for DOC and PPT, 60s for XLS), its 12 in-instance execs at 30s each.
          // The office profile lane (#440) raised it by 480s: its instance restart waits 180s at
          // most for the gateway, its 10 docker calls 30s each.
          // The office editor lane (#440) raised it by 600s: three 120s write-back polls, three
          // editor loads and the Agent read-back at one 60s session timeout each.
          // The Document Server startup wait (#622) raised it by 300s: one pgrep poll bounded at
          // 300s before the first Office lane.
          // The concurrent same-name DOCX (#440) raised it by 180s: B's editor meets A's at load
          // (60s at most) and after the save (120s at most).
          // The guessed-key info at that load (#440) raised it by 60s: two docker execs, 30s each.
          // The office idle lane (#440) raised it by 660s: openHinted's 60s editor load (the
          // session timeout), documentServerReady's 60s healthcheck wait plus its last 30s exec,
          // the 210s hold (HOLD_MS), writtenBack's 120s write-back, the 240s idle-stop bound
          // (CONTROL_MS) and four 30s execs (lane.exec): editAndSave's write, its reads before the
          // edit and after the close, and withWorkFiles' removal. These sum to 840s, 180s over the
          // 660s added; the margin below covers the difference.
          // The operator font check (#440) raised it by 30s: one docker exec of fc-scan.
          // The forgotten attack lane (#624 §55.5) raised it by 420s: two editor loads (60s each)
          // for the failing edit and the recovery, a 60s forgotten-store wait, the B-container
          // attack exec (30s), a 60s recovery read-back poll and the two positive-control reads.
          // The office rewrite lane (#442) raised it by 1500s: per case the Document Server
          // healthcheck wait, an editor load, an Agent turn, the save's typing, a save poll and the
          // wait for the editor's notices to clear at one 60s session timeout each, two 15s
          // observation windows, the unsaved case's extra typing (60s), and 22 docker execs at 30s
          // each: per case the write, four file reads (start, after the rewrite, the save poll's
          // first, after the close), two provider reads and three listings, once the
          // configured-scripts read and the cleanup.
          // The office external lane (#649) raised it by 960s: two instance restarts (to the
          // external address, then the bundled restore) at the gateway's 180s each, five waits at
          // one 60s session timeout each (the login, the composer, the file row, and the composer
          // and the row after the failure), the 30s failure wait, the bundled healthcheck wait
          // (60s plus its last 30s exec) and six docker execs at 30s each: the listener check, the
          // file's write, read-back and removal, and the two provider reads.
          // The office rewrite typing case (#652) raised it by 870s: the Document Server
          // healthcheck wait, the editor load, the unsaved nonce's typing, the typing until the
          // stale banner latches, the second typing, the save poll and the notice-clear wait at one
          // 60s session timeout each, two 15s observation windows (the hold after the latch, the
          // wait after the close), and 14 docker execs at 30s each: the write, four file reads
          // (start, after the rewrite, the save poll's first, after the close), the rewrite, three
          // listings, three instance log reads (the earlier cases' control, before and after the
          // close) and two provider reads.
          // The forgotten-copy lifecycle (#650) raised it by 870s. Each of the three rewrite cases
          // (clean, unsaved, typing) adds 190s: registeredKey's 10s registry poll plus its last
          // 30s exec, and the record's five calls at 30s each (key count, namespace list read,
          // removal, key count, namespace list read); its settle reuses the case's existing wait
          // after the close. The forgotten case adds 255s: the store shape before the trigger, the
          // shape and the key count at the anchor (three 30s execs), the 15s settle after the
          // recovery and the same five-call record. A failing case's cleanup, once: its 15s settle
          // and a 30s removal (45s).
          // The rewrite notice windows (#657 A) raised it by 150s. Each of the clean and unsaved
          // cases adds 75s: the wait for its positives after the Agent turn (the refetch, and the
          // unsaved case's 「保存未写回文件」) at one 60s session timeout, and the 15s quiet window
          // after the save's clear.
          // The rewrite XLSX and PPTX cases (#657 A4) raised it by 1970s, 985s each, counted as a
          // clean DOCX case is: #442's 690s (six waits at one 60s session timeout: the healthcheck
          // wait, the editor load, the Agent turn, the save's typing, the save poll and the notice
          // clear; two 15s windows; ten 30s execs: the write, four reads, two provider reads and
          // three listings), #650's 190s, #657 A's 75s and the 30s template read.
          // The Office opening and typing helpers (#716) raised it by 6355s, counting every call at
          // the bounds of its serial waits (the call-site table of the office-stack-lane-budgets
          // change). openHinted: the row, the settled editor and the refusal at one 60s session
          // timeout each, the row click and its screenshot at Playwright's 30s default action
          // timeout (the stack browser sets none), 240s. typeAndSave: the area, ready, box and
          // click at 60s each, 240s, plus the caller's `loaded` hook. Per call site, executions x
          // 240s, plus its hooks, less the one 60s load or typing a line above already counts:
          //   hints openHinted (#439)                       1 x 240       =  240
          //   editAndSave openHinted (editor A 3, idle 1)   4 x 240 - 240 =  720
          //   editAndSave typeAndSave (the same four)       4 x 240 + 95  = 1055
          //   rewrite openHinted (six cases)                6 x 240 - 360 = 1080
          //   rewrite unsaved typing (three cases)          3 x 240 - 180 =  540
          //   rewrite save typing (six cases)               6 x 240 - 360 = 1080
          //   typing case typing, openHinted, save typing   3 x 240 - 180 =  540
          //   forgotten edit openHinted and typing          2 x 240 - 60  =  420
          //   forgotten recover openHinted                  1 x 240 - 60  =  180
          //   forgotten recover typeAndSave                 1 x 240 + 260 =  500
          // The 95s: the same-name hook's distinctKeys (a 5s poll plus its last 30s exec), the
          // third 30s call of its guessed-key info (the namespace holder's read; the 60s line
          // counts two) and the idle hook's font read (30s default). The gate's 60s (the 180s
          // line) and HOLD_MS (the idle line) are counted above; the idle hook's administrator
          // fetches pass no timeout and stay in the margin. The 260s: the recovery hook's
          // dismissAlert, a 20s wait and four 60s waits.
          // The masked sessions' Chinese UI wait (#717) raised it by 480s: one 60s session timeout
          // for each of eight (rewrite clean, unsaved, xlsx, pptx, unsaved-xlsx, unsaved-pptx and
          // typing; the forgotten edit).
          // The rewrite typing case's quiet window (#716) raised it by 15s.
          // The unsaved XLSX and PPTX rewrite cases (#716 item 4) raised it by 2090s, 1045s each:
          // the 985s an #657 A4 case counts (above) and the unsaved typing's 60s session timeout.
          // Their 540s each of helper rows (openHinted, the unsaved typing and the save typing at
          // 180s) are in the #716 table, and their masked session's 60s in the #717 line: 1645s
          // per case in all.
          // Sum: 2400 + 600 + 480 + 600 + 300 + 180 + 60 + 660 + 30 + 420 + 1500 + 960 + 870 +
          // 870 + 150 + 1970 + 6355 + 480 + 15 + 2090 = 20990s, the 1200s of cold builds plus
          // 19790s for everything else. Outside the opening and typing helpers, which it counts at
          // every bound, that remainder is a margin, not the sum of every per-step bound: a vitest
          // timeout skips the restore `finally` and leaves ragflow-cpu stopped (LOCAL_STACK.md §5),
          // and a stalled helper wait fails with its own label first. A poll bounded by a deadline
          // (the 120s write-back, for one) checks it only after its exec returns, so it can overrun
          // by that last exec; the margin covers that too. The four rewrite lines (#442, #652,
          // #657 A4, #716 item 4) still count the Document Server healthcheck wait at its 60s
          // deadline only, in the older deadline-only notation.
          testTimeout: 20_990_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'platform/src/**/*.ts',
        'platform/web/src/**/*.{ts,tsx}',
        'plugins/permission-tiers/*.js',
        'plugins/office-agents/*.js',
        'plugins/platform-nav/*.js',
        'plugins/knowledge-base/*.js',
        'plugins/office-hints/*.js',
        'images/dsh-user/*.mjs',
      ],
      // Exact process/browser bootstrap exemptions are registered in constraints.yaml.
      exclude: [
        'platform/src/**/*.test.ts',
        'platform/src/main.ts',
        'platform/web/src/**/*.test.{ts,tsx}',
        'platform/web/src/main.tsx',
        'plugins/**/*.test.js',
        'images/dsh-user/*.test.mjs',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        perFile: true,
        lines: minCoverage,
        branches: minCoverage,
        functions: minCoverage,
        statements: minCoverage,
      },
    },
  },
});
