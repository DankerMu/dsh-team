# Proposal

## Why

仓库现在只有工程骨架和一个 `/healthz`。阶段 1 要交付第一条真实可用的链路：两个邮箱账号注册登录后各自进入自己的实例，用内网模型完成带工具调用的任务，文件和 Session 互不可见，实例停止或重建后数据恢复，管理员能禁用账号。隔离测试从这个阶段开始写，之后每个阶段都在它上面叠加。

依据：`docs/IMPLEMENTATION_PLAN.md` 第 4、5 节（任务包 1.0–1.17），`docs/REQUIREMENTS_BASELINE.md`（F1–F20、F43–F45、F21–F24 的一部分，D1–D23）。

## What Changes

- 新增账号：邮箱加密码自助注册、登录、登出、改密码；平台会话 7 天滑动续期；首个管理员由部署命令创建。
- 新增实例生命周期：每用户一个容器、两个持久卷、唯一主机名、CPU 和内存上限、同时运行数上限；登录时按需启动，空闲后停止；停止和重建后数据恢复；管理员可重启实例和重置实例配置。
- 新增网关：按平台会话把 HTTP、WebSocket、上传下载转发到该用户的实例；DSH 的启动令牌和 cookie 只留在平台服务端。
- 新增实例隔离：用户容器不发布宿主端口、不挂 Docker socket、互相网络不通；附带一组通过接口、长连接、路径、Shell、网络尝试越界的自动化测试。
- 新增受管覆盖层：平台为每个实例生成只读的 DSH 配置，统一模型、默认模型、默认权限档、界面语言，并去掉联网工具；用户改不了。
- 新增管理后台：账号（禁用、启用、重置密码）、实例（状态、重启、重置实例配置）、模型配置、运行参数、审计日志。
- 新增审计日志：登录、注册、管理操作、实例生命周期事件；不含密码、密钥、对话内容。
- 新增用户镜像：DSH 发行版、Python、bubblewrap、预置的 DSH 配置目录；附 amd64 上验证过的容器安全设置。
- 新增权限三档：人工批准、Auto、Yolo，默认 Yolo。
- 新增两个办公 Agent（综合办公、公文写作），用来验证预设机制。
- 新增部署骨架：平台镜像和 compose 文件，一条命令起全套。
- 任务包 1.3 的工程部分已由 PR #1 完成，本 change 只补 SQLite 表结构和迁移。

没有破坏性变更：仓库里还没有任何对外行为。

## Capabilities

### New Capabilities

- `account-auth`: 注册、登录、登出、改密码、平台会话、首个管理员的创建。
- `instance-lifecycle`: 实例的创建、按需启动、就绪判定、空闲停止、数据持久、资源上限、重启和重置实例配置。
- `gateway-routing`: 已登录用户的请求到其实例的转发，DSH 凭据的服务端托管，等待页，禁用后的断连。
- `instance-isolation`: 用户之间以及用户与平台之间的隔离边界，和验证它的测试。
- `managed-config`: 受管覆盖层的内容和生效方式，模型配置，默认权限档，界面语言。
- `admin-console`: 管理后台的账号、实例、模型配置、运行参数、审计页面及其接口。
- `audit-log`: 审计事件的范围、内容限制和查询。
- `user-image`: 用户镜像的内容、启动方式和容器安全设置。
- `permission-tiers`: 三档权限的定义和各档的可观察行为。
- `office-agents`: 办公 Agent 的预设机制，本阶段交付综合办公和公文写作两个。
- `deployment`: 平台镜像、compose 文件和启动步骤。

### Modified Capabilities

无。`openspec/specs/` 目前为空。

## Impact

- 代码：`platform/src/` 新增 `db`、`auth`、`audit`、`orchestrator`、`gateway`、`managed-config`、`admin` 七个模块；新增 `platform/web/`（登录、注册、等待页、管理后台）；新增 `images/dsh-user/`、`images/seccomp/`、`plugins/office-agents/`、`deploy/`。
- 接口：平台 HTTP 接口从一个路由增加到账号、管理、网关三组；`schemas/openapi.json` 随之重新生成。
- 依赖：新增 better-sqlite3（原生模块）、React 18 和 Vite。Docker Engine API 和 WebSocket 转发用 Node 自带模块实现，不引入客户端库。
- 外部系统：平台进程需要访问宿主机的 Docker socket；开发期用 dmxapi 的 `deepseek-v4.1-flash`，密钥只从环境变量 `DMXAPI_KEY` 读取。
- 关键路径：`platform/src/orchestrator/`、`images/seccomp/`、`images/dsh-user/` 的改动需要人工逐行审查（`AGENTS.md`）。
- 验证主机：任务包 1.0 的探针，以及本阶段所有需要 Docker 的构建、测试和整套部署，都在项目方的 VPS 上执行（D16）。

## Issue #4 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: expanded (agree: production image and critical path)
- Blast radius: all later instance builds and sandbox probes.
- Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Auth / permissions / secrets; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes.
- Evidence floor: giap-vps image build, exact DSH version, uid/directories/environment/tool checks, nonexistent-version build rejection, resource cleanup, and `pnpm check`.
- Shared fixture: each issue reviews its own task slice; archive this change only after the whole epic is complete.

## Issue #5 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: expanded (agree: executable Docker security probe and resource lifecycle)
- Blast radius: false sandbox success would misconfigure every future instance; cleanup must not affect unrelated host resources.
- Selected risk packs: all except Legacy compatibility / examples, as mapped in tasks.md.
- Evidence floor: actual pinned DSH tool workspace/state outcomes per level, all-failure exit, interruption cleanup, no owned resource leaks, and `pnpm check`.

## Issue #6 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: expanded (agree: shipped seccomp policy is a critical production boundary)
- Blast radius: every user instance's sandbox; inaccurate host conclusions could grant unnecessary privileges.
- Selected risk packs: Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes.
- Evidence floor: fresh giap-vps probe, separate real-tool run with the exact committed profile, byte/semantic provenance comparison, denied state write, cleanup, and `pnpm check`.

## Issue #7 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: compact (override: executable Docker/browser probe handles launch credentials, remote protocols and resource lifecycle)
- Blast radius: a false idle signal could stop live tasks in #59; leaked probe credentials or resources affect the verification host.
- Selected risk packs: all except Legacy compatibility / examples, as mapped in tasks.md.
- Evidence floor: actual Web UI request paths at five phases, HTTP/WS/file running-versus-idle observations over three real task cycles, redacted output, cleanup, and `pnpm check`.

## Issue #8 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: compact (override: real launch credentials, browser automation, state-file writes, VPS resource lifecycle and a repo-owned client plugin trigger expanded review)
- Blast radius: incorrect first-run conclusions would propagate into image preseed (#27), managed configuration (#29+) and first-entry behavior (#57).
- Selected risk packs: all except Legacy compatibility / examples, as mapped in tasks.md.
- Evidence floor: fresh-instance baseline plus overlay/file/CLI method matrix and the approved plugin-composition candidate, real non-loopback Chinese/no-notice/editable-composer screenshots, reload and model-selection preservation, exact working artifacts, resource cleanup and `pnpm check`.
- Project-party decision (2026-10-04): user selected “扩大到插件或镜像定制”; expand #8 to a minimal repo-owned client plugin and supported roster composition without weakening F15/F44 or modifying DSH source. Existing image preseed (#27) and managed-config generation (#29) remain separate; the probe must load the same deliverable plugin bytes.

## Issue #9 fixture

- Issue type: feature
- Fixture level: expanded (agree with upstream: persisted database, atomic migrations and native dependency)
- Blast radius: later account/settings/audit storage relies on foreign keys, private files and all-or-nothing migrations.
- Selected risk packs: all except Legacy compatibility / examples; precise scope and evidence are mapped under tasks 4.1–4.2.
- Evidence floor: parent-observed RED/GREEN, real in-memory SQLite constraint and rollback cases, temporary file mode/WAL/reopen integration, direct public-API smoke and `pnpm check`.
- Boundary: no business migration files or HTTP/startup database wiring; tasks 4.3–4.6 remain separate. The task 4.5 `integration_tests_real_db` deferral removal stays with #12.

## Issue #10 fixture

- Feature; expanded fixture for task4.3 persistence/schema risk. Scope, must-preserve behavior, required evidence and exclusions are specified in the Issue #10 design boundary and tasks risk map, including necessary compiled SQL asset delivery.

## Issue #11 fixture

- Feature; expanded fixture for task4.4 persisted settings validation. The Issue #11 design boundary and tasks risk map define units, partial updates, read defaults and required real-SQLite evidence; no route or startup change.

## Issue #12 fixture

- Feature; expanded task4.5 startup/lifetime integration, with the issue's multi-path width exception. The Issue #12 design boundary and tasks map cover existing DB composition, all buildApp callers, isolated built e2e and retiring the real-database deferral.

## Issue #13 fixture

- Feature; expanded task4.6 configuration boundary for future authority, cookie and proxy consumers. The Issue #13 design boundary and risk map define required origin parsing, explicit optional settings and fail-fast runtime evidence; no request-handling policy is activated.

## Issue #14 fixture

- Feature; expanded task5.1 persisted audit writer and credential/content exclusion boundary. Agree with upstream. The Issue #14 design boundary and tasks risk map define closed events, detail projection and real SQLite evidence; query, logging and business callers remain separate.

## Issue #15 fixture

- Feature; expanded task5.2 persisted audit read/filter/pagination boundary (agree with upstream). The Issue #15 design and risk map define deterministic ordering, filter composition and public-API runtime proof; no HTTP authorization or UI is introduced.

## Issue #16 fixture

- Feature; expanded task5.3 shared Fastify logging and secret exclusion boundary (agree with upstream). Issue #16 design/tasks distinguish default serializer omission from exercised redaction, preserving HTTP values and existing logger/database behavior.

## Issue #17 fixture

- Feature; expanded tasks6.1–6.2 authentication and persisted-session primitives (agree with upstream merged-tasks width exception). Issue #17 design/risk map defines bounded password derivation, token-at-rest protection and clock-controlled expiry; no HTTP surface. Flag for human review: platform/AGENTS.md now permits auth unit tests to use isolated in-memory SQLite through db/index.ts, retaining file-backed databases as integration-only.

## Issue #18 fixture

- Feature; expanded task6.3 public registration, credentials and atomic persisted state (agree with upstream). Issue #18 design/risk map includes required app wiring and generated HTTP contract; login/logout, proxy trust, Origin enforcement and UI remain later slices.

## Issue #19 fixture

- Feature; expanded task6.4 login/logout and authenticated session recognition (agree with upstream). Issue #19 design/risk map reuses registration credentials, cookies and canonical session lifetime; no new production identity-query endpoint, gateway or UI.

## Issue #20 fixture

- Feature; expanded task6.5 (agree with upstream): source attribution across a configured proxy trust boundary and persisted auth audits. Wrong attribution enables spoofed audit identities and future rate-limit keys. Preserve HTTP/session/password contracts; risk packs and evidence are mapped below task6.5. No global proxy mode or throttling in this slice.

## Issue #21 fixture

- Feature; expanded task6.6 (agree with upstream): per-email/source in-memory login-failure state, asynchronous verification ordering and public429 contract. Reuse canonical source attribution and existing login audits; no global account lockout, persistence, new configuration or rate-limit dependency.

## Issue #22 fixture

- Feature; expanded task6.7 (agree with upstream): authenticated password rotation, user-wide session revocation/reissue and atomic audit persistence across asynchronous crypto. Preserve failure state and concurrent revocation; reuse session/password/cookie/source policies. Origin, administrator reset and gateway disconnection remain separate DAG slices.

## Issue #23 fixture

- Feature; expanded task6.8 (agree with upstream): shared Origin/JSON guard across state-changing platform HTTP APIs and an atomic caller/contract cutover. Reject before authentication, parsing or persisted/in-memory effects; preserve safe requests and non-platform traffic. WebSocket upgrade enforcement remains the gateway slice.

## Issue #24 fixture

- Feature; expanded task6.9 (agree with upstream): interactive administrator bootstrap/promotion/reset command, terminal secrecy and direct atomic account/audit persistence. Reuse auth identity/password/session policies; no web privilege-granting endpoint or administrator UI implementation.

## Issue #25 fixture

- Expanded task7.1 (agree with upstream): real Docker build/version acceptance and invocation-owned cleanup on giap-vps, plus a read-only CI evidence trust gate. The user explicitly chose trusted-session execution of reviewed exact commits instead of giving public PRs shared-VPS Docker access. No image change, persistent self-hosted runner, GitHub VPS credential, remote framework or later image capability.

## Issue #26 fixture

- Expanded task7.2 (agree with upstream): add distro Python3/python-docx to the critical user image and prove non-root DOCX creation/readback with networking disabled. Reuse the canonical Docker fixture and trusted reviewed-SHA admission; no pip manager, office bundle, profile seed, web startup, sandbox-policy or platform behavior change.

## Issue #27 fixture

- Expanded task7.3 (agree with upstream): release-initialized Web profile and canonical locale-plugin delivery, whole-tree seed snapshot, real Docker empty-volume copy-up and immutable seed boundary. Migrate all image builders to the same narrow named plugin context; no duplicated artifact, probe Session seed, office bundle, Web startup or managed-overlay implementation.

## Issue #28 fixture

- Test; expanded task7.4 (agree with upstream): qualify real Web startup under the shipped seccomp policy, actual process identity/environment, separate state/work mounts and unauthenticated HTTP rejection. False success would approve an unusable or insecure instance image.
- Selected risk packs: all except Legacy compatibility / examples; concrete evidence and exclusions below task7.4. Preserve all three existing Docker cases and ownership-checked cleanup.
- Characterization: existing image may already pass; qualify the new verifier with wrong observations, never manufacture a production defect for RED. Parent alone executes agent-reviewed exact commits on giap-vps, publishes sanitized owner evidence and waits for normal CI.
- No upstream DSH, seccomp policy, office bundle, model service, orchestrator or managed-config implementation changes. Critical-path human review remains required and is deferred to Epic completion by the user's explicit decision.

## Issue #29 fixture

- Feature; expanded task8.1 (agree with upstream): a pure production overlay generator controls provider/model identity, preset tools and credential references. No file operations in this slice; parsing/serialization and policy completeness still warrant expanded review.
- Selected risk packs and evidence below task8.1. Preserve canonical locale-plugin composition, every non-network preset plugin and metadata, explicit model order/context-window omission, and existing module boundaries.
- Inputs include explicit public model settings, an already-resolved DSH permission configuration, and caller-supplied trusted composition data. Platform-tier mapping remains task16.1–16.2; canonical artifact loading and runtime wiring remain consumers, not hidden module-initialization IO or duplicated plugin YAML.
- Output is one JSON patch-list document accepted by the released YAML dialect. Pure unit RED/GREEN plus released-parser/composer smoke is required; Web/UI/managed-precedence proof remains task8.4.

## Issue #30 fixture

- Feature; expanded task8.2 (agree with upstream): atomic filesystem publication, user-ID path boundary, concurrent writes, read permissions and failure cleanup; add one configured overlay directory without changing existing runtime behavior.
- Selected risk packs and concrete evidence below task8.2. Preserve pure generation, config validation, typed consumers, previous complete files and unrelated users/files.
- Evidence floor: staged semantic RED/GREEN; real temporary-directory concurrency, partial-write/rename failure and symlink-target preservation; source/dist public-API smoke, `pnpm check`, strict OpenSpec, reviewed exact-head Docker baseline and normal CI.
- Trust boundary: administrator-owned directory/ancestors, no hostile parent replacement claim. Atomic rename guarantees visibility, not power-loss durability or live single-file-bind-mount propagation. No container wiring or model-policy change.

## Issue #31 fixture

- Feature; expanded task8.3 (agree with upstream): fail-closed model readiness changes the public generator result and credential-presence contract. No filesystem or container changes; retain pure generation and all configured overlay semantics.
- Selected risk packs/evidence below task8.3. Actual key availability is explicit metadata, not inferred from an environment-variable name and never resolved from process.env inside the generator.
- Clean cutover to a discriminated configured/unconfigured result; migrate every existing generator caller/test. Missing ordinary configuration returns no document, not an empty overlay, exception or fallback provider.
- Evidence floor: four independent missing-field semantic RED cases, fully configured preservation, source/dist public-API branch smoke, `pnpm check`, strict OpenSpec, reviewed exact-head Docker baseline and normal CI.

## Issue #32 fixture

- Feature/characterization; expanded task8.4: qualify managed configuration against the running released DSH after persisted employee overrides, and deliver the reusable complete-composition/canonical-artifact adapter assigned by task8.1. Keep production orchestration/settings APIs and permission-tier mapping out of scope.
- Reuse installed `0.2.0-rc.2` parser/composer inside the user image, the pure generator/atomic writer, the existing label-owned Docker lifecycle, and import-safe browser/CDP oracles. No second parser, preset roster, plugin policy or container owner.
- Evidence floor: adapter boundary RED/GREEN and malformed/partial-input rejection; exact-head real start/edit/recompose/recreate/readback; a disposable no-managed-policy negative control; effective resolver context windows, independent complete preset/tool inventory, trusted canonical patch tamper resistance, actual non-loopback English-browser UI/reload and cleanup; root checks, strict OpenSpec and CI.
- A size exemption, if necessary for the atomic runtime path and its failure qualification, must be justified in the PR; no silent removal of the task8.4 addendum to meet a line count.

## Issue #33 fixture

- Test/characterization; expanded task8.5 (agree with upstream): actual released Session execution against an unavailable managed provider must fail visibly without leaking a request to employee-configured alternatives.
- Reuse the managed generator/writer/composition adapter, owned Docker lifecycle and existing browser/RPC primitives. Preserve all five existing Docker cases and task8.4 assertions.
- Selected risk packs/evidence appear below task8.5; no new production retry/fallback policy, model administration API, orchestration or DSH source changes.
- Evidence floor: one real submitted message reaches a terminal model-connection failure in its actual Session; a demonstrably reachable test-owned alternate endpoint receives zero model requests during that attempt; visible error screenshot and retained sanitized Session/recorder evidence; complete exact-head Docker suite, cleanup, root checks, strict OpenSpec and CI.

## Issue #34 fixture

- Feature; expanded task9.1 (agree with upstream): introduce the platform's Unix-socket Docker Engine client, an exported transport/parser boundary on a critical path.
- Preserve existing config, API, authentication and all six Docker cases. Socket configuration is explicit; no eager daemon connection at platform startup.
- Evidence floor: injected-transport JSON/log/error tests, real local Unix HTTP smoke and three read-only giap-vps cases (version, nonexistent container404, nonexistent socket path), root checks, strict OpenSpec, reviewed exact-head Docker suite and CI.
- No container lifecycle commands, retries, SDK dependency, remote TCP transport, audit events or orchestration wiring in this slice. Critical-path human line review remains required and deferred to Epic completion by the user's instruction.

## Issue #35 fixture

- Feature; expanded task9.2, agree with upstream: create/reuse two persistent Docker volumes per user through the existing client. Blast radius: persistent user data and ownership isolation.
- Preserve canonical volume names, `dsh-team.user` ownership, existing Unix transport and all nine Docker cases; no container, network, DB or gateway changes.
- Selected risk packs and evidence map below task9.2. Evidence floor: public API behavioral tests of reuse/ownership/partial failure; trusted-host same-user repeat and two-user four-volume acceptance; root checks, strict OpenSpec, exact-head full Docker suite and CI.
- Human white-box review of orchestrator remains required and deferred to Epic completion under the user's instruction.

## Issue #36 fixture

- Feature; expanded task9.3, agree with upstream: real container creation/start bridges owned volumes, canonical managed composition, config, persistent instance index and audit. Blast radius: host socket privileges, employee data and injected credentials.
- Preserve all ten Docker cases, existing auth/health/config behavior, single managed overlay and released DSH source; reuse public Docker/volume/managed-config/db/audit APIs.
- Evidence floor: behavioral RED/GREEN at public operation boundaries; actual SQLite/audit observations; trusted pinned-host real exported startup operation inspect/recreate/endpoint/audit proof; full exact-head Docker suite, root checks, strict OpenSpec and CI.
- Do not implement model administration, permission-tier mapping, readiness/cookie exchange, resource caps, lifecycle locks, gateway or per-instance networks. Explicit typed model/permission inputs bridge later producers without placeholder policy.
- Human critical-path line review remains required and explicitly deferred by user to Epic completion.

## Issue #37 fixture

- Feature; expanded task9.4, agree with upstream: persisted CPU/memory settings become enforced per-user Docker cgroup limits, with a fixed finite PID ceiling. Blast radius: host availability and sibling user isolation.
- Extend the existing exported startup operation and canonical owned Docker harness; preserve complete composition, security, endpoint/audit ordering and all eleven baseline Docker cases.
- Evidence floor: behavioral settings-to-create RED/GREEN, unit conversion/boundary failures, actual Docker inspect before/after settings change and a controlled 256MiB/512MiB OOM with another real instance still usable; pinned exact-head full Docker suite, root checks, strict OpenSpec and CI.
- No live updates of existing containers, new settings schema/admin controls, locks/capacity/readiness/network changes or host-wide resource changes. Critical-path human review remains deferred by explicit user instruction to Epic completion.

## Issue #38 fixture

- Feature; expanded task9.5 (agree with upstream): bind a current instance's launch token, platform-authority HTTP exchange and persisted DSH cookie without credential disclosure.
- Preserve startup's starting-not-ready contract, existing canonical launch matcher, owned lifecycle and all twelve Docker cases; no gateway/browser credential forwarding or readiness-state transitions.
- Evidence floor: public-operation token/log/HTTP/error/stale-instance tests, actual HTTP/SQLite secret-safe proof, pinned real DSH same-Host200/different-Host401 using the persisted cookie; full exact-head Docker/CI and root checks.
- Critical-path human white-box review remains deferred to Epic completion by explicit user direction.

## Issue #39 fixture

- Feature; expanded task9.6 (agree with upstream): authenticated readiness, bounded startup failure compensation and credential-safe retained log tail.
- Invariant: only the exact current owned starting instance may become running after genuine authenticated HTTP200; otherwise it is stopped and recorded error with a sanitized final log tail and matching audit.
- Preserve create/start and credential-acquisition APIs, immutable image identity, thirteen Docker baselines, volume data, secret-safe logs/audit and current-instance conditional persistence.
- Evidence floor: public operation semantic RED/GREEN through real HTTP/SQLite, deadline/early-exit/stale-state/cleanup-failure and sanitized log-tail boundaries; pinned full Docker good/bad-overlay acceptance, root checks and exact-head CI.
- No gateway, lifecycle locks/capacity, retries, container deletion or network changes. Critical-path human review remains deferred to Epic completion by explicit user instruction.

## Issue #40 fixture

- Feature; expanded task9.7 (agree with upstream): retire only the current owned container while preserving both persistent volumes and recording the supplied stop reason.
- Must preserve: existing startup/readiness APIs, immutable image identity, all fifteen Docker cases, disabled-account cleanup ability, backend-only credentials, safe partial failure and exact-owned test cleanup.
- Evidence floor: public-operation real Unix Docker transport/SQLite RED/GREEN for stop→delete→atomic state/audit, stale/ownership/error paths; actual file contents survive stop/delete/recreate with same volumes, exact audit reason; root checks, strict OpenSpec, final-head Docker/CI.
- No lifecycle serialization/capacity, gateway, idle scheduling, instance networks, deleting volumes, configuration reset or schema change. Human critical-path review remains deferred to Epic completion per user.

## Issue #41 fixture

- Feature; expanded task9.8 (agree with upstream): explicit per-user FIFO lifecycle ownership and idempotent repeated starts.
- Current code has no shared orchestrator lifetime: public mutations are free functions accepting client/database per call. Cleanly replace those public exports with one factory-owned context; migrate all consumers, no global map or bypass aliases.
- Governing invariant: within one platform/database lifetime, same-user lifecycle mutations never overlap, ten concurrent starts create once, and different users progress independently.
- Must preserve current ownership/stale-state/secret/partial-failure safeguards, startup unconfigured outcomes, actual recreation after removed containers, and sixteen Docker baselines.
- Evidence floor: public-operation deterministic concurrency RED/GREEN, real Unix/SQLite barriers, cancellation/rejection/queue recovery and nested readiness acquisition; actual shared-context Docker smoke, full pinned Docker/CI. No distributed locks/capacity/gateway scope; human review deferred to Epic completion.

## Issue #42 fixture

- Feature; expanded task9.9 (agree with upstream): race-safe owner-local admission against persisted maxRunningInstances and starting/running occupancy.
- Governing invariant: separate users cannot both claim the last free slot; full/unconfigured requests cause no creation or error-state mutation and never evict an existing instance.
- Preserve explicit per-user coordinator ownership, different-user concurrency when slots exist, validated reuse, missing-model preflight precedence, state/credential/volume safeguards and sixteen Docker baselines.
- Evidence floor: public realtransport/SQLite RED/GREEN for full limit, concurrent final-slot claim, reservation handoff/release/failure and fresh settings; actual limit1 A/B stop/start/unconfigured Docker proof; root checks, strictOpenSpec and final-head Docker/CI.
- No global lifecycle lock, cross-process admission, schema/config additions, eviction, retry/reconciliation or gateway wiring. Human critical-path review remains deferred to Epic completion per user.

## Issue #43 fixture

- Feature; expanded task9.10 (agree with upstream): explicit startup reconciliation on the existing orchestrator owner, using Docker truth and persisted identity.
- Governing invariant: correction never adopts or destroys an unverified identity, never discards healthy running instances/credentials, and never treats daemon failure as absence.
- Preserve per-user serialization, capacity derived from corrected persisted states, exact-owned retirement/audits, persistent volumes, credential secrecy and seventeen Docker baselines.
- Evidence floor: semantic RED/GREEN at public owner with real Unix/SQLite; actual missing-container and missing-cookie corrections plus two authenticated running instances surviving owner reconstruction/reconciliation; root checks, strictOpenSpec, final-head full Docker/CI.
- Boundary: #43 owns the explicit awaited reconciliation operation; #47 adds network recovery; #56 composes the application owner and awaits reconciliation before lifecycle/routing traffic. No claim that main.ts is wired by this module-only slice.
- No orphan garbage collection, credential regeneration, background retries, new schema/config/dependencies or network behavior. Human critical-path review remains deferred to Epic completion per user.

## Issue #44 fixture

- Feature; expanded task10.1 (agree with upstream): pure IPv4 /28 snapshot allocation and startup pool-capacity validation.
- Governing invariant: selected subnet is inside the pool and overlaps no occupied subnet; exhaustion is explicit, release appears in the next Docker snapshot, no DB reservation.
- Add PLATFORM_SUBNET_POOL/config.subnetPool, default172.30.0.0/16, one canonical range parser and existing persisted maxRunningInstances; insufficient geometric capacity fails before listening and names the pool field.
- Evidence floor: allocation/overlap/release/exhaustion RED/GREEN; actual source/built startup with persisted limits; root/strictOpenSpec and retained eighteen Docker baselines/final-head CI.
- #44 is the declared pure-function slice; #45 fetches fresh all-Docker-network IPAM snapshots and serializes select/create. No network creation here. Human critical-path review deferred to Epic completion per user.

## Issue #45 fixture

- Feature; expanded task10.2 (agree with upstream): production per-instance bridge creation/attachment and exact-owned retirement cleanup.
- Governing invariant: each started user instance joins only its own verified bridge; different-user allocation cannot claim the same subnet, and lifecycle cleanup cannot destroy a foreign or newer network/endpoint.
- Preserve current loopback upstream transport pending #46, per-user queue/capacity/credentials/volume/audit safeguards, readiness error semantics, and all eighteen Docker baselines.
- Evidence floor: public Unix/SQLite semantic RED/GREEN, deterministic cross-user allocation and cleanup failures; two real instances with positive listening controls and cross-IP/hostname isolation plus stop/network-removal/sibling preservation; full root/strictOpenSpec/final-head Docker/CI.
- No platform-container attachment/no-port cutover (#46), startup orphan network sweep (#47), 61-network stress (#48), new schema/dependencies, data-volume deletion or DSH source changes. Human critical-path review remains deferred to Epic completion.

## Issue #46 fixture

- Feature; expanded task10.3 (agree with upstream): explicit network-default upstream transport, platform attachment and exact-endpoint lifecycle removal.
- Governing invariant: network-mode instances publish no host port; only the configured verified platform container joins the owned instance bridge, and the indexed upstream is the verified instance IPv4:3080.
- Preserve owner queues/capacity/uncertain-create quarantine, credentials/audits/current identity fences, volumes, sibling networks and all nineteen Docker baselines in explicit published-loopback mode.
- Selected risk packs: public API/config/schema fields, concurrency/state/ordering, auth/secrets, errors/rollback, file safety, resource/discovery, compatibility, packaging and documentation; mapped in task10.3 evidence below.
- Evidence floor: public Unix/SQLite transport lifecycle semantic RED/GREEN and negative endpoint/ownership/failure controls; real configured platform stand-in reaches unpublished DSH3080 and detaches on retirement; full root checks, strictOpenSpec, final-head full Docker and CI.
- No gateway/compose, startup network repair or orphan sweep (#47), capacity stress (#48), new DB schema/dependency or data deletion. Human critical-path review deferred to Epic completion per user.

## Issue #47 fixture

- Feature; expanded task10.4 (agree with upstream): startup reconciliation repairs platform attachment and safely removes genuinely orphaned owned bridges.
- Governing invariant: a fresh owner restores access to unchanged healthy indexed instances without credential/container churn; only freshly proven container-absent, exact-owned networks may be removed.
- Preserve owner-lifetime platform pin, user queues/actual mutation settlement, same-owner unknown-create quarantine, current row/account fences, no publications, data volumes, sibling endpoints and all20Docker baselines.
- All11 risk packs map below: public lifecycle/config/compatibility, shared-state ordering, ownership/secrets, error/partial cleanup, schema/audit, file/resource discovery, packaging/docs.
- Evidence floor: realUnix/SQLite recovery and orphan RED/GREEN plus failure/race controls; actual two-instance platform stand-in recreation/new-owner reconciliation and manually created orphan deletion; full checks/strictOpenSpec/final-head Docker/CI.
- No platform live-owner identity reset, background retry loop, global prune, credential regeneration, new schema/config/dependency, gateway/compose/app wiring (#56), data deletion or #48stress. Human critical-path review remains deferred to Epic completion.

## Issue #48 fixture

- Test/characterization; expanded (agree with upstream) task10.5: real61-bridge default-pool acceptance, including exact-owned destructive cleanup; no production behavior change expected.
- Governing invariant:61 simultaneously existing invocation-owned /28 bridges use distinct non-overlapping subnets from the production default pool and are all removed without affecting unrelated resources.
- Public `allocateSubnet` is the subject, followed by real Docker creation with its returned CIDR; literal `dsh-team-test` network names are required. No new public production create API or canonical-name override just for tests.
- Evidence floor: existing default-pool allocator unit baseline, actual61-live-network inspection and cleanup, deliberate overlap rejection as a known-bad Engine control, full checks/strictOpenSpec/final-head full21Docker/CI.
- Preserve all20 existing Docker cases and canonical resource ownership/cleanup; no61 user containers, admission-limit changes, global prune, dependencies/config/schema/DSH changes. Critical-path disclosure remains in PR and human review deferred to Epic completion.

## Issue #49 fixture

- Feature; expanded (agree with upstream), task11.1 only: platform namespace separation and gateway session admission at the shared HTTP/upgrade entrypoint.
- Governing invariant: reserved platform paths never enter the gateway; instance paths require a current active platform session, never a client-selected user or host.
- Preserve health, registration/login/logout/password-change, Origin/JSON guards, session expiry/renewal, logger redaction and database ownership. No upstream requests or container operations.
- Selected packs: public API, auth/secrets, shared state/order, errors, schema, configuration, compatibility, resource limits, packaging and documentation; file IO not selected (no new filesystem operations). Evidence maps below.
- Evidence floor: semantic RED/GREEN through buildApp, real TCP HTTP and upgrade rejection, valid/expired/revoked/disabled sessions, root checks, contract generation, strict OpenSpec, source/built runtime smoke and CI.
- Authenticated instance traffic deliberately returns 503 in this upstream-approved slice. HTTP/stream/WebSocket forwarding, connection tracking, wait reasons, orchestrator integration and login page rendering remain their named later issues.

## Issue #50 fixture

- Feature; expanded (agree with upstream), task11.2: authenticated HTTP forwarding and server-side credential/authority rewriting.
- Governing invariant: one current platform-session user selects an inseparable upstream endpoint/DSH-cookie pair; client routing fields cannot select another user or destination, and platform cookies never reach an upstream.
- Preserve task11.1 namespace/admission/renewal/error and rejected-upgrade resource behavior, platform auth/Origin guards and existing consumers. No orchestrator/instances-table wiring (#56), WebSocket forwarding (#52), connection registry (#53), wait-state enumeration (#55), or200MB performance claim (#51).
- Selected packs: public API, auth/secrets, shared-state/order, error/partial response, resource lifetime, schema, configuration, compatibility, packaging and docs. No new file IO, persisted schema, dependency or deployment config.
- Evidence floor: real two-user/two-upstream HTTP RED/GREEN with distinct cookies/body markers; forged routing/header controls, byte-preserving POST/status/path/query, pre/post-header failures and client abort; full checks/strictOpenSpec, independent source/built runtime and final-head21Docker/CI.

## Issue #52 fixture

- Feature; expanded (agree with upstream), task11.4 only: authenticated same-origin WebSocket upgrades through the existing gateway and paired-socket streaming.
- Governing invariant: current platform-session identity alone selects the trusted endpoint/cookie; only the configured public Origin may upgrade, neither platform cookies upstream nor DSH Set-Cookie downstream.
- Preserve existing HTTP routing/framing/backpressure/cancellation, auth session renewal and platform mutation guard. Shared exact-Origin predicate is extracted without changing auth behavior; app passes existing publicUrl, no new configuration.
- Selected packs: public API, auth/secrets, shared-state/invariant ordering, error/partial outputs, resource ownership, schema, compatibility, packaging and docs. No new filesystem/persisted state/dependency. Evidence maps in task11.4 below.
- Evidence floor: real TCP WebSocket handshakes and bidirectional frames, two-user authority/cookie isolation, missing/wrong/duplicate Origin rejection before resolver/upstream, both parser head buffers and coupled shutdown/error teardown; semantic RED/GREEN, root checks, source/built smoke, strict OpenSpec and exact-head full21Docker/CI.
- No per-user connection registry (#53), session-invalidation closure (#54), wait reasons (#55), instance lookup (#56), or memory acceptance claim (#51). The separate #51 contract is not evidence for this WebSocket slice.

## Issue #51 fixture

- Characterization/test; expanded (agree with upstream), task11.3: qualify existing production streaming with large-file integrity and a process-isolated memory ceiling.
- Governing invariant: a complete200MiB upload and download preserve byte count/SHA-256 while gateway-only peak RSS growth stays at most167,772,160bytes (160MiB) above its pre-transfer current RSS. The user explicitly approved this replacement of50,000,000bytes after measured characterization; preserve the original failure evidence and separate50,000,000byte startup-ambiguity guard.
- Preserve all task11.1/11.2 admission, credential, raw-target, method-framing and cancellation behavior. No second proxy, production sampler, endpoint, config or dependency expected; change forwarding only if the actual bounded case exposes a defect.
- Selected packs: public test/process entrypoint, resource/memory discovery, auth/secrets, shared-state/order, error/cleanup, file safety, evidence schema/units, compatibility, packaging and docs; mapped below.
- Evidence floor: real child-process gateway plus local streaming client/upstream, exact count/digests, raw baseline/sampled/OS-high-water metrics, actual full-body-buffering controls rejected for memory not semantics, restored/stability trials, full root checks/strictOpenSpec, source/built smoke and final-head21Docker/CI.

## Issue #53 fixture

- Feature; expanded (agree with upstream), task11.5 only: application-owned per-user connection registration and an explicit server-side disconnect function.
- Governing invariant: destroying one admitted user's current gateway connections closes its pending/established WebSockets and active HTTP transfers, not another user's separate connections or another application owner's resources. No permanent user ban is implied.
- Preserve namespace/session/Origin admission, endpoint-cookie pairing, streaming/framing, parser heads and ordered EOF behavior, approved160MiB acceptance, existing app shutdown and keep-alive reuse.
- Selected packs: public function/API, auth/secrets, shared-state/order, resource ownership, errors, compatibility, schema/configuration, packaging and docs. No new filesystem operation, persistence, dependencies or endpoint.
- Evidence floor: semantic RED/GREEN for twoA WebSockets plus activeA download closing within1second while B continues after destruction; actual upstream teardown; pending handshake, sequential keep-alive ownership, reentrant resolver destruction, unknown/repeated disconnect and application isolation. Full checks, strictOpenSpec, source/built smoke and exact-head21Docker/CI.
- Session invalidation triggers (#54), admin disable orchestration, instance lookup (#56) and activity persistence (#58) remain out of scope; expose the callable primitive without implementing their policy.

## Issue #54 fixture

- Feature; expanded, task11.6 only: revoke live gateway resources by their establishing platform session, retaining the explicit user-wide disconnect API.
- Reuse public non-renewing getSessionUser validation in a gateway-owned one-second sweep; observe committed database state, including external-process deletion and natural expiry. No auth writer callbacks, duplicated SQL/TTL policy or new configuration.
- Preserve other valid sessions of the same user, other users, transport framing/backpressure, HTTP keep-alive ownership and application-local shutdown. Session tokens remain only in live in-memory ownership, never persisted or logged.
- Selected packs: auth/secrets, shared-state/order, resource lifetime, errors, public API compatibility and packaging/docs. Storage lookup failures close affected resources with fixed sanitized logging rather than retain unverified authorization.
- Evidence: real logout plus same-user second-session survival, password rotation/revocation and rollback, expiry without renewal, pending upgrade/active transfer teardown, semantic RED/GREEN, full checks, source/built smoke and exact-head21Docker/CI. No admin orchestration (#69), instance resolver (#56) or activity policy (#58).

## Issue #55 fixture

- Feature; expanded, task11.7 only: five explicit unavailable outcomes from the injected gateway resolver, fixed waiting-page redirects and machine-readable503 responses.
- Preserve canonical outcome discriminators without an extra successful-result allocation: the existing endpoint gains `outcome: 'running'`; the alternative is `{ outcome: 'stopped' | 'starting' | 'full' | 'error' | 'unconfigured' }`. Remove the old undefined result and migrate all callers atomically.
- Auth/session/Origin precede state resolution; only the admitted user chooses the result. Navigation GET/HEAD accepting HTML redirects302 to `/_platform/wait`; other HTTP requests and valid upgrade attempts receive503 with the exact `reason` code.
- Selected packs: public contract, auth/secrets, errors, compatibility, resource lifetime and packaging/docs. Preserve ready forwarding, safe thrown-resolver502, body-parser bypass, credentials and #54 session teardown.
- Evidence: five-state real HTTP navigation/API matrix, raw upgrade JSON framing/EOF, anonymous/Origin/reserved-path precedence, transitions to running, source/dist smoke, fullchecks/strictOpenSpec and exact-head21Docker/CI. No orchestrator query implementation, wait UI, lifecycle mutation, migration or configuration.

## Issue #67 fixture

- Feature; expanded, tasks14.1–14.2 only: one administrator API authorization boundary and a read-only, filtered/paginated account list.
- Execute before #56 to supply its real prerequisites: #56 now depends on #77 and #83, which need #67/#78. This corrects missing DAG edges without moving model configuration or permission mapping into the gateway slice; rationale is recorded on #56.
- Add admin module with plugin-level onRequest authorization from existing session-cookie/getSessionUser public APIs. Active administrator gets200; missing/expired/revoked/disabled session401; authenticated employee403. No client-selected role/identity.
- GET `/_platform/api/admin/users` returns only id/email/role/status/createdAt plus pagination metadata; exact literal normalized-email substring search, stable descending createdAt/id order, bounded page size. No credentials, employee files or DSH content.
- Selected packs: authorization/secrets, persistence read boundary, validation/errors, schema/API, compatibility and docs. No new schema/dependency/config, account mutation, admin UI, model/runtime settings or read-audit event.
- Evidence: real401/403/200, role/session transitions, literal search/pagination/empty results, exact allowlisted JSON and secret non-disclosure, schema regeneration, full checks, source/dist smoke, independent four-seat review and exact-head21Docker/CI. Rule-file test guidance is tracked for the existing Epic-end human review.

## Issue #77 fixture

- Feature; expanded (agree with upstream), task15.1 only: administrator model configuration persisted through the canonical settings repository, with an explicitly secret-free HTTP projection and atomic audit.
- Extend existing settings ownership, not an environment-only source or second store. Preserve runtime settings, all existing repository callers, canonical session authorization, Origin/JSON admission and pure managed-config generation.
- Selected packs: public API/schema, configuration, authorization/secrets, persistence/order/rollback, compatibility, packaging and docs. No model connectivity, instance restart, UI, permission mapping, new dependency or migration.
- Evidence floor: semantic HTTP RED/GREEN; real TCP safe read/write, invalid default rejection, key preservation/replacement, secret-free logs/audit/errors, commit-time revocation and audit-failure rollback; source/dist file-database reopen smoke, full checks, strictOpenSpec, four-seat review and exact-head21Docker/CI.

## Issue #78 fixture

- Feature; expanded, task15.2 only: administrator runtime-configuration GET/PUT over the existing five canonical settings fields and atomic runtime-config.updated audit.
- Preserve #77 model API, secret custody, current-administrator commit fencing and existing settings/orchestrator semantics. Extract their shared admin configuration transport/transaction mechanics rather than copy a second implementation.
- Selected packs: API/schema/units, configuration, authorization/secrets, persistence/order/rollback, compatibility, resource admission and packaging/docs. No idle scheduler, permission mapping, startup endpoint, instance restart or new deployment limit policy.
- Evidence: realHTTP validation/range messages and roundtrip, unchanged model credentials/settings, atomic audit rollback and delayed-body revocation; same-owner60→2 capacity admission integration; source/dist fileDB smoke, both projection-leak and ignored-limit negative controls with restoration, full checks, strictOpenSpec, four-seat review and exact-head21Docker/CI.

## Issue #83 fixture

- Issue type: feature
- Fixture level: expanded
- Upstream suggested level: compact (override: published 0.2.0-rc.2 cannot meet the permission baseline through mapping alone; user explicitly approved plugin/image/overlay scope expansion on 2026-10-10).
- Blast radius: every managed Session's write/command authorization, new-session defaults, delegation, plugin startup and unload; image and orchestrator critical paths.
- Selected risk packs: all eleven, mapped in tasks.md; no DSH source modification or reduced acceptance.
- Evidence floor: semantic RED; complete plugin and caller cutover; actual released DSH three-default/restart/persistence behavior, native/PTC/delegated tool side effects and approval, deterministic Auto protocol/failure/cancel paths, real browser screenshots with zero new console errors, missing-plugin startup rejection; full checks, strict OpenSpec, exact-head trusted Docker suite and CI.
- Boundary: #83 ships real permission behavior, not selectable placeholders. #84/#85 retain separate actual development-model acceptance and any necessary in-scope plugin corrections. No original behavior is deferred out of the Epic.

## Issue #56 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task12.1 only.
- Blast radius: authenticated instance admission, gateway credential/endpoint pairing, process startup and database shutdown.
- Must preserve: canonical lifecycle owner and per-user/capacity fences, current platform-session/Origin policy, trusted managed composition and complete permission gate, all existing gateway streaming/WebSocket behavior.
- Selected risk packs: API/schema, config, auth/secrets, persistence/ordering, file IO, resource lifetime, error/rollback, compatibility, packaging and docs; mapped in tasks.md.
- Evidence floor: route-level semantic RED; real register/login/start/poll/DSH homepage/repeat-start Docker; unauthenticated/cross-user/credential controls; reconcile-before-listen and drain-before-DB-close; source/dist smoke, full checks, strict OpenSpec, reviewed-head full Docker and CI.
- No waiting-page implementation, idle/activity scheduler, provider request, new persistence schema, alternative model authority or fake production startup. #57–#61 retain their own acceptance.

## Issue #57 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task12.2 only.
- User-approved boundary: extend gateway/orchestrator first-use acceptance to `images/dsh-user` workspace seed, shared browser/Docker evidence and corresponding docs. No DSH-source modification or reduced acceptance.
- Blast radius: fresh state-volume initialization and first browser Session; existing workspace/Session data must not be replaced.
- Selected risk packs: all eleven, mapped in tasks.md; no new dependency, platform API, runtime initializer or storage migration.
- Evidence floor: observed fresh-image semantic RED and owned-image seed-only GREEN; permanent authenticated gateway browser regression, fresh/reused volume preservation, full checks, strict OpenSpec, exact-head Docker and CI.
- Preserve #56 lifecycle/credential boundaries, profile-seed contents, managed Chinese/no-notice composition and current permission/model settings. No real provider requests, wait UI or tasks12.3–12.6 behavior.

## Issue #58 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task12.3 only.
- Blast radius: live per-user gateway ownership, instance last-activity persistence and lifecycle/SQLite shutdown ordering.
- Preserve canonical connection/session registry and transport teardown, current identity admission, existing whole-row lifecycle fences, startup/reconciliation FIFO and secret custody.
- Selected risk packs: all eleven mapped in tasks.md; no schema migration, dependency, public HTTP endpoint, idle reaper or second lifecycle queue.
- Evidence floor: real-TCP activity count1→0 and last-activity transition; controlled minute-throttle boundaries and dirty/in-flight coalescing; serialized persistence during held lifecycle work; shutdown-before-DB-close, full checks, actual smoke, strict OpenSpec, exact-head Docker and CI.

## Issue #59 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task12.4 only.
- Blast radius: automatic container retirement, live browser/task safety, instance state/audit, user volume preservation and shutdown.
- Preserve original per-user FIFO, exact-owned retirement and whole-row fences, gateway/session admission, activity minute writeback, no volume deletion and immediate shutdown listener fencing.
- Selected risk packs: all eleven, mapped in tasks.md. No new schema, dependency, HTTP endpoint, task-discovery fallback or upstream DSH modification.
- Evidence floor: permanent semantic RED/GREEN; bounded real HTTP protocol/error tests; controlled-clock real Docker four idle scenarios with actual DSH running work; activity/start/identity races, timer/close and partial-failure boundaries; full checks, source/built smoke, strict OpenSpec, exact-head Docker and CI.

## Issue #60 fixture

- Issue type: test; fixture level: expanded (agree with upstream); task12.5 only.
- Blast radius: authenticated resume after automatic retirement, durable Session history and home/work volume identity.
- Preserve existing gateway wait redirect, explicit-only start, platform session lifetime, exact instance ownership, managed policy and every idle scenario.
- Selected risk packs: all eleven mapped in tasks.md; no new UI, schema, dependency or DSH-source change.
- Evidence floor: real Docker same-cookie lifecycle with completed real Agent conversation, exact history/file comparison before/after actual idle removal, new container and same volumes; discriminating owned fault control if behavior already exists; full checks, independent runtime smoke, strict OpenSpec, full frozen-head Docker and CI.

## Issue #61 fixture

- Issue type: bugfix + acceptance; fixture level: expanded (agree with upstream); task12.6 only. Actual public Docker counterexample showed a retained error container could not be retried, so the selected production repair is required.
- Blast radius: public instance-state projection, capacity isolation, retry after real startup error and missing-model precedence.
- Preserve valid platform-session routing, explicit-only start, existing capacity/no-eviction policy, canonical startup cleanup, safe error classification and current settings reads.
- Selected risk packs: all eleven mapped in tasks.md; no new UI, schema, dependencies or DSH source changes.
- Evidence floor: real public authenticated API with actual Docker/DSH proves limit1 sibling isolation→capacity release→retry, real failed startup→error→explicit successful retry, and missing model→unconfigured without side effects; full check, independent runtime smoke, strict OpenSpec, frozen-head fullDocker/review/CI.

## Issue #62 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); tasks13.1+13.2 only.
- Blast radius: platform routing namespace, offline static artifact delivery, browser dependency/build pipeline and authoritative UI verification gate.
- Preserve every existing backend API, unknown platform404, DSH gateway path, authentication/Origin boundary, source/dist startup and shutdown ownership.
- Selected risk packs: all eleven mapped in tasks.md; no login submission behavior (#63), wait/admin UI, DSH customization or database schema change.
- Evidence floor: semantic HTTP404→200 tracer, actual Vite artifact and asset delivery, traversal/missing/path boundary tests, real Chromium Playwright form screenshot with zero console errors, source/built smoke and pnpm e2e, all existing gates plus enforced UI CI and frozen-head complete Docker.

## Issue #63 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task13.3 only.
- Blast radius: browser credential submission, pending/error/success UI and same-origin navigation.
- Preserve real backend login/Origin/rate-limit/session behavior, static namespace confinement and gateway-only instance routing/start ownership.
- Selected risk packs: all eleven assessed in tasks.md; no backend API, schema, instance startup or other page changes.
- Evidence floor: enabled-form public browser semantic RED/GREEN, real login success and three rejection classes with Chinese feedback, loading/duplicate-submission and safe failure component tests, 80% per-file coverage, actual screenshots and no unexpected browser errors, independent browser smoke, full checks and frozen-head Docker/CI/review.

## Issue #64 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task13.4 only.
- Blast radius: registration credential UI, shared login form behavior and explicit registration-page delivery.
- Preserve all #63 login semantics and tests, backend registration/Origin/session contracts, static confinement/unknown404 and gateway-owned instance startup.
- Selected risk packs: all eleven mapped in tasks.md; no backend API/schema changes, new dependency, password/wait/admin page or DSH change.
- Evidence floor: public registration-page404→real rendered form tracer, actual browser short400/duplicate409/success201 with own HttpOnly session and gateway admission, pending/one-flight and login compatibility unit/browser proof, independent source/dist smoke, full checks and final frozen-head Docker/CI/review.

## Issue #65 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task13.5 only.
- Blast radius: current/new password custody, password-change replacement session, logout navigation and shared account-page dispatch.
- Preserve login/registration behavior, backend change-password/logout/Origin/session contracts, static confinement and gateway-owned instance routing/start.
- Selected risk packs: all eleven mapped in tasks.md; no backend authentication API/schema/dependency, DSH UI/source, wait/admin page or instance lifecycle change.
- Evidence floor: actual account-page404→rendered controls tracer; real browser wrong-current401→change204 with replacement cookie→logout204→old-password401/new-password200; cross-action pending proof, safe-error DOM coverage, screenshots/zero unexpected errors, independent source/dist smoke, full checks and final exact-head review/Docker/CI.

## Issue #66 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task13.6 only.
- Blast radius: explicit instance-start ownership, asynchronous status observation, navigation and existing account-page dispatch/static boundary.
- Preserve all login/registration/password/logout behavior, backend instance API/auth/Origin/60s readiness contracts, exact static confinement and fixed-root gateway routing.
- Selected risk packs: all eleven mapped in tasks.md; no backend API/schema/lifecycle, dependency, DSH or administrator page changes.
- Evidence floor: real wait-page404→rendered page tracer; built-browser four-state and retry→running scenarios using only the two permitted API substitutes; serialized polling/cancellation/safe-failure DOM proof; screenshots and no unexpected browser errors, independent source/dist smoke, full checks and frozen-head review/Docker/CI.

## Issue #68 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task14.3 only.
- Blast radius: administrator-only cross-user instance metadata and safe error-log projection.
- Preserve shared administrator session/current-role authorization, account/model/runtime routes, persisted instance semantics, credential custody and read-only lifecycle ownership.
- Selected risk packs: all eleven assessed in tasks.md; no Docker access, instance mutation, schema migration, UI, account operations or new dependency.
- Evidence floor: real HTTP administrator-instance-list401 tracer RED; five-state exact rows/nullable timestamps/latest error, current authorization and credential exclusion over real SQLite/TCP; safe storage failures, generated OpenAPI, independent source/dist smoke, full checks and frozen-head review/Docker/CI.

## Issue #69 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task14.4 only.
- Blast radius: account authority/session revocation, live gateway resources, instance lifecycle shutdown and durable audit.
- Preserve self/last-active-administrator protection, exact current-user/resource identity, all volumes/Session data, existing account/config/UI APIs and the single process-lifetime lifecycle owner.
- Selected risk packs: all eleven mapped in tasks.md; no new Docker owner, schema migration, UI, restart/reset operations, dependency or relaxed deadline.
- Minimal necessary composition: expose stop through the existing InstanceService and pass that capability to the admin plugin; its absence is confirmed by source inspection. Cancel its owned startup flight before ordered retirement; do not put Docker code in admin.
- Evidence floor: real endpoint RED; current-actor/atomic transaction/partial-failure/concurrency tests; real Docker disable closes connections AND physically stops within5s, old sessions/login denied, enable/new login/restart retains files and Session, exact audits, source/dist smoke, full checks and frozen review/Docker/CI.

## Issue #70 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task14.5 only.
- Blast radius: administrator-selected password replacement, all target sessions and safe audit metadata.
- Preserve current actor authorization, canonical Unicode password policy/hash, target role/status and instance/data ownership; no promotion or enable side effect.
- Selected risk packs: all eleven assessed in tasks.md; no file IO, Docker mutation, migration, UI, new dependency or hashing implementation.
- Evidence floor: real endpoint401 tracer RED, realTCP old/new password login and every old session denial, five-code-point rejection without writes, current-actor recheck across body/hash delay, atomic audit rollback, same-user connection cleanup, source/dist smoke, full checks and frozen review/Docker/CI.

## Issue #71 fixture

- Issue type: feature; fixture level: expanded (agree with upstream); task14.6 only.
- Blast radius: administrator-triggered single/bulk instance retirement and startup, open gateway resources, data preservation and action audit.
- Preserve existing InstanceService stop/start ownership, actual orchestrator FIFO, readiness/error publication, account disable authority, platform sessions and every persistent volume/Session.
- Selected risk packs: all eleven mapped in tasks.md; no new Docker owner, scheduler, polling mechanism, model/settings endpoint, UI or storage migration.
- Evidence floor: protected endpoint tracer RED, restart/disable exclusion and actor/failure/bulk-selection proofs; real adminHTTP→Docker changedStartedAt→ready with exact files/Session retained, stopped/error recovery, admin stop reason/restart audit; source/dist smoke, full checks and frozen review/Docker/CI.
- Diagnosed minimum companion change: expose readonly existing flight membership as InstanceService.hasStartupWork; cached error-reporting status cannot serve as recovery eligibility, while persisted status alone misses pre-persistence startup. Preserve starting409 and retry recovery with discriminating tests; no lifecycle algorithm change.

## Issue #73 fixture

- Feature, expanded fixture (retain upstream classification); task14.8 only, dependencies #67/#15 closed. Add the administrator read-only audit HTTP boundary over existing `queryAuditEvents`; no new SQL/filter implementation or audit mutation.
- Preserve current admin/session authorization, exact actor-or-target email filtering, inclusive millisecond bounds, stable descending time/ID order and existing audit-writer privacy. Publish only closed audit metadata/details, never employee files/Session/conversation or credentials.
- Selected risk packs and evidence are mapped in tasks.md. Required proof: endpoint401 tracer RED, real storage/TCP authorization/filter/pagination/privacy/mutation-rejection matrix, generated contract, source/dist smoke, full checks, bounded expanded review and frozen Docker/CI regression gates. No new Docker behavior or UI.

## Issue #74 fixture

- Feature, expanded/Critical Construction; task14.9 only, #62/#69/#70 closed. Deliver real administrator account UI and navigation, not placeholders for later screens. Reuse React18 pathname composition and existing account/status/password APIs.
- Minimal serving companion: add exactly `/_platform/admin` to the existing confined static-page owner and its regression proof; otherwise the requested browser surface cannot load. This is page delivery, not a new API/auth/lifecycle contract. Test harnesses under platform/test are required by task14.9's browser acceptance.
- Preserve existing login/register/account/wait pages, backend current authorization, destructive-action semantics and privacy. First real account-list response is the authority probe; no new identity endpoint. All four list states, confirmation/cancellation, race cleanup and actual disable/enable/reset effects need DOM and built-browser proof with screenshots.
- Evidence floor: public-boundary RED before implementation; actual browser→existing API→SQLite mutation/credential outcomes, explicit limited list-state controls, zero unexpected browser errors/external requests, source/dist smoke, full checks/UI and frozen review/Docker/CI. No API substitutes for successful mutation/authorization proof.

## Issue #76 fixture

- Feature, expanded/Critical Construction; task14.11 only, #74/#73 closed. Add the real audit page under the existing administrator shell and read-only audit API; no backend query/schema/mutation changes.
- Exact served route `/_platform/admin/audit` and existing pathname dispatch are necessary delivery companions. Extract only the actually shared administrator navigation so accounts and audit have one implementation; preserve existing account actions and all prior pages.
- Required evidence: real browser event/email/time filters and combinations, stable page membership, four list states/retry, current authority, no audit or credential/content side effects, screenshots and zero unexpected errors; DOM stale/date boundaries, source/dist smoke, full checks/UI, expanded review and frozen Docker/CI. No synthetic successful query/filter/pagination/auth evidence.

## Issue #79 fixture

- Feature, expanded (agree with upstream); task15.3 only, #77/#71 merged. Add save-time running-instance metadata to model/runtime PUT responses and prove existing next-start model activation.
- Preserve GET/input contracts, current administrator authorization, atomic settings/audit persistence, secret custody, existing lifecycle/restart ownership and live capacity/idle readers.
- Selected risk packs: API/config/schema/auth/order/errors/compatibility/packaging/docs; file IO is observed through unchanged overlays/volumes, not reimplemented. No migration, config generations, UI page, model connectivity or DSH changes.
- Evidence floor: missing save-count behavioral RED; mixed-state/zero/fresh-save counts and rollback; actual Docker/browser two→three models, unchanged running selector/default/connection, administrator restart then exact new list/default; screenshots, zero unexpected browser errors, full checks and frozen-head review/Docker/CI.

## Issue #80 fixture

- Feature, expanded/Critical Construction; task15.4 only, #77/#74/#71 and activation metadata #79 merged. Deliver the model configuration page through existing administrator APIs.
- Exact `/_platform/admin/models` serving allowlist, AccountPage dispatch and shared navigation are necessary delivery companions; no backend API or lifecycle behavior changes.
- Preserve current administrator authority, safe key projections, omitted-key preservation, settings validation, explicit restart-all admissions and partial-failure semantics.
- Evidence floor: real browser entry404 RED; built-browser save/reload, actual safe response bodies, cleared key, omitted-key preservation, form validation and explicit confirmed restart action; DOM pending/stale/authority/malformed boundaries, screenshots/zero unexpected errors, source/dist smoke, full checks/UI, native cross-review and exact-head Docker/CI.

## Issue #81 fixture

- Feature, expanded (agree with upstream; administrator production settings, not key handling in this page); task15.5 only, #78/#74 complete and shared navigation #80 merged.
- Deliver exact `/_platform/admin/runtime` through existing static owner/dispatcher/navigation, reading and saving the existing five-field runtime API. Preserve all backend domains, current authority, model/key custody, atomic audit and subnet-capacity validation.
- Risk packs: API/config/schema/authorization/concurrency/ordering/errors/path-safety/compatibility/packaging/docs. No new endpoint, lifecycle mutation, restart action, deployment setting or dependency.
- Evidence floor: actual page404 RED then built-browser five-field save/reload including fractional CPU; native/local invalid feedback without mutation; real over-pool400 with safe capacity guidance; current401/403 and failure recovery; pending/stale/malformed DOM boundaries; fullcheck/UI/source-dist smoke/screens/zero unexpected errors and frozen Docker/CI.

## Issue #82 fixture

- Test/verification feature, expanded (agree with upstream); task15.6 only, #77/#56 merged. Add the real-provider `pnpm test:model` acceptance path without changing production model, permission or lifecycle behavior.
- Governing invariant: a fresh employee, given no personal model configuration, causes the administrator-selected real model to execute a tool that creates the expected unique workspace file; harness-created files or simulated model responses cannot satisfy acceptance.
- Selected risk packs: CLI/configuration/file IO/schema/auth-secrets/concurrency/resources/compatibility/errors/packaging/documentation. Missing `DMXAPI_KEY` fails before Docker/browser provisioning; model tests remain outside ordinary unit/integration/Docker discovery.
- User authorization (2026-10-13): retain D16, establish a trusted CI execution channel to giap-vps, retain the model key there, and retire invocation-scoped execution authority afterwards. This does not authorize general public-PR execution on the host.
- CI must execute the reviewed full SHA on giap-vps, not merely validate posted evidence. Public personal-repository runners lack organization selected-workflow restrictions; use a restricted SSH capability with authenticated workflow identity rather than label-based runner routing.
- Evidence floor: missing-key failure, actual administrator HTTP configuration and fresh public registration/login, native Agent task and independent absent-before/exact-content-after file oracle, bounded failure and cleanup, CI authorization rejection controls, real Actions execution, full checks and exact-head review/Docker/CI.

## Issue #84 fixture

- Verification, expanded/Critical Characterization; task16.3 only, #83/#82 merged. Extend the established real-provider acceptance, not the deterministic model adapter.
- Governing invariant: manual approval precedes the real write; rejection reaches the Agent without file creation; Yolo completes without any approval, independently while another Session waits.
- Selected risk packs and evidence are mapped in tasks16.3: exact native event identities/full operation interval, real UI decisions and file effects, judge sensitivity, safe credential custody and bounded invocation cleanup.
- Preserve #82 onboarding and trusted VPS CI and #83 production gate/native deterministic coverage. Only observed defects authorize necessary plugin/image/overlay corrections; no DSH source modification, Auto acceptance or production qwen3.6 claim.
- Evidence floor: real development-model four-scenario acceptance, screenshots/zero new browser errors, sanitized retained native facts, full checks, expanded cross-review and exact-head VPS model/Docker/CI.

## Issue #85 fixture

- Verification, expanded/Critical Characterization; task16.4 only, #84 merged. Prove actual development-model Auto authorization and human fallback when that review alone is unavailable.
- Governing invariant: an ordinary write under Auto executes without asking only after the real review permits that exact operation; an unavailable review never silently grants and the original call waits for native human approval.
- Reuse #82/#84 real-provider browser/history/file/custody path. A fixture-only public LLM observer forwards healthy streams unchanged; a separately armed operation-scoped fault affects only the review request, never the originating Agent request or its tool/approval implementation.
- Required evidence: correlated real review provenance, no-ask exact-byte success, attributable injected technical failure → original native pending request/absent file → actual UI decision/effect, oracle rejection controls, screenshots/zero errors, exact-head checks/model/Docker/CI. Selected risk packs and limits are in tasks16.4.
- No production fault switch, broad model proxy, second provider, DSH source patch or production qwen3.6 claim; production permission changes require an observed counterexample and separate semantic RED/GREEN.

## Issue #86 fixture

- Feature, expanded (agree with upstream); task17.1 only, #27/#85 merged. Ship one real custom preset bundle and prove native selector discovery on a fresh instance.
- Canonical source is `plugins/office-agents/` from design14 and successor #87; #86 installs that same bundle into the image, rather than creating a second image-local definition. Required named-build-context callers and test expectations migrate atomically; no platform production behavior changes.
- Preserve existing preset IDs/default, model/permission policy, empty employee patch, immutable complete profile seed and existing-volume state. One `office-general` declaration with one Chinese persona instruction; the second preset, default switch, full office capabilities and model/DOCX acceptance remain #87–#90.
- Evidence floor: native selector RED without delivery, GREEN from an ordinary fresh volume with healthy exact preset metadata; source bundle in read-only seed, existing seed copy-up/edit/reuse checks, `pnpm check`, strict fixture and exact-head full Docker/CI.
- Critical image packaging and preset registration require expanded review and human line review, deferred to Epic end under the user's existing authorization.

## Issue #87 fixture

- Feature, expanded (agree); task17.2 only, #86 merged. Extend the same bundle to office-general/default and office-writer with complete metadata, real scoped skills and explicit tool sets.
- Preserve built-in presets and intentional explicit-standard callers, user state/seed protections, managed model/permission policy, and legitimate tool-less-preset parsing. The default change is intentional for fresh Sessions; no platform production/DSH source change.
- Eight-field carriers and evidence are specified in design14. Both presets share the bundle release version; native Loader declaration state supplies enabled. No unsupported native schema keys or parallel catalog.
- Reuse installed rc.2 Office skills with Python-only configuration and add only missing Chinese document-format guidance. Do not duplicate office-docx or promise rendering/knowledge retrieval that this stage does not provide.
- Evidence floor: native selector/default and omitted/explicit Session binding, metadata checking script, actual scoped tools and loaded associated skills, forbidden-network-tool rejection, seed delivery, full checks and exact-head Docker/model/CI. DOCX/delegation model acceptance remains #88/#89.

## Issue #88 fixture

- Test/Characterization, expanded (agree); task17.3 only, #87/#82/#26 merged. Prove the delivered writer with a real model and actual native manual preset selection, not a new production implementation.
- Governing invariant: the UI-selected office-writer Session executes the submitted notice task and creates a previously absent DOCX whose parsed body contains the supplied title, addressee, matter, issuer and date; a chat claim, wrong Session or malformed/stale artifact cannot pass.
- Reuse the existing managed-model lifecycle, browser, real administrator model and `.run/issue82` evidence custody. Preserve all #82/#84/#85 cases, provider/key gates, deadlines, ownership and cleanup.
- Evidence floor: real native picker/projection/selection-event binding; correlated prompt and completed turn; read-only python-docx parse of the actual unique requested workspace file; valid/invalid/missing-field judge controls and actual parser qualification; screenshots/zero errors; full checks, expanded review and exact-head Docker/model/CI.
- Non-goals: #89 natural-language delegation, #90 per-preset task catalog, Office rendering, other Agents, production platform/plugin/image behavior, or test-side document creation in the acceptance workspace. Human review remains deferred to Epic end.

## Issue #221 fixture

- Bugfix; expanded because the shared administrator CLI is a public entrypoint with credential/privacy boundaries. Prerequisite to #91's unchanged image smoke, not an image implementation change.
- Exact standalone `--help` returns0/stdout usage before config, TTY, terminal, signals or database lifecycle. Every other argument shape preserves existing rejection and privacy.
- Evidence: actual process RED→GREEN under invalid config/non-TTY/no data, unit argument boundaries, full existing CLI lifecycle suite, built-entry smoke, `pnpm check`, independent review and protected CI/Docker.
- Parent-inline fixture/implementation follows the single-mapped-slice delegation rule; no new parser, aliases, dependencies, model calls or authentication behavior.

## Issue #224 fixture

- Bugfix/test infrastructure; expanded because shared live Docker fixtures own subprocess lifetime, resource authority and real connection evidence.
- Actual #91 timeline shows a 9.464s synchronous volume observer blocking the platform proxy and Ping/Pong peer. Repair that fixture boundary, not DSH, heartbeat policy or sibling assertions.
- Add genuine asynchronous execution/registration within the existing lifecycle ownership boundary; migrate all live callers serially. Keep unrelated synchronous build/setup/final cleanup modes.
- Evidence floor: controlled external slow-helper old synchronous RED/new asynchronous GREEN with real platform/DSH carrier, original live acceptance, error/timeout/redaction/ownership contracts, full checks, independent review and exact-head Docker/CI.
- Separate from #204's action-relative close oracle and the independently captured DELETE/10s retirement deadline failure. This fix alone does not unblock #91.

## Issue #91 fixture

- Feature; expanded (agree with upstream production packaging classification).
- Blast radius: deployed startup, administrator CLI, native SQLite, static assets and shipped sandbox profile.
- Selected risk packs: CLI/script entry; config/setup; file/path safety; auth/secrets; packaging/dependency compatibility; failure cleanup; documentation. No schema/business/concurrency change.
- Evidence floor: real Linux amd64 multistage build, source-compiled SQLite exercised through packaged migrations, non-root CLI/help and default data write, packaged static resolver and default seccomp read; owned cleanup, `pnpm check`, exact-head Docker and CI.
- Task18.1 only: no Compose, Docker-socket deployment policy, model calls or full deployment. Shared fixture stays open.
- Parent owns this single mapped implementation slice under the higher-priority delegation restriction; independent packaging/security review remains required. Human review deferral is unchanged.

## Issue #92 fixture

- Feature; expanded because Compose owns deployed configuration, host paths/socket authority and externally observed instance startup.
- Deliver task18.2 only: fixed non-root platform service, same-absolute-path binds, one published port, network-mode instances, root environment example, real deployment entry and CI evidence wiring.
- Verification is disposable and invocation-owned on giap-vps (design decision16), not a persistent production rollout. No inference/model invocation; task15.6 retains conversation acceptance.
- Reuse the existing serial Docker project and trusted exact-head owner evidence. `test:deploy` selects its deployment file directly; full `test:docker` must also execute it. No duplicate verifier or unexercised deployment attestation.
- Required socket group is a deployment-only `DEPLOY_DOCKER_GID`, not a dummy platform config field. Task18.3 will account for platform and Compose consumers separately against the single example, with no unlisted or unused entries.
- Parent-inline fixture/implementation follows the single-known-slice delegation restriction; four independent high-risk final review seats and unchanged human-review deferral remain.

## Issue #98 fixture

- Characterization/Standard, expanded instead of upstream compact: tenant routing, native Session/file confidentiality and administrator authorization require adversarial oracle qualification and four independent review lenses.
- Task19.1 only on delivered Compose with two real employees; current platform session alone selects the instance despite other-user identifiers and forged forwarding input. No production/DSH changes, provider calls, long-connection or internal-network acceptance.
- Preserve existing six deployment cases and resource ownership/drainage. Inline fixture admission and mapped implementation follow the higher single-slice delegation restriction; not independent fixture review. Advisor unavailable after its invocation limit.
- Required evidence: live own-resource positives, cross-tenant negatives, wrong-routing and missing-admin-guard controls, restored candidate, check/strict fixture, independent review, frozen-head standalone/full Docker and protected CI. Shared Epic fixture remains open.

## Issue #204 fixture

- Test-oracle bugfix, expanded: destructive administrator lifecycle evidence must distinguish a live target closed after dispatch from an already-settled carrier. No production disconnect cause is established.
- Scope only existing disable/restart Docker acceptance; preserve original five-second bounds, sibling/physical/account/platform-session/native-history/file/volume assertions. Raw WebSocket carriers are not logical Session streams.
- Parent-inline mapped repair/admission disclosed; qualify both old false acceptance and corrected rejection with real preclosed owned carriers, then normal runtime/check/strict fixture, four-seat review, exact-head full Docker and protected CI. No provider, retry, deadline or DSH changes.

## Issue #99 fixture

- Characterization/Standard, expanded instead of compact because genuine multiplexed Session transport and cross-tenant confidentiality require protocol-aware evidence and four independent lenses.
- Task19.2 only: B's authenticated long connection sends A's native Session address and receives no A content. Reuse delivered Compose/two real employees/native RPC setup; no model calls or production/DSH changes. #98 and prerequisite #204 are merged.
- Require real logical session/follow streams with owned positive snapshots/live events, foreign-address typed rejection, and continued B delivery on the same carrier. A101/Pong or a timeout alone cannot pass.
- Parent-inline mapped implementation/fixture admission disclosed; advisor unavailable. Wrong-upstream semantic control, restored normal deployment, check/strict, independent review and frozen-head standalone/fullDocker/CI with empty owned inventories remain gates.

## Issue #100 fixture

- Test-only Characterization/Standard, expanded instead of compact: real process/file/network/authorization boundaries need qualified negative oracles and four independent review lenses.
- Task19.3 only: uid1001 commands inside B cannot read A's home/work sentinels or Docker socket, reach A by address/name, use unauthenticated administrator APIs, or alter the managed overlay. Runtime defects require a separate issue; no production/DSH/provider changes.
- Reuse genuine Compose account setup and existing network listener/probe scripts; preserve all eight deployment cases, ownership registration, graceful drainage and cleanup. Parent-inline mapped implementation/fixture admission is disclosed, not independent fixture review; advisor unavailable.
- Evidence floor: live positives, discriminating owned controls, restored candidate, check/strict fixture, independent review, frozen-head standalone/full Docker and protected CI with empty resource inventories. #101 credentials and #102 real Yolo execution remain separate.

## Issue #101 fixture

- Test-only Characterization/Standard, expanded instead of compact: native credential validity, filesystem discovery and secret-safe evidence require four independent review lenses.
- Task19.4 only on delivered Compose: actual A launch token/cookie cannot authenticate B, B cannot discover platform database/session/password-hash/A-cookie material, and its container is nonprivileged/nonroot. Preserve nine deployment cases and all resource ownership/drainage.
- Required evidence: each native credential succeeds at its owner, wrong-owner denial without replacement cookie, uid1001 readable-files/process-environment scan with positive sentinels and explicit discovery limits, leak/identity/privilege controls, restoration, check/strict, independent review and exact-head standalone/full Docker/CI.
- Parent-inline mapped implementation/fixture admission disclosed; advisor unavailable. No production/DSH/provider changes; runtime defects become separate issues. Shared model-key confidentiality is explicitly not provided; Yolo and audit/log scanning remain separate.

## Issue #102 fixture

- Expanded instead of compact: real-model execution, native tool lineage, permission state, Compose ownership and protected evidence require four independent review lenses.
- Task19.5 only: a real B Agent in Yolo executes the same five-boundary matrix as19.3 on delivered Compose. Existing ten deployment cases and all original model acceptance remain; no production, DSH, provider-policy, permission or deadline changes.
- Reuse the canonical internal matrix with an injected B command executor; default Docker execution remains19.3. Extract existing Compose account setup unchanged, and extend the existing native permission oracle for exact foreground bash execution rather than duplicate its prompt/turn/call/result checks.
- Parent-inline mapped implementation/admission is disclosed. Real provider work requires a newly approved reviewed SHA through the existing one-shot independent-retirement lane; prior3/3 authorization is exhausted. No model attempt or acceptance claim before that approval.
