## Why

#769: the trusted parent session's exact-head VPS verification has only ever existed as session-scratchpad scripts.
That flow builds the linux/amd64 images locally, uploads them to giap-vps, runs custody `pnpm test:docker` and then `pnpm test:deploy` with a host fence, posts `dsh-team/docker`, and writes the PR's Runtime evidence.
The scripts vanish with the session, which breaks AGENTS.md "if a workflow is missing, add a script". This session also showed two failure modes that the scripts handled badly:

- a failed image build left its labelled images and build directory behind, so a retry stopped at "out exists";
- a local network drop once ended the lane while custody kept running.

The repository has only the VPS side (`pnpm verify:docker`, the custody owner). `scripts/ci-vps-*.mjs` serve the CI model lane and are unrelated.

## What Changes

- **`pnpm lane:vps <label> <sha> <branch>`** runs the parent-side exact-head lane end to end. It writes `summary.json`, a human summary and evidence files to the gitignored `.run/vps-lane/<label>/`.
- **`pnpm lane:vps:post <pr> <label> [--note <text>]`** checks the evidence and publishes it. It refuses unless the summary is a full pass on the PR's current head. It then:
  - posts the `dsh-team/docker` success status on that head;
  - replaces the PR body's `## Runtime evidence` section, up to `## Risk`;
  - reruns that head's failed CI runs.
- **No user-specific paths:**
  - repository root from git;
  - outputs under `.run/`;
  - remote home from the SSH session;
  - remote toolchain paths derived from the repository's existing pins, failing loudly when absent.
    `giap-vps` stays the single named host (AGENTS.md names it).
- **Docs:** a `scripts/README.md` section covering usage, evidence files, pass criteria and boundaries. AGENTS.md Daily commands gains one line.

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: standard (override: not in the level vocabulary; expanded triggers present: new CLI entry, file IO, publishes a GitHub status)
Blast radius: a false dsh-team/docker success would let a PR merge without real Docker evidence; a lane that deletes remote resources would touch the shared verification host
Selected risk packs: Public API / CLI / script entry; Config; File IO; Auth / permissions / secrets; Concurrency / shared state; Error handling / partial outputs; Documentation
Evidence floor: platform/test/vps-lane.integration.test.ts red then green; lint:shell, lint:agents, check:fast, test:integration exit 0; one real lane run on this PR's exact head plus lane:vps:post writing this PR's Runtime evidence
```

## Divergences from issue #769

Recorded after implementation, before review:

1. Run directory lifetime: a run that fails before its first remote write (pin, toolchain, build) removes its run directory, so the label can be reused. From the remote staging `mkdir` on, the directory and `summary.json` stay, and any existing run directory refuses the label, including a run that failed after upload; such a run needs a new label.
2. The custody observer runs as `systemd-run --user --collect` without `RemainAfterExit`, so no `systemctl stop` is needed. Not yet exercised on the real host.
3. When custody does not reach a terminal state (unknown or unreachable), `test:deploy` and the after-fence are skipped and the run is not a pass.
4. Retry classification: unit-state, evidence reads and fence retry only on ssh exit 255 or timeout; any other non-zero exit is a remote answer, recorded without retry. Custody status retries on every failure.
5. `DSH_TEAM_LANE_INTERVAL_MS` (tests only) replaces the wait intervals; the 120-attempt bound is unchanged.
6. Pin sources: Node, pnpm and hurl are read from `<sha>` with `git show`; Chrome is imported from the lane checkout's `scripts/verify-browser-runtime.mjs`.
7. A post rerun reruns only runs whose conclusion is `failure`.
8. The custody status field is `output.stdout.sha256` (the design said `output.sha256`).
9. Dropped from the reference scripts: the private steps `TMPDIR`, the uid==1000 and arch assertions, `child.json` and the owner-live `/proc` check.
10. Tests spawn `node scripts/vps-lane.mjs run|post` from the package-script string instead of through pnpm, so the git root is the temp repository rather than the real one.
