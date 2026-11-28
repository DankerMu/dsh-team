## ADDED Requirements

### Requirement: The parent-side exact-head lane is a repository command whose evidence gates the Docker status

The trusted parent session SHALL run exact-head VPS verification through `pnpm lane:vps <label> <sha> <branch>`, which builds, uploads, prepares, runs custody `pnpm test:docker` and then `pnpm test:deploy` with a before/after host fence, and records the result in `.run/vps-lane/<label>/summary.json`.
`pnpm lane:vps:post <pr> <label>` SHALL post the `dsh-team/docker` success status only when that summary records, for the PR's current head, custody `passed` with cleanup `confirmed`, `test:deploy` exit 0, every registered target absent, no owned leftover, unchanged daemon PID and docker0, and unchanged foreign containers. It SHALL refuse otherwise, naming the failed criterion. The lane SHALL never delete a remote resource, and SHALL never treat an SSH or transport failure as a verdict.

#### Scenario: A full pass is posted on the exact head

- **WHEN** the lane passed every criterion on head H and PR P's head is H
- **THEN** `lane:vps:post` posts exactly one `dsh-team/docker` success status on H, replaces only the `## Runtime evidence` section of P's body, and reruns only H's failed CI runs

#### Scenario: A partial or stale summary is refused

- **WHEN** any criterion is missing or failed, or P's head differs from the summary's head
- **THEN** `lane:vps:post` exits non-zero naming the criterion or the head mismatch, posts no status and leaves the body unchanged

#### Scenario: A transport failure is not a verdict

- **WHEN** a custody status query fails over SSH
- **THEN** the lane retries within its bound, and past the bound it reports the custody state as unknown, exits non-zero and issues no remote delete

#### Scenario: A failed build leaves nothing behind

- **WHEN** an image build fails
- **THEN** the lane exits non-zero, removes the images labelled with its own run, clears its build directory, and the next run with the same label can start
