Change surface: `scripts/verify-browser-runtime.mjs` exports its Chrome version as one constant, replacing the retyped `156.0.8078.80` literals; importing it must not run its main path. New `scripts/vps-lane.mjs` (subcommands `run` and `post`) behind the package scripts `lane:vps` and `lane:vps:post`; remote helpers it uploads (prepare, unit runner, custody observer, host observer) under `scripts/`; `scripts/README.md`; one AGENTS.md Daily-commands line.

Must preserve:

- custody (`scripts/trusted-docker-run.mjs`, `pnpm verify:docker`), its status and logs contract, and its sole ownership of cleanup;
- `verify-docker-evidence` and every CI workflow, unchanged;
- the lane never deletes a remote resource, and never uses admin bypass or `--no-verify`;
- secrets are never read into output: the docker-proxy fields are loaded on the host and never printed.
- the `DSH_TEAM_VERIFICATION_IMAGES` contract (`scripts/README.md` § DSH browser runtime, read by `scripts/verification-image.mjs`, passed through at `scripts/trusted-docker-owner.mjs:44`): an owned 0600 `images.json` with `roles.user|platform|browser`, each with an absolute `layout`, `manifestDigest` and `configId`. Custody starts with that variable set, or it would silently build natively and the uploaded images would go untested;
- the evidence gate's acceptance rule (`platform/test/docker-evidence.ts:56-57`): only the newest `dsh-team/docker` status counts, with state `success` and `creator.login === 'DankerMu'`;
- `scripts/ci-vps-owner.mjs` stays untouched.

Must add/change:

- the run lane, in order: branch at sha; three images built from `git archive <sha>` with a run label; upload with sha256; remote hash-verified prepare (git bundle checkout at sha, OCI layouts, `images.json`); install+build in a user unit; custody start with one observing SSH; status polling until a non-running state; stdout and its sha256; `test:deploy` in a user unit; before/after host fence;
- the browser-image build context derived from `images/browser-verification/Dockerfile`'s `COPY --from=browser-runtime` names, a world-readable check on build inputs, and a file-mode check on the saved layers (the platform migrations and catalog, the browser probe);
- toolchain pins:
  - Node and pnpm from `.tool-versions`;
  - Chrome `156.0.8078.80` from its existing pin in `scripts/verify-browser-runtime.mjs`, shared rather than retyped;
  - hurl from `HURL_VERSION` in `.github/workflows/ci.yml`;
  - remote layout under the SSH session's `$HOME`, at `T=~/.local/share/dsh-team/toolchain`:
    - Node: `T/node-v<node>-linux-x64/bin`;
    - pnpm: `T/pnpm-<pnpm>/node_modules/.bin`;
    - hurl: `T/hurl-<hurl>/usr/bin`;
    - Chrome: `T/chrome-<chrome>/chrome-headless-shell-linux64/chrome-headless-shell`;
  - each of these is checked to exist before upload;
- argument grammar: `<label>` matches `^[a-z0-9][a-z0-9-]{0,39}$`, and `<sha>` is 40 lowercase hex characters, both checked before any local write or remote command;
- per-run remote staging `~/.local/share/dsh-team/verify/<label>-<random>`, so two lanes never collide;
- a label whose local run directory holds a live or completed run is refused; a failed run clears its own directory;
- the post command. Its pass criteria, the gh identity and the body sections are all checked before any write. Writes then run in order: status POST, body edit, failed-run reruns. A failure after the status POST exits non-zero, naming the completed steps. Rerunning post completes what is left: it posts exactly one more status, since the gate reads only the newest. The body replacement is idempotent.

Governing invariant: `dsh-team/docker` success is posted only for a head whose summary records custody `passed` with cleanup `confirmed`, `test:deploy` exit 0, and a clean host fence: every registered target absent, no owned leftovers, daemon PID and docker0 unchanged, foreign containers unchanged.

Sibling surfaces:

- `verify-docker-evidence` reads the same status context;
- `platform/test/README.md` and `scripts/README.md` describe the trusted lane;
- `.gitignore` already covers `.run/`;
- shared sources to reuse, never duplicate: `scripts/docker-proxy-environment.mjs` (host proxy fields), the Chrome pin in `scripts/verify-browser-runtime.mjs`, and `HURL_VERSION` in `.github/workflows/ci.yml`. `scripts/ci-vps-owner.mjs` is a reference only and is not changed;
- check `constraints.yaml` duplicate-code limits.

Seams under test: the two package scripts, run as child processes with fake `ssh`/`scp`/`docker`/`gh` executables first on `PATH`; real `git` runs on a temporary repository.

- The fake `ssh` runs the remote command locally under a temporary remote HOME, with fake `docker`/`systemctl`/`systemd-run`/`ip`/`sg`/`pnpm`. The uploaded helpers' hash check, `images.json` creation and fence comparison therefore really execute.
- The fakes record argv and answer scripted outputs.

Required evidence:

- branch not at sha -> refusal, no build;
- image build fails -> exit non-zero, and this run's own labelled images are removed and its build directory cleared, so the next run starts;
- remote hash mismatch -> refusal, no install;
- status query fails transiently -> retried, still a pass when custody later reports passed;
- status unreachable past its bound -> UNKNOWN, exit non-zero, no remote delete command issued;
- custody `failed`, cleanup unconfirmed, `test:deploy` exit != 0, any present target, owned leftover, changed daemon/docker0 or foreign container -> post refuses, naming the failed criterion, with no status posted and no body edit;
- PR head != summary head -> post refuses;
- full pass -> exactly one status POST on the head, a body whose Runtime evidence is replaced and whose other sections are byte-identical, and reruns only for failed runs on that head;
- no fake records a secret value or an absolute user path from the local machine.
- the browser Dockerfile names a file the context lacks, a build input is not world-readable, or a saved layer has the wrong mode -> refusal, no upload;
- a missing `.tool-versions` pin, or a missing remote node, pnpm, hurl or Chrome directory -> refusal naming the item, before upload or custody start;
- an uploaded image tar altered after hashing -> the remote prepare refuses, `summary.json` records prepare failed, and no install runs;
- `images.json` is created mode 0600 with the three roles, and the custody start command carries `DSH_TEAM_VERIFICATION_IMAGES` pointing at it;
- custody reports `unknown`, reports a `head` other than the lane sha, or the fetched stdout sha256 differs from the status `output.sha256` -> recorded as not a pass, with no cancel or delete issued;
- the before/after host snapshots differ (daemon PID, docker0, a foreign container, an owned leftover or a present registered target) -> `summary.json` records the fence as failed, naming the field;
- the label `../x`, or a 7-hex or uppercase sha -> refusal before any local write or remote command;
- a label whose run directory holds a completed or live run -> refusal; after a failed run cleared its directory -> the run starts;
- the gh identity is not the gate's accepted login -> post refuses before any write;
- the PR body lacks `## Runtime evidence` or `## Risk` -> post refuses, no status and no edit;
- the body edit fails after the status POST -> exit non-zero, naming "status posted, body not updated";
- post rerun after that partial failure -> one more status POST, the body updated and failed runs rerun; a second full rerun changes nothing in the body;

Non-goals: acceptance-environment redeploy; custody, CI or evidence-gate changes; `pnpm test:model`; making the host name configurable.

Review focus:

- pass criteria cannot be satisfied by a partial or stale summary;
- no remote delete path exists;
- the proxy secret never reaches argv, logs or summary;
- transport failure is never read as a verdict;
- duplication with the existing ci-vps and docker-proxy modules.
