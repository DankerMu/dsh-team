# Why

Trusted Docker custody decides `command.settled` with one `kill(-pgid, 0)` observation at the pnpm child's `close` event (`scripts/trusted-docker-owner.mjs` `executeOwnedCommand`). When pnpm 10.34.6 exits on a forwarded signal, its error path first runs `pidtree`'s `ps -A -o ppid,pid`; pnpm then re-raises the signal and dies, orphaning that `ps` in pnpm's own process group (reparented to PID1). If `close` fires while the orphan is still running (`R`) or not yet reaped (`Z`), the group is not absent, `settled:false` is published permanently, `status` reports `unknown` forever, `cancel` exits 1 and `logs` refuses delivery. Issue #321 reproduced this exact CI failure under controlled Linux load (owner close saw `{comm:"ps", state:"Z", ppid:1}`; ESRCH followed about 2ms later) and showed that pnpm itself waits for its script tree, so the residue is the orphaned `ps`, not an unreaped script child (diagnosis: #321 comment 6367373163). The same path applies to a real cancelled `pnpm test:docker` on the trusted host.

Separately, the Darwin `trusted-docker-audit` dispatch case writes a fresh fake `docker` executable and times its first exec under a fixture-owned 2000ms SIGKILL. macOS first exec of a newly written executable costs about 430ms and queues system-wide (K=4 concurrent: p50 ~1.6–1.8s; K=8: 73/80 killed); Node start plus dynamic import inside it takes only 15–26ms. An untimed warm-up exec removes the cost (K=8: 0/80 killed, p50 28ms).

# What Changes

- Custody settlement observes process-group absence within one bounded observation window after the child's actual `close`, accepting only a genuine `ESRCH`. A present group or an `EPERM` observation (Darwin reports `EPERM` while launchd has not yet reaped an orphaned zombie) is never absence and is observed again; at expiry a present group is unsettled and a final `EPERM` keeps today's `identity` failure. Any other error keeps its current immediate `identity` failure. This is observation of an already-exited command, not a command retry.
- A deterministic regression reproduces a group member that outlives the command's close and then exits.
- Failing custody and dispatch regressions surface sanitized distinguishing facts (terminal `command`, `interruption`, `failure`, `cleanup.state`; inner dispatch status/signal/error code/elapsed) in their assertion messages, without credentials or proxy values.
- AGENTS.md Trusted Docker verification documents the bounded post-close observation and the Darwin `EPERM` handling.
- The Darwin dispatch fixture performs one untimed warm-up exec of its own fake `docker` before the timed dispatch; the 2000ms fixture bound is unchanged.

# Capabilities

## Modified Capabilities

- `trusted-docker-verification`: command settlement waits a bounded window for genuine process-group absence.

# Impact

`scripts/trusted-docker-owner.mjs`, possibly `scripts/trusted-docker-record.mjs` (canonical group observation), `platform/test/trusted-docker-fixture.ts`, `platform/test/trusted-docker-custody.integration.test.ts`, `platform/test/trusted-docker-audit.integration.test.ts`, `AGENTS.md`. No product application, image, Compose, dependency, workflow or production deadline change. The owner runs only under trusted custody; the browser image and e2e source closures do not include `trusted-docker-owner.mjs`.

# Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: trusted custody terminal-state semantics and process-group observation)
Blast radius: a false `settled:true` would let cleanup assessment confirm while descendants still run; a too-short window keeps today's permanent `unknown`
Selected risk packs: concurrency/shared state/ordering; error handling/partial outputs; resource limits/deadlines; documentation
Evidence floor: Docker-free RED (deterministic on Linux and Darwin) and GREEN for a post-close group member; a past-expiry member and the existing denied observation stay unsettled; existing EPERM-denied and live-member negatives unchanged; repeated loaded local runs of both suites on Darwin and in a Linux container; canonical checks; exact-head trusted custody `pnpm test:docker` (the owner under change is the custody owner) plus standalone `pnpm test:deploy`, independent observation
