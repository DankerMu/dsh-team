# Platform service

Runtime contracts of the platform process: configuration, startup and shutdown, the administrator CLI and the platform image.

Moved verbatim from the root `AGENTS.md`; normative behaviour lives in the OpenSpec specs (`openspec/specs/`, `openspec/changes/`). Keep this file current in the same change as the code it describes.

## Local development

`pnpm dev` builds the web package, then uses the native Node watcher. A missing `.env` is optional: supply required configuration through the environment. When `.env` exists at launch, Node retains its own parsing and inherited-environment precedence; source/import changes still reload the application. Restart `pnpm dev` after creating an env file that was absent at launch. The foreground launcher never creates an empty file or changes `dev:bg`/production startup. `pnpm test:integration platform/test/dev-watch.integration.test.ts` exercises native watch startup/reload and unreadable-input rejection with owned nonsecret process fixtures; real source-main health still requires the configured Docker Engine.

## Configuration

- `.env.example` is the single inventory for platform inputs and explicitly namespaced Compose-only inputs. Copy it to `.env`; invalid platform values stop startup. A run that does not go through the delivered Compose (`pnpm dev`, `pnpm dev:bg`, `pnpm start`) must either delete both `DOCUMENT_SERVER_*` lines (the bundled Document Server is then unconfigured and Office unavailable) or fill both with nonempty values: the copied example carries the literal container name with an empty JWT and fails before listening, naming `DOCUMENT_SERVER_JWT_SECRET`. A stage-1 `.env` without those lines is unchanged. Host-run lifecycle development must explicitly select `published-loopback`. Unset `PLATFORM_MANAGED_CONFIG_DIR` defaults to `<dataDir>/managed-config` and resolves to an absolute path. Compose-only `DEPLOY_DOCKER_GID` is not a platform runtime field; configuration inventory checks must account for both real consumers without unused fields or blanket exclusions.

- `pnpm lint:config` (included in `pnpm lint` / `pnpm check`) matches three consumer classes to active assignments in `.env.example`, rejecting both undocumented and unconsumed names: literal platform reads of `PLATFORM_*`; Compose-only `DEPLOY_*` interpolation; and `DOCUMENT_SERVER_*`, consumed by literal platform reads and Compose interpolation together (`DOCUMENT_SERVER_CONTAINER_NAME` counts only as a platform read because Compose writes the name literally; `DOCUMENT_SERVER_JWT_SECRET` counts on both sides). Comments, error strings and escaped dollars are not consumers; unsupported dynamic environment reads fail rather than disappearing. Compose flow collections, block scalars and multiline quotes fail explicitly: use the delivered block-mapping/single-line scalar form rather than obtaining an incomplete inventory. Guardrails mutate only their disposable copy.

- `PLATFORM_HOST` accepts bare IPv4/IPv6 or an ASCII DNS hostname (optional trailing dot), not a URL, host:port or blank value. Validation names the variable without echoing input before database/listener side effects. DNS resolution and actual bind availability are still runtime concerns; subnet validation remains at startup against persisted capacity.

## Shutdown

- Direct application close and main signals fence start admission and gateway-owned HTTP/WebSocket resources before waiting for unrelated lifecycle work. SQLite still closes only after actual service work and original owner queue tails settle.

- Application shutdown also retires accepted TCP connections that have not produced a parsed HTTP request or upgrade, including incomplete headers and accepts racing the shutdown fence. Complete headers transfer ownership away from this pre-request set before handlers run; admitted partial bodies/responses remain under normal HTTP settlement, and upgrades retain gateway ownership. Do not use blanket force-close or process exit to handle cold sockets. `pnpm test:integration platform/test/http-shutdown.integration.test.ts` proves cold/incomplete-header/late-accept retirement and real registration body/response preservation.

- Admitted HTTP responses also retain per-connection ownership through finish or cancellation. During shutdown, only the last admitted response ends that keep-alive transport; already-parsed pipelined responses and buffered bytes must finish first. The preClose drain precedes native server close because Node24 can otherwise classify an ended-but-buffered response as idle and destroy it. The same shutdown suite proves complete keep-alive registration, ordered pipelines, cancellation and an eight-MiB backpressured response. No new inactivity deadline, blanket destruction or lifecycle/database ordering change is introduced.

## Administrator deployment command

Run `pnpm --silent cli admin create <email>` from source, or `node platform/dist/cli.js admin create <email>` after building. The source wrapper requires `--silent`: plain `pnpm cli` prints its lifecycle command banner before Node validates arguments and can disclose rejected password arguments. Never supply a password in arguments; silence prevents wrapper disclosure, not shell-history or process-argument exposure. Export the existing configuration, including required `PLATFORM_PUBLIC_URL` and the intended `PLATFORM_DATA_DIR`; the CLI does not load `.env` itself. Interactive input **and** output are mandatory, and password arguments/environment input are not supported.

Standalone `node platform/dist/cli.js --help` (or `pnpm --silent cli --help` from source) succeeds without configuration or a terminal and creates no data. Only that exact single argument is help; extra or misplaced arguments still fail without echoing credentials.

New accounts receive an active administrator identity after two matching hidden password entries. Existing accounts offer password reset with default **no**: promotion otherwise preserves password, status (including disabled), identity, creation time, and sessions. An existing administrator without reset is a no-op. Reset revokes all target sessions and records the actual promotion/reset events atomically; it does not issue a CLI session or enable disabled accounts. A concurrent target change rejects the operation; rerun rather than overwrite the newer account.

The command restores terminal mode and releases its database/listeners on completion or cancellation. Success is reported only after account/session/audit commit. Administrator web-page availability remains owned by the later administrator UI issue.

## Platform image artifact

`platform/Dockerfile` uses the repository root as build context; its adjacent allowlist excludes local dependencies, credentials and verification evidence. Builder and runtime share Node24.13.1/bookworm. The pinned build-only node-gyp11.5.0 explicitly compiles better-sqlite3 in the deployed production closure; shipped prebuilds are removed so runtime cannot select them instead.

The image works from `/app`: compiled CLI/server at `platform/dist`, browser assets at `platform/web/dist`, default seccomp at `images/seccomp/dsh-user.json`, writable default data at `/app/data`. Application files remain root-owned and the process runs as `node` (uid1000). Public URL, persistent mounts and Docker socket access remain deployment configuration; this image artifact test does not claim a full Compose deployment.

Run `pnpm test:docker platform/test/platform-image.docker.test.ts` on giap-vps for the narrow artifact check. It builds an owned image, runs actual CLI help without source mounts, verifies the default native binding through migrations/write/reopen, checks the existing static resolver and default seccomp bytes, and cleans its owned containers/image.

Platform-image Docker calls use the canonical verification client environment: fixed PATH, launcher-owned `DSH_TEAM_BROWSER_DOCKER_CONFIG` as Docker's private configuration, and only the optional uppercase proxy fields. Missing or empty launcher configuration fails before Docker; caller credentials, remote Engine selectors and ambient Docker configuration are not inherited. The original30s operation/600s build deadlines,16MiB raw-output contract and exact-owned cleanup remain. Issue#270 explicitly adopts the canonical helper's SIGKILL timeout termination instead of the former implicit SIGTERM.

## Evidence required: Administrator CLI

Verify with: Actual Node and pinned silent-pnpm processes with hidden-input PTYs. Command: `pnpm test:cli`.

direct/silent-wrapper argument rejection without disclosure/data, hidden input/restored echo, atomic account/audit/session outcomes and HTTP admin login

## Evidence required: Platform image

Verify with: Real multistage platform image without source mounts. Command: `pnpm test:docker`.

Successful compiled CLI help; non-root writable data and read-only app; actual source-built SQLite binding, migrations and row reopen; static resolver/default seccomp; owned cleanup
