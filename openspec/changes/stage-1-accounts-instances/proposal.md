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
