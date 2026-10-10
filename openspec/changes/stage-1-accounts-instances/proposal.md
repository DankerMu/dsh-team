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
