# Tasks

分组顺序即合入顺序。每组开头写明依赖哪些组；组内任务按序做。每个任务对应一个 PR 或一个 PR 里的一步，单个 PR 不超过 400 行（生成的锁文件和契约文件不计）。

测试放在哪里：

- `platform/src/` 下每个源文件有同目录的单元测试，并达到逐文件 80% 覆盖率（`pnpm test`）。单元测试不起容器、不绑端口：Docker 客户端接收一个可注入的传输函数，单元测试注入假的；`db` 模块用内存 SQLite。下面各任务写的行数都含这些单元测试。
- 绑定端口的测试在 `platform/test/*.integration.test.ts`（`pnpm test:integration`，已有）。
- 需要 Docker 的命令（镜像构建、探针、下面三个入口）都在 giap-vps 上执行（D16）：把要验证的分支检出到 VPS 上再跑，模型密钥取自 VPS 的 `~/.config/dsh-team/env`。开发机只跑 `pnpm check`。VPS 上只创建带 `dsh-team` 前缀的镜像、容器、卷和网络，用完删除。
- 另有三个入口，在首次用到的任务里加进 `package.json`、`AGENTS.md` 的验证矩阵和 CI，都不计入覆盖率：
  - `pnpm test:docker`：`platform/test/*.docker.test.ts`，对真实 Docker（设计里的测试边界 2），只创建带 `dsh-team-test` 前缀的资源并在结束时删除。
  - `pnpm test:model`：需要真实模型的测试，密钥取自环境变量 `DMXAPI_KEY`，缺失时失败而不是跳过。
  - `pnpm test:deploy`：对 compose 部署从外部做的测试（测试边界 3）。

## 1. 最小用户镜像和沙箱探针（任务包 1.0）

依赖：无。

- [x] 1.1 新建 `images/dsh-user/Dockerfile`：基础镜像、bubblewrap、pnpm、钉定版本的 DSH、uid 1001 的非 root 用户、`DSH_HOME=/data/home`、工作目录 `/data/work`、`DSH_TELEMETRY_DISABLED=1`；构建时校验解析到的 DSH 版本等于钉定值，不等则失败。验证：在 giap-vps 上构建成功，`docker run --rm <镜像> dsh --version` 输出钉定版本；把钉定值改成不存在的版本后构建失败。
- [x] 1.2 新建 `scripts/probe-sandbox.sh`：构建镜像，按“Docker 默认 → 自定义 seccomp → 再加 `/proc` 屏蔽放开”逐级启动容器，每一级用 DSH 的 `bash` 工具在“工作区内修改”模式下分别向工作目录和状态目录写文件，打印每一级的结果和最小可用组合；任何一级都不可用时非零退出并列出每一级的失败原因；只创建带 `dsh-team` 前缀的镜像和容器，退出时（含失败和中断）删除。验证：`pnpm lint:shell` 通过；在 giap-vps 上执行后 `docker ps -a` 和 `docker images` 里没有它创建的资源。
- [x] 1.3 在 giap-vps（amd64，Ubuntu 24.04）上执行探针，把得到的最小组合存为 `images/seccomp/dsh-user.json` 和一份记录所需其他容器选项的说明。验证：探针零状态退出；输出里“工作区写入成功、状态目录写入被拒绝”出现在选定的那一级；去掉该组合里任意一项后重跑，该级报告不可用；结束后机器上没有带 `dsh-team` 前缀的镜像和容器。
- [x] 1.4 把结论写回 `design.md` 的决定 12 和 Open Questions 第一条：VPS 上的最小组合、与阶段 0 在 arm64 上的结论是否一致、目标机 Ubuntu 22.04 待项目方执行同一脚本。验证：`design.md` 里这两处不再写“由探针定”，而是写出具体组合。

Suggested fixture level: expanded - 产出的 seccomp 配置和容器选项是生产配置，且是关键路径
Minimal mergeable slice: 1.1 的 Dockerfile 单独合入（约 60 行，不改任何平台代码，`pnpm check` 不受影响）

### Issue #4 risk/evidence map (task 1.1 only)

| Risk pack                                      | Selection and evidence                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Public API / CLI / script entry                | Selected: runtime `dsh --version`, `pnpm --version`, and `bwrap --version` on giap-vps.                             |
| Config / project setup                         | Selected: inspect effective `DSH_HOME`, telemetry switch, uid, and work directory in the running image.             |
| File IO / path safety / overwrite              | Selected: uid 1001 can write both distinct directories; verification removes only its own uniquely named resources. |
| Schema / columns / units / field names         | Not selected: no database or serialized application schema changes.                                                 |
| Auth / permissions / secrets                   | Selected: uid 1001, directory ownership, no credentials in image; no runtime privilege relaxation in this issue.    |
| Concurrency / shared state / ordering          | Not selected: no shared application state; isolated verification resource names.                                    |
| Resource limits / large input / discovery      | Not selected: orchestration and resource limits are later issues.                                                   |
| Legacy compatibility / examples                | Not selected: no existing production image or caller is replaced.                                                   |
| Error handling / rollback / partial outputs    | Selected: nonexistent version and wrong expected-version assertion each fail the build; cleanup runs on failure.    |
| Release / packaging / dependency compatibility | Selected: build on Linux amd64 giap-vps; exact installed DSH release equals the baseline pin.                       |
| Documentation / migration notes                | Selected: record build/run and negative-case evidence in PR; mark task 1.1 complete only after verification.        |

The first slice uses disposable runtime assertions, not a source-text test or an early duplicate of task 7.1's Docker harness. Run `pnpm check` once after implementation; critical-path human review is required before merge.

Runtime evidence (2026-10-03, giap-vps Linux amd64, Docker 29.1.3): the minimal image built successfully; `dsh --version` returned `0.2.0-rc.2`, pnpm `10.34.6`, bubblewrap `0.8.0`, uid `1001`, home `/data/home`, cwd `/data/work`, telemetry `1`; writing and reading separate files in both directories succeeded. Disposable builds with nonexistent DSH `0.0.0-does-not-exist` and mismatched expected version `0.2.0-rc` each exited 1 for the intended reason. The original image still returned the pinned version afterward; verification containers and the tagged image were removed.

### Issue #5 risk/evidence map (task 1.2 only)

- Public API / CLI / script entry — selected: execute the probe on giap-vps; exit 0 only for a valid workspace/state outcome; nonzero when all levels fail.
- Config / project setup — selected: report the effective Docker security options per attempted level.
- File IO / path safety / overwrite — selected: workspace marker exists with exact contents; denied state marker remains absent; clean up only run-owned paths/resources.
- Schema / columns / units / field names — selected: custom seccomp JSON is accepted by Docker, and tool result handling matches the installed DSH npm release.
- Auth / permissions / secrets — selected: DSH Workspace Write permission context; non-root container; no secret-bearing model call or privileged/unconfined fallback.
- Concurrency / shared state / ordering — selected: unique run ownership and failure/interruption cleanup without affecting a concurrent or unrelated resource.
- Resource limits / large input / discovery — selected: bounded tool execution; a hung level cannot prevent eventual failure and cleanup.
- Legacy compatibility / examples — not selected: no previous production probe; phase-0 scripts remain evidence only.
- Error handling / rollback / partial outputs — selected: actual unsupported-level reasons, all-failure nonzero exit, success/failure/interruption resource checks.
- Release / packaging / dependency compatibility — selected: pinned npm release on Linux amd64; do not base a success claim on newer local DSH source.
- Documentation / migration notes — selected: usage and output interpretation in script help/comments and PR runtime evidence; final host-policy conclusions remain #6.

Run `pnpm check` locally after implementation and the probe scenarios on giap-vps. The fixture review must not assume the unknown minimal working security combination; the probe measures it.

Task 1.2 runtime evidence (2026-10-03): giap-vps Docker 29.1.3 / Linux amd64, actual DSH 0.2.0-rc.2 tool reported Docker default usable (workspace exact bytes, explicit state sandbox denial). All 17 success/failure/timeout/INT/TERM/cleanup/config-boundary scenarios passed after two fixes; normal/failure/interruption runs left no owned resources. Injected cleanup failure was reported nonzero and its exact resources were recovered by the verifier. Final minimum-policy artifact and host conclusions remain task 1.3/1.4.

### Issue #6 risk/evidence map (tasks 1.3/1.4 only)

- Public API / CLI / script entry — not selected: existing probe/driver unchanged.
- Config / project setup — selected: exact shipped profile accepted by Docker; options note says which security options are actually needed.
- File IO / path safety / overwrite — selected: immutable policy and read-only test mounts; targeted cleanup of test-owned resources.
- Schema / columns / units / field names — selected: JSON matches pinned upstream semantics and Docker consumes it successfully.
- Auth / permissions / secrets — selected: real DSH Workspace Write allows workspace and explicitly denies state writes; no added privilege.
- Concurrency / shared state / ordering — not selected: no new stateful executable behavior; existing probe resource isolation reused.
- Resource limits / large input / discovery — not selected: no new discovery or unbounded input.
- Legacy compatibility / examples — not selected: no prior shipped seccomp artifact; phase-0 comparison is a documented observation, not a compatibility promise.
- Error handling / rollback / partial outputs — selected: restrictive-policy negative control fails, measured default success retained; failed verification prevents adopting a policy.
- Release / packaging / dependency compatibility — selected: upstream tag/hash provenance plus independent real-tool proof for the delivered artifact on giap-vps.
- Documentation / migration notes — selected: decision 12 and Open Questions 1 name the measured settings, phase-0 difference, warning and Ubuntu 22.04 owner; empty relaxation-removal set is explicit, not a fabricated test.

Tasks 1.3/1.4 evidence (2026-10-03): fresh probe exit 0 selects Docker default; independently passing the exact shipped JSON also exits 0 with workspace exact bytes and explicit state-write denial. Removing Landlock allows in a disposable stricter copy yields `SANDBOX_UNAVAILABLE`, no workspace marker, exit 1. No added relaxations exist to subtract (removal scenario N/A, not fabricated); all test-owned containers/images removed. Original upstream SHA256 and shipped JSON semantic equality verified; phase-0 discrepancy and target Ubuntu 22.04 responsibility are recorded in decision 12 / Open Questions 1.

## 2. 探针：DSH Web 接口和空闲信号（任务包 1.1）

依赖：第 1 组（需要镜像）。

- [x] 2.1 新建 `scripts/probe-dsh-api.sh`：用第 1 组的镜像起一个实例，换到 DSH cookie，记录界面在“打开首页、新建 Session、发一条消息、任务运行中、任务结束”各时刻实际请求的 HTTP 路径和 WebSocket 地址。验证：脚本输出一份路径清单；结束后不留容器。
- [x] 2.2 在探针里找出“该实例是否有运行中的任务”的判断方式：依次尝试 DSH 的 HTTP 接口、WebSocket 事件、状态目录里的文件，对每种方式记录在“任务运行中”和“空闲”两种状态下的取值。验证：输出里至少一种方式在两种状态下取值不同并可重复三次；若都不行，输出明确写“未找到可靠信号”。
- [x] 2.3 把结论写回 `design.md` 决定 9 和 Open Questions 第二条。找到信号：写出采用的信号。没找到：这是对 F13 的偏离，停下来把现象和退路（只按连接和活动时间判定，默认空闲时间调长到的具体数值）交项目方确认；确认后在同一个 PR 里改写 `instance-lifecycle` 规格“空闲后停止”的要求和“有运行中的任务时不回收”场景。验证：决定 9 不再写“取决于探针”；走退路时 PR 描述里有项目方的确认，且规格与决定 9 一致。

Suggested fixture level: compact - 只新增一个探测脚本和文档结论，不改平台运行时代码
Minimal mergeable slice: atomic - 2.1 的路径清单是 2.2 的输入，结论只有三步都做完才成立，拆开合入的中间状态没有可用产出

### Issue #7 risk/evidence map (tasks 2.1–2.3 only)

- Public API / CLI / script entry — selected: run the root probe command on giap-vps and record real UI HTTP/WS paths per required phase.
- Config / project setup — selected: pinned image/model and explicit required browser/model environment; missing prerequisites fail loud.
- File IO / path safety / overwrite — selected: inspect only fresh test-owned state metadata; targeted cleanup of unique probe resources.
- Schema / columns / units / field names — selected: runtime values and adopted signal predicate matched to actual npm release, not route guesses.
- Auth / permissions / secrets — selected: Host-bound token exchange; all displayed/persisted evidence excludes credentials and message contents.
- Concurrency / shared state / ordering — selected: real task start/running/completed/idle transitions sampled in order for three cycles; errors/disconnects are not idle.
- Resource limits / large input / discovery — selected: bounded startup/browser/task waits and constrained, redacted signal observations.
- Legacy compatibility / examples — not selected: no prior shipped API probe or platform consumer to migrate.
- Error handling / rollback / partial outputs — selected: unavailable channels/missing prerequisites clearly fail or record unavailable; no-signal fallback stops for user approval; failure/interruption cleanup.
- Release / packaging / dependency compatibility — selected: real Docker/browser on giap-vps against pinned DSH; verification-only browser tooling does not silently change production dependencies.
- Documentation / migration notes — selected: decision 9 / Open Questions 2 name observed paths, predicate, three-cycle evidence and limits; no spec fallback without approval.

验证记录（#7）：giap-vps 上 `pnpm probe:dsh-api` 的等价 root-script 调用 `node --run probe:dsh-api` exit 0，DSH `0.2.0-rc.2`，三周期 HTTP `items[].running` 均为 `true → false`；WS 运行值未知、结束 `false`，文件扫描 `EACCES`，均明确不采用。实际首页截图已保存，浏览器 console baseline/new 均为 `(none)`；独立 Docker 查询无 probe 容器或命名镜像残留。`pnpm check` 和 OpenSpec strict 验证通过。原 Preview Notice 异步渲染导致 composer inert 的失败已用实际截图定位，修复为等待真实可交互公告控件后普通 UI 关闭，未改 DSH 或预置配置。

路径库存只允许 HTTP/HTTPS/WS/WSS 的 pathname，其他协议（包括 data/blob）统一输出不含内容的占位符，避免将内嵌图像或其他 payload 当作路径记录。新增脱敏边界验证覆盖非网络协议、大 data payload、HTTP 查询参数去除及无效 URL；不放宽任何信号或日志验收要求。

## 3. 探针：预置工作区、中文界面、关闭公告（任务包 1.2）

依赖：第 1 组。

- [x] 3.1 新建 `scripts/probe-first-run.sh`：用空状态卷起实例，记录首次打开界面时是否需要选择或创建工作区、界面语言、是否弹出公告。验证：脚本输出这三项的现状。
- [x] 3.2 在探针里依次尝试用受管覆盖层、预置配置目录里的文件、启动参数三种办法，使新实例首次打开即可输入、界面为中文、没有公告；记录每种办法是否生效。验证：输出里三项各有一种生效的办法，或明确写“无法做到”及现象。
- [x] 3.2a 按项目方 2026-10-04 “扩大到插件或镜像定制”的选择，增加本仓库客户端插件与受支持的 roster 组合候选；不修改 DSH 源码，不降低原验收。验证：非 loopback hostname、English navigator、全新状态和浏览器下，工作区绑定 `/data/work`、界面中文、初始化完成后无公告、输入及清除标记成功；刷新后重复通过。模型切换及 General 设置仍可用，错误/缺失插件或恢复公告组件的反例被拒绝；不靠探针点击或改设置取得通过。
- [x] 3.3 把结论写回 `design.md` 决定 10、12 和 Open Questions 第三条。三项都能做到：写出具体做法（哪个配置键或哪个文件）。有一项做不到：停下来把现象交项目方确认；确认后在同一个 PR 里改写 `instance-lifecycle` 规格“新实例可以直接使用”的要求和场景。验证：这三处写出具体做法；有做不到的项时 PR 描述里有项目方的确认，且规格与设计一致。

Suggested fixture level: expanded - 经用户批准扩展到客户端插件、组件组合和真实浏览器验收；保留最初三种方法的实测
Minimal mergeable slice: atomic - 三步是一条探测链，只有结论写回才有可合入的产出

验证记录（#8）：原三方法矩阵中，预置文件/组合方法只实现 `/data/work` 绑定，中文和公告抑制未生效。项目方于 2026-10-04 选择“扩大到插件或镜像定制”，未批准需求降级。新增 `plugins/zh-locale/` 及 canonical patch 的实际 composition 试验，在非 loopback hostname + English navigator 下首次进入、刷新均 `accepted: true`，中文、无公告、输入及清除成功且 consoleErrors 为空；General 设置及两个配置模型的 UI 切换通过，无模型请求。缺失插件、错误注册和恢复公告组件均为 harness-inconclusive；真实插件 apply 延迟 10 秒在 60 秒预算下通过，在 5 秒预算下非零/inconclusive，未提前认定无公告。原初始化与 post-snapshot 故障证据保留。决定 10、12、Open Questions 第三条及规格实现说明已同步，原验收要求不变；#27/#29 负责生产接线，不复制探针 Session 状态。

### Issue #8 risk/evidence map (tasks 3.1–3.3, including approved 3.2a)

- Public API / CLI / script entry — selected: root probe command prints baseline, all three original method outcomes and the composition candidate for workspace/language/notice; invalid prerequisites fail.
- Config / project setup — selected: exact pinned-release keys/files/arguments and deployed plugin/patch identity; fresh combined-recipe UI run and reload; no inferred success.
- File IO / path safety / overwrite — selected: fresh owned state/work volumes and browser profile per trial; whole-file preseed/overlay; independent cleanup query.
- Schema / columns / units / field names — selected: record concrete released settings namespace/key and persisted data shape from discovery, then verify by fresh launch.
- Auth / permissions / secrets — selected: internal Host-bound token/cookie exchange, non-root instance, no credentials or content in diagnostic artifacts; no native ownership or loopback spoofing, no model-setting privilege escalation.
- Concurrency / shared state / ordering — selected: await real app/settings/notice readiness, including independently established composition readiness when the notice component is absent; no cross-trial state or automatic UI setup masking candidate failure.
- Resource limits / large input / discovery — selected: bounded launch/browser/cleanup; only allowlisted first-run observations and scoped state differences.
- Legacy compatibility / examples — not selected: no older first-run probe exists; shared #7 entrypoint is instead covered by the required regression evidence.
- Error handling / rollback / partial outputs — selected: failure/interruption cleanup and explicit unknown/unsupported versus “无法做到”; no unapproved fallback.
- Release / packaging / dependency compatibility — selected: actual npm `0.2.0-rc.2` and giap-vps Docker/Chrome; released CLI help/parser establishes unsupported flags; same repo-owned plugin bytes loaded through the released loader; unexpected version/roster fails, and composer model-selection plus General settings survive composition.
- Documentation / migration notes — selected: decisions 10/12/OQ3 name the tested recipe and project approval; unchanged first-entry requirements; #27/#29 consume the canonical plugin/patch rather than reimplementing it.
- Authority/locale attribution control: baseline and every adopted recipe use a non-loopback test hostname mapped only inside Chrome to the loopback published port; report/assert hostname and English navigator language. Loopback discoveries are not accepted as gateway-authority success.

## 4. 数据库和基础配置（任务包 1.3 的剩余部分）

依赖：无。

- [x] 4.1 加入 better-sqlite3 依赖，在 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里登记；`platform/src/db/` 提供打开数据库的函数（开启外键和 WAL，数据库文件权限 0600）。配置项 `PLATFORM_DATA_DIR` 加进 `config.ts` 和 `.env.example`。在 `platform/AGENTS.md` 写明单元测试可以用内存 SQLite。验证：单元测试——内存库上外键约束生效；集成测试——在临时目录打开数据库，文件权限为 0600；`pnpm lint:deps` 通过（只有 `db` 引用驱动）。
- [x] 4.2 迁移执行器：按编号读取 `platform/src/db/migrations/` 下的 SQL 文件，在一个事务里应用未应用的部分并记入 `schema_migrations`。验证：单元测试（内存库）——空库全量应用成功；再次执行不重复应用；一个迁移里有错误语句时整批回滚、`schema_migrations` 不变。
- [x] 4.3 第一份迁移：`users`、`platform_sessions`、`instances`（含上游地址和端口）、`settings`、`audit_events` 五张表及索引和约束（邮箱唯一、角色和状态的取值约束、外键）。验证：单元测试——重复邮箱插入失败、非法角色插入失败、删除用户的平台会话行不影响用户行。
- [x] 4.4 `settings` 的读写函数和默认值（空闲 30 分钟、2 核、4G、同时运行 60、默认权限档 Yolo；模型清单每项是模型名加可选的上下文窗口）。验证：单元测试——空库读到默认值；写入后读到新值；非法取值（负数、未知档位、上下文窗口不是正整数）被拒绝。
- [x] 4.5 平台启动时打开数据库并应用迁移；`buildApp` 接收数据库句柄。删除 `constraints.yaml` 里 `integration_tests_real_db` 这条延后项，在 `AGENTS.md` 验证矩阵里补上数据库一行。验证：集成测试——重新打开同一数据库文件后数据还在；`pnpm e2e` 通过且数据目录里生成了数据库文件；`pnpm check` 通过。
- [x] 4.6 基础配置项：平台对外地址、cookie 仅 HTTPS 发送、受信代理列表（默认为空）。加进 `config.ts` 和 `.env.example`；对外地址缺失或不合法时启动失败并指名该项；从对外地址导出 authority 供后续模块使用。验证：单元测试——三项各自的合法和非法取值；缺少对外地址时错误信息含该变量名（`deployment` 规格“配置项明确且缺失时启动失败”的“缺少对外地址”场景）。

Suggested fixture level: expanded - 新建持久化表结构和迁移机制，后续每个模块都依赖它
Minimal mergeable slice: 4.1 加 4.2（驱动、打开函数、迁移执行器和它们的测试，约 250 行；此时没有任何迁移文件，平台行为不变）

### Issue #9 risk/evidence map (tasks 4.1–4.2 only)

- Public API / CLI / script entry — selected: `db/index.ts` exports exercised by a direct real-SQLite smoke; no new route, unchanged health smoke.
- Config / project setup — selected: data-directory default/explicit/invalid environment cases, all typed callers updated without adding startup database side effects.
- File IO / path safety / overwrite — selected: private file creation and reopen under permissive umask, owned temporary-directory cleanup, no unrelated chmod/delete.
- Schema / columns / units / field names — selected: numeric migration identity/order, idempotent ledger, duplicate/invalid filename rejection; business schema deferred to #10.
- Auth / permissions / secrets — selected: database mode 0600 before writes; inspect SQLite WAL sidecar permissions while open; no credentials in fixtures/logs.
- Concurrency / shared state / ordering — selected: one synchronous transaction for the complete pending batch and ledger; preserve earlier committed migrations on a later batch failure. Multi-process startup is not claimed.
- Resource limits / large input / discovery — selected: trusted finite migration directory, file reads before mutation, close connections on failure and after tests; no background process.
- Legacy compatibility / examples — not selected: no prior database module or database-format migration exists; unchanged config consumers covered by config tests/typecheck.
- Error handling / rollback / partial outputs — selected: invalid SQL in a later pending file rolls back all pending DDL/data and records; default absence versus explicit bad directory distinguished.
- Release / packaging / dependency compatibility — selected: pinned better-sqlite3 with Node24 native load, pnpm build allowlist and generator-only lockfile; `pnpm check` and same-head CI.
- Documentation / migration notes — selected: memory-SQLite unit exception and env example, public ownership/transaction contract; task4.5 owns deferred-control removal and root verification-matrix update.

验证记录（#9）：`openDatabase` / `applyMigrations` 经 `db/index.ts` 导出。37 个单元测试、8 个集成测试和 `pnpm check` 通过，所有有逻辑的源文件逐文件覆盖率 100%。真实独立 API smoke 在 Node 24.13.1 / SQLite 3.53.4 上验证主文件及 WAL/SHM 均为 0600、WAL/外键开启、2→10 数字顺序、重放不重复、后续失败同时回滚数据/DDL/迁移记录、关闭重开保留数据。默认目录存在但某个 SQL 文件缺失的真实反例先失败；修复 ENOENT 捕获范围后拒绝缺失文件，只有默认目录本身缺失视为空集。配置项先 RED 后 GREEN；新 API 的初始缺失属于 setup RED，另有原生驱动 0644/delete 及逐文件事务残留数据的独立负对照。实际 HTTP health smoke 通过，配置数据目录未被创建，证实 #12 的启动接线尚未提前实现。

### Issue #10 risk/evidence map (task 4.3 only)

- Public API / CLI / script entry — selected: existing default `applyMigrations(db)` path in source and compiled API smoke.
- Config / project setup — selected: root build copies SQL into generated db directory; no environment/startup change.
- File IO / path safety / overwrite — selected: replace only generated SQL output; smoke uses owned temporary DB and cleanup.
- Schema / columns / units / field names — selected: five usable tables, explicit keys/nullable fields/millisecond timestamps, role/status/foreign-key/uniqueness constraints and query indexes.
- Auth / permissions / secrets — selected: session rows store hash field, account references cannot be orphaned, deleting sessions cannot remove users; no secret-bearing test/log fixtures.
- Concurrency / shared state / ordering — selected: retain existing one-batch migration transaction and replay ledger; no new multi-process behavior.
- Resource limits / large input / discovery and Legacy compatibility / examples — not selected: one finite trusted SQL asset, unchanged discovery and no prior deployed business schema.
- Error handling / rollback / partial outputs — selected: SQL rejection preserves valid rows; existing batch rollback regression retained.
- Release / packaging / dependency compatibility — selected: root build and standalone compiled default-location smoke, no new dependency.
- Documentation / migration notes — selected: schema decisions above, task4.3 completion/evidence; other group4 tasks remain separate.

验证记录（#10）：真实内存 SQLite 逐步 RED/GREEN，重复邮箱、非法角色/状态、外键、单用户实例唯一、端口整数范围、删除平台会话不影响用户及其他用户会话均覆盖；审查后补充 NULL 主键、重复身份键和端口1/65535边界。五表数据重放不丢失、迁移记录仅一次。`pnpm check` 通过（49 unit、14 integration）。原仅 tsc 的编译产物实际调用默认迁移后报 `no such table: users`；加入 SQL 交付后，源 API 与复制到独立临时目录的 dist API 均在默认路径迁移真实文件库、写入五表、重开重放并逐行比对通过，不读取源 SQL。没有启动接线或仓储行为，临时文件均已清理。

### Issue #11 risk/evidence map (task 4.4 only)

- Public API / CLI / script entry and Config / project setup — selected: exported repository read/write, explicit defaults and unchanged app startup, direct source/built API smoke.
- Schema / columns / units / field names — selected: JSON per owned key, MiB/minutes/cores, platform tier IDs, optional model context and positive safe integers.
- Error handling / rollback / partial outputs and Concurrency / shared state / ordering — selected: invalid patch leaves prior rows, corrupt stored values fail loudly, injected later-row SQL failure rolls back the complete patch; no cache or multi-process coordination.
- File IO / path safety / overwrite and Release / packaging / dependency compatibility — selected: owned file DB reopen smoke through existing private open/compiled migrations; no new path handling or dependency.
- Documentation / migration notes — selected: design boundary records units/ownership and deferred model API fields. 验证记录（#11）：`pnpm check` 118 unit/14 integration 通过；69个 settings 用例覆盖默认、部分更新、验证、损坏值、非对象模型条目、继承属性档位拒绝和事务回滚，settings逐项覆盖率100%；源API及独立复制dist的真实文件库重开smoke均通过，非JSON非本模块键保持不变，错误不回显值，临时资源已清理。
- Auth / permissions / secrets, Resource limits / large input / discovery and Legacy compatibility / examples — not selected: no model keys/auth, discovery or previous settings API; fractional CPU and finite bounds are value validation, not a new resource scheduler.

### Issue #12 risk/evidence map (task 4.5 only)

- Public API / CLI / script entry and Legacy compatibility / examples — selected: required buildApp handle, complete caller migration, unchanged HTTP/OpenAPI, source and built startup.
- Config / project setup and Documentation / migration notes — selected: PLATFORM_DATA_DIR/platform.db, matched verification matrix, real-DB deferral removal, injected-memory unit rule and local data ignore. Remove the matrix footnote's now-false “no database surface” claim and update the same operating document's planned-persistence wording to the implemented SQLite driver.
- File IO / path safety / overwrite, Auth / permissions / secrets and Resource limits / large input / discovery — selected: existing0600/WAL opener, no DB content logged, only owned temp files removed, no leaked process/connection.
- Schema / columns / units / field names and Release / packaging / dependency compatibility — selected: default SQL assets migrate before health, one ledger record, settings survive file reopen and built-process restart.
- Error handling / rollback / partial outputs and Concurrency / shared state / ordering — selected: migrate before listen, ownership transfer on successful build, onClose release, failed startup exits and closes resources; no multi-process migration coordinator.

验证记录（#12）：应用关闭句柄的集成反例先失败，源进程曾健康但未创建数据库的独立反例先失败；修复后119 unit/15 integration、完整检查、37项guardrail和固定版本SAST均通过。`pnpm e2e` 输出 database schema/migration OK 与1条HTTP smoke成功。源/编译进程分别验证0600数据库、迁移后健康、设置17跨重启保留、SIGTERM正常退出；非法目录、迁移冲突、端口占用均非零退出，已有数据不变，失败迁移无ledger。构建应用失败时真实Fastify清理钩子执行、数据库仍由调用方持有；OpenAPI生成不创建配置数据目录。仅移除已完成的真实数据库延后项，未改阈值或新增coverage例外。

### Issue #13 risk/evidence map (task 4.6 only)

- Public API / CLI / script entry, Config / project setup and Legacy compatibility / examples — selected: required config fields, all literals/e2e migrated, safe example and missing-variable startup exit.
- Schema / columns / units / field names and Auth / permissions / secrets — selected: canonical origin/authority, independent strict cookie boolean, explicit IP-only trust list with empty default, error messages exclude input values.
- Error handling / rollback / partial outputs and File IO / path safety / overwrite — selected: invalid config before database creation/listen; no fallback or partial startup.
- Release / packaging / dependency compatibility and Documentation / migration notes — selected: source and built runtime rejection plus healthy e2e, existing URL/net APIs, exact example/env documentation.
- Concurrency / shared state / ordering and Resource limits / large input / discovery — not selected: pure finite config parsing; no network discovery or request policy.

验证记录（#13）：URL配置41个语义失败、cookie/proxy配置30个语义失败先RED后GREEN；补充空端口边界后192 unit（87 config）/15 integration及完整检查、strict OpenSpec通过，config statements100%/branches98.3%，固定版SAST无发现。源/编译入口各验证缺失URL、相对URL、userinfo、非法cookie布尔、非法proxy均exit1且不建数据目录/不监听，凭据标记未回显；其他输入不回显由独立单元哨兵支持。e2e忽略非法继承配置仍通过schema/HTTP；CI dev启动漏传必填URL的失败在隔离副本复现，显式提供本地origin后dev:bg/status/smoke/stop均通过。合法外部HTTPS origin与独立cookie配置不改变平台HTTP监听。所有临时进程/目录清理，契约不变，尚未启用请求侧策略。

## 5. 审计写入（任务包 1.14 的写入部分）

依赖：第 4 组。

- [x] 5.1 `platform/src/audit/` 提供记录事件的函数：事件类型是一个封闭的列表（见 `audit-log` 规格“记录的事件范围”），每种类型有一份允许出现在细节里的字段白名单，白名单之外的字段被丢弃。验证：单元测试——未知事件类型被拒绝；细节里带 `password`、`token`、`cookie`、`apiKey` 字段时写入的记录里没有这些字段。
- [x] 5.2 审计查询函数：按时间倒序，按事件类型、账号邮箱（作为操作者或对象）、时间范围筛选，分页。验证：单元测试（内存库）——三种筛选各自只返回匹配的记录；分页的两页不重叠也不遗漏。
- [x] 5.3 平台日志的脱敏：Fastify 日志配置里屏蔽 `Cookie`、`Set-Cookie`、`Authorization` 请求头和响应头，以及请求体里的密码字段。验证：集成测试——带这些头和字段发请求后，捕获的日志输出里找不到它们的原文。

Suggested fixture level: expanded - 持久化记录，且承担“不落凭据”的安全要求
Minimal mergeable slice: 5.1（事件类型、白名单和写入函数，约 150 行，没有调用方时不改变平台行为）

### Issue #14 risk/evidence map (task 5.1 only)

- Public API / CLI / script entry, Schema / columns / units / field names and Auth / permissions / secrets — selected: public writer persists exact metadata and projected JSON; unknown/prototype event types and invalid stop reasons insert nothing; credentials/content and nested payloads cannot survive detail filtering.
- Error handling / rollback / partial outputs — selected: DB failures propagate; invalid input has no inserted row. Single INSERT preserves caller transaction ownership.
- File IO / path safety / overwrite and Release / packaging / dependency compatibility — selected: source/compiled public API write/reopen smoke in owned temporary file databases; reuse existing DB/migration/build behavior without new dependencies.
- Config / project setup and Documentation / migration notes — selected: narrow audit in-memory unit-test permission in platform/AGENTS.md, no file-backed unit tests or gate changes; record runtime evidence here and flag rule-file review.
- Concurrency / shared state / ordering, Resource limits / large input / discovery and Legacy compatibility / examples — not selected: synchronous one-row insert, no queries/retention/discovery, no prior audit writer or callers to migrate. Discarded detail values are not traversed.
- Evidence floor: parent-observed staged RED/GREEN, `pnpm check`, strict OpenSpec validation, source and compiled file-backed smoke; three initial review seats (correctness, test-evidence+spec-compliance, security-perf).

验证记录（#14）：写入tracer先缺模块RED后行为通过；封闭类型/凭据投影29个语义失败后GREEN。最终234 unit（42 audit）/15 integration及完整`pnpm check`通过，writer覆盖率100%。源/编译公共API实际文件写入、关闭重开后精确保留安全行，非法类型/结构化原因无新增行，settings保留且调用方事务回滚有效；临时数据库已清理。新增停止原因/DB错误/事务断言在实现后补齐，不声称这些断言单独先RED。业务调用方、查询和日志脱敏尚不在本项范围。

### Issue #15 risk/evidence map (task 5.2 only)

- Public API / CLI / script entry and Schema / columns / units / field names — selected: exact mapped row, three independent filters plus intersection, inclusive timestamps and email role union; existing schema only.
- Auth / permissions / secrets and Error handling / rollback / partial outputs — selected: bound SQL-like inputs, safe malformed-JSON errors, invalid pagination and propagated DB errors; read-only behavior. HTTP authorization remains #73.
- Concurrency / shared state / ordering and Resource limits / large input / discovery — selected: equal-time ID tie-break and fixed-dataset page completeness; safe LIMIT/OFFSET arithmetic, no table-scale discovery or concurrent snapshot guarantee.
- File IO / path safety / overwrite, Release / packaging / dependency compatibility and Documentation / migration notes — selected: source/compiled temporary-file reopen/query smoke, existing DB ownership, no migration/dependency change, evidence recorded here.
- Config / project setup and Legacy compatibility / examples — not selected: no new config or existing reader/caller to migrate. Existing audit unit-memory permission suffices.
- Evidence floor: staged RED/GREEN, `pnpm check`, strict OpenSpec and source/compiled smoke; three expanded seats (correctness, test-evidence+spec-compliance, invariant-state).

验证记录（#15）：tracer缺函数、13项筛选错误、4项分页校验/JSON错误先RED后GREEN；分页排序与DB错误传播首次即GREEN，不声称独立RED。255 unit（21 query）/15 integration及完整检查通过，query覆盖率100%；review补强同刻错误类型/邮箱及时间外干扰行，交集精确断言通过。源/编译API真实文件重开后验证同刻分页`[4,3]/[2,1]`、邮箱角色并集和包含端点；非法分页与损坏JSON拒绝，查询不改变存储，临时文件清理。额外探针验证空过滤值、零时间、安全整数上界、调用方事务和JSON原始值；HTTP授权/调用方及跨写入快照不在本项范围。

### Issue #16 risk/evidence map (task 5.3 only)

- Public API / CLI / script entry, Config / project setup, Auth / permissions / secrets and Error handling / rollback / partial outputs — selected: real HTTP credentials/body, inherited child-logger redaction at info/error levels, harmless siblings retained, HTTP values unmodified; default serializer omission explicitly separate.
- Schema / columns / units / field names and Legacy compatibility / examples — selected: exact normalized req/res paths, preserved user password/token/apiKey unit protection, default metadata/status logging and logger-level behavior.
- File IO / path safety / overwrite, Release / packaging / dependency compatibility and Documentation / migration notes — selected: captured destination, source/compiled real-server smoke, owned process/handle cleanup, existing contract/build and evidence record; no files/dependencies added by production behavior.
- Concurrency / shared state / ordering and Resource limits / large input / discovery — not selected: static redaction paths, no scheduling/retention/discovery or new payload logging.
- Evidence floor: real-TCP leak RED/GREEN; `pnpm check`, strict OpenSpec, source/compiled smoke; three expanded seats (correctness, test-evidence+spec-compliance, security-perf).

验证记录（#16）：真实TCP请求的Set-Cookie原文出现在子序列化日志中，先RED；补充四条脱敏路径后六个头字段和req.body.password在info/error日志中精确censor，安全相邻字段保留，完整输出无哨兵。255 unit/16 integration及完整检查通过；普通Fastify日志仍省略敏感容器。源/编译应用独立真实TCP探针通过，HTTP请求/响应凭据未被日志脱敏修改，app/DB关闭。只移除原单元测试中被默认序列化器丢弃的假req头断言，user凭据保护加强；未开启生产载荷日志。

## 6. 账号（任务包 1.4）

依赖：第 4、5 组。模块在 `platform/src/auth/`。

- [x] 6.1 密码模块：scrypt 哈希和恒定时间校验，长度规则 6 到 256 位；保留参考实现的版权声明。验证：单元测试——5 位被拒、6 位通过、256 位通过、257 位被拒；同一密码两次哈希结果不同但都能校验通过；错误密码校验失败。
- [x] 6.2 平台会话模块：签发（32 字节随机令牌，库里只存 SHA-256）、校验、7 天滑动续期（最后活动时间最多每分钟写一次）、按用户全部删除。验证：用可控时钟的单元测试——第 6 天活动后第 12 天仍有效；7 天无活动后失效；数据库里找不到令牌原文。
- [x] 6.3 注册接口 `POST /_platform/api/register`：邮箱去首尾空格并转小写，重复邮箱返回 409，成功后直接登录；写审计。验证：集成测试覆盖 `account-auth` 规格“邮箱加密码自助注册”和“密码规则”的全部场景，以及“首个管理员由部署命令创建”里的“注册接口不能指定角色”场景（请求体里带管理员角色字段，注册出的账号仍是员工）；`pnpm contract:check` 通过。
- [x] 6.4 登录和登出接口：登录成功下发 `HttpOnly`、`SameSite=Lax` 的 cookie（`Secure` 按配置）；邮箱不存在和密码错误返回同样的回应；被禁用的账号不能登录；登出删除当前平台会话；写审计。验证：集成测试覆盖规格“登录和登出”“平台会话 7 天滑动续期”和“平台会话令牌不被脚本读取，也不以可用形式落盘”的全部场景。
- [x] 6.5 来源地址：取直接连接的对端地址；对端在受信代理列表内时改用转发头里的客户端地址；注册和登录的审计记录这个地址。验证：集成测试覆盖规格“来源地址的确定”的两个场景，以及 `audit-log` 规格“代理之后记录真实来源”。
- [x] 6.6 登录失败限流：同一邮箱加来源地址 15 分钟内失败 10 次后返回 429。验证：用可控时钟的集成测试覆盖规格“登录失败限流”的全部场景（含另一邮箱不受影响、窗口过后恢复）。
- [x] 6.7 改密码接口：需要当前密码；成功后删除该用户的全部平台会话并为当前浏览器重新签发；写审计。验证：集成测试覆盖规格“改密码”的全部场景（另一浏览器的旧平台会话随即失效；当前密码错误时不改）。
- [x] 6.8 `Origin` 校验：所有改变状态的平台接口只接受 JSON 请求体，且 `Origin` 必须等于平台对外地址。验证：集成测试——缺少 `Origin`、`Origin` 是别的站点、请求体是表单编码，三种情况都被拒绝且状态不变（规格“改变状态的请求必须来自平台自己的页面”）。
- [x] 6.9 管理员命令 `platform/src/cli.ts`（`admin create <邮箱>`）：从终端不回显地读密码；邮箱不存在则创建管理员，已存在则提升并可选重设密码；没有终端时拒绝；写审计。验证：测试覆盖规格“首个管理员由部署命令创建”里除“注册接口不能指定角色”（由 6.3 覆盖）之外的全部场景（含非终端环境下退出码非零、参数里带密码被拒绝）。

Suggested fixture level: expanded - 认证、平台会话和公开接口
Minimal mergeable slice: 6.1 加 6.2（密码和平台会话两个模块及单元测试，约 300 行，不新增任何路由）

### Issue #17 risk/evidence map (tasks 6.1–6.2 only)

- Public API / CLI / script entry, Schema / columns / units / field names and Auth / permissions / secrets — selected: exact hash format/Unicode boundaries, real scrypt and constant-time primitive, random tokens with exact SHA-256-only storage, digest replay rejection and identity-only validation.
- Concurrency / shared state / ordering, Error handling / rollback / partial outputs and Resource limits / large input / discovery — selected: expiry before renewal, exact7day/+1ms and minute-throttle boundaries, backward-clock preservation, per-user revocation isolation; bounded encoded parameters prevent unbounded derivation. No background sweep or activity cache.
- Config / project setup, File IO / path safety / overwrite, Release / packaging / dependency compatibility and Documentation / migration notes — selected: narrow auth memory-test permission, complete reference MIT notice, real source/compiled file reopen and no credential plaintext, owned handle cleanup, existing schema/build unchanged.
- Legacy compatibility / examples — not selected: no prior platform auth API or persisted password format to migrate; reference code is algorithm guidance, not a compatibility target.
- Evidence floor: staged RED/GREEN with real crypto/SQLite and explicit clocks, `pnpm check`, strict OpenSpec, source/compiled smoke; three expanded seats (correctness, test-evidence+spec-compliance, security-perf).

验证记录（#17）：密码/会话缺API的tracer先RED；密码长度5项、会话到期/续期/撤销6项语义失败后GREEN。review实证发现Node默认UTF-8把不同孤立代理码元合并，交叉密码错误认证；固定为显式UTF-16LE单一路径和编码标识，新增交叉矩阵/独立派生记录先RED后GREEN，旧格式拒绝。296 unit（26密码/15会话）及16 integration、完整检查通过；session覆盖率100%，password statements95.83%/branches95.45%（未注入crypto运行时错误）。源/编译API文件重开验证哈希、摘要存储、续期/到期/撤销隔离，行与关闭后的主DB无密码/令牌明文；同一漏洞探针由异码元true变false，资源清理。不宣称时序测量证明恒定时间，比较使用timingSafeEqual。保留完整MIT许可，auth内存DB单测规则变更已标记人工审阅。

### Issue #18 risk/evidence map (task 6.3 only)

- Public API / CLI / script entry, Schema / columns / units / field names, Config / project setup and Legacy compatibility / examples — selected: reachable POST201/400/409/500 schemas, generated contract, strict raw types before Ajv coercion, Unicode password bounds, normalized email and existing health/logger/app lifetime preserved.
- Auth / permissions / secrets — selected: supplied role ignored, employee/active hardcoded, HttpOnly/SameSite/conditional Secure cookie only after commit, real hash/digest-only persistence, safe audit/response/log fields; no HTTP token in JSON.
- Concurrency / shared state / ordering and Error handling / rollback / partial outputs — selected: concurrent normalized duplicate exactly one winner; user/session/audit atomic rollback on injected DB failure, no cookie on failure; unrelated errors not409.
- File IO / path safety / overwrite, Release / packaging / dependency compatibility and Documentation / migration notes — selected: source/compiled owned file-backed HTTP smoke, reopen assertions, cleanup, no dependency/migration; evidence recorded here.
- Resource limits / large input / discovery — selected: existing Fastify body limit and canonical bounded password derivation; no new registration cap/domain restriction/rate limiter (separate tasks).
- Evidence floor: staged RED/GREEN, real-TCP named scenarios, `pnpm check`, `pnpm contract:write`/check, strict OpenSpec and source/compiled smoke; three expanded seats (correctness, test-evidence+spec-compliance, security-perf).

验证记录（#18）：缺路由404 tracer先RED，原始类型/Ajv转换和非法邮箱10项unit、2项TCP失败后GREEN；323 unit/21 integration和完整检查通过，registration覆盖率100%。review补强HTTP边界密码原文验证及cookie精确绑定；额外探针发现callback插件同步prepare异常逃逸，改走done(error)后buildApp拒绝且保留调用方DB，源/编译均通过。共享测试fixture消除复制，未放宽重复率阈值。源/编译真实文件HTTP验证201/400/409、并发赢家、注入500全回滚、重开哈希/摘要/审计和限定明文扫描；额外验证原型/坏JSON/大请求、ID碰撞和crypto失败。e2e健康/迁移通过；契约仅增加注册路径。代理信任、Origin、登录登出和UI为后续项。

### Issue #19 risk/evidence map (task 6.4 only)

- Public API / CLI / script entry, Schema / columns / units / field names, Config / project setup and Legacy compatibility / examples — selected: generated login/logout schemas, unchanged registration contract, shared normalized credentials/cookie policy, current account identity and configured Secure mode.
- Auth / permissions / secrets and Error handling / rollback / partial outputs — selected: uniform unknown/wrong401, verified disabled403, dummy derivation, malformed/digest cookie rejection, safe login/logout audits, no plaintext/credential JSON, session/audit rollback and plugin-construction failure propagation.
- Concurrency / shared state / ordering and Resource limits / large input / discovery — selected: recheck status/password after async verification, multiple-browser logout isolation, expiry before renewal and minute throttling; retained disabled-session logout at elapsed>=60,000ms returns401 with full row snapshot unchanged, no audit/cookie. Existing input/crypto bounds, no rate-limit or cache addition.
- File IO / path safety / overwrite, Release / packaging / dependency compatibility and Documentation / migration notes — selected: source/compiled real-TCP file-backed reopen/login/logout proof, owned cleanup, unchanged dependencies/schema and full checks.
- Evidence floor: real-TCP named login/session/cookie scenarios through canonical recognition (test-only protected route), staged RED/GREEN, `pnpm check`, generated-contract check, strict OpenSpec, source/compiled smoke; three expanded seats (correctness, test-evidence+spec-compliance, security-perf).

验证记录（#19）：登录404 tracer、3项真实scrypt回调屏障竞态、16项登出/识别/解析失败先RED后GREEN；352 unit/28 integration（7项真实TCP认证）及完整检查通过。共用凭据/cookie与测试fixture，重复率4.06%→2.73%，旧实现删除无别名。源/编译文件DB真实HTTP验证统一401/禁用403、day6/day12、摘要/重复cookie拒绝、禁用不续期、登出审计失败回滚和单浏览器撤销，重开身份与限定明文扫描通过；没有生产身份查询接口。契约仅新增login/logout，注册/健康不变；e2e迁移/健康通过。其它新验收断言首次GREEN如实保留，未宣称全部独立RED。

Review 修复（#19）：新增未知邮箱有效长度密码的真实 scrypt 回调屏障断言；跳过 dummy 派生的独立副本变体仅该用例失败（352 pass / 1 fail），正常实现 353 unit / 28 integration 及完整检查通过。复用失败审计断言后重复率 2.60%，未改阈值。超长邮箱累积存储风险独立跟踪 #126；本切片不改变既有邮箱兼容契约。

第二轮修复（#19）：保留真实过期会话的登出用例返回 401、无 cookie/审计且完整状态不变，另一浏览器仍可用。独立副本跳过过期判断时，该登出用例与已有过期原语用例均失败（352 pass / 2 fail）；正常实现 354 unit / 28 integration 及完整检查通过，重复率 2.58%。两轮修复均未改生产行为。

### Issue #20 risk/evidence map (task 6.5 only)

- Public API / CLI / script entry, Config / project setup, Auth / permissions / secrets — selected: existing trustedProxies config drives one source resolver; adversarial XFF trust-chain matrix and real-TCP registration/login/logout audit rows prove attribution, no global Host/protocol trust.
- Schema / columns / units / field names, Legacy compatibility / examples — selected: canonical IP text in existing source_address only; no schema or HTTP contract changes. Existing credentials/cookies/audit atomicity remain covered by full regression and contract check.
- Resource limits / large input / discovery, Error handling / rollback / partial outputs — selected: existing HTTP header bounds, no DNS/dependencies; malformed relevant forwarding data falls back to peer without content echo, irrelevant attacker prefix cannot affect selected identity. Literal/mapped IPv6 cases exercise native parsing.
- Release / packaging / dependency compatibility, File IO / path safety / overwrite — selected only for source/compiled owned file-DB TCP smoke and reopen/cleanup; no production file-path change or dependency. Documentation / migration notes — selected: Issue #20 design records supported header, safe fallback, deployment assumption and unchanged history.
- Concurrency / shared state / ordering — not selected: immutable per-app trust configuration, no new asynchronous/shared state; existing auth race/transaction tests retained.
- Evidence floor: staged trusted-registration semantic RED/GREEN, resolver boundary matrix, named real-TCP two-client sequence with actual audit sources (rate-limit enforcement remains #21), source/compiled smoke, pnpm check, strict OpenSpec. Three expanded seats; no new production endpoint.

验证记录（#20）：真实 TCP 注册先得到错误的对端地址（28 pass / 1 fail），接入统一 resolver 后通过。父进程发现受信链最左空项被漏过，回归先 RED（375 pass / 1 fail）后修复。有效非映射 IPv6 `::ffff:0:127.0.0.1` 不属于非法输入，按原生解析结果修正错误测试分类并保留不混同 IPv4 的断言。最终 `pnpm fmt && pnpm check`：376 unit / 35 integration，重复率 2.45%，契约未变。源/编译真实 TCP 文件库验证注册、十次失败、另一来源登录/登出、映射规范化、伪造链/无效头回退、其它头忽略和重开持久；e2e 健康/迁移通过。未宣称已实现 #21 的限流。

Review 修复（#20）：原生规范化丢弃 IPv6 zone，父进程确认 `%eth0` 配置错误信任 `%eth1`/无 scope 对端。新增六项语义失败后改为保留 scope 的单一规范地址集合；不拒绝已接受配置，不把 scoped mapped IPv6 造成为无效的 IPv4%zone。受信遍历中的 scoped XFF 安全回退，未受信边界左侧仍忽略。补齐受信代理下的真实密码验证竞态失败审计和冲突转发头优先级。最终 384 unit / 36 integration、完整检查及源/编译 scope 边界与真实 TCP 文件库 smoke 通过（2.54% 重复率）；scope 证据不宣称真实跨网卡利用或部署验证。

### Issue #21 risk/evidence map (task 6.6 only)

- Public API / CLI / script entry, Schema / columns / units / field names, Auth / permissions / secrets — selected: exact429 contract, safe failure audit and no cookie/session; normalized-email plus canonical-source isolation, unknown/wrong/disabled/recheck counting and no secret echo.
- Concurrency / shared state / ordering — selected: per-app window state, exact900000ms expiry, no success reset or blocked extension; real-scrypt overlap proves no lost failures and no held success after threshold. Restart clears only limiter state.
- Error handling / rollback / partial outputs — selected: validation400/internal500 do not count; failed audit/session persistence retains rollback;429 audit failure does not clear a live limit. Existing sessions remain valid.
- Resource limits / large input / discovery — selected: pre-derivation rejection after threshold, bounded stale-entry lifetime with opportunistic cleanup and no per-key timers/live-key eviction. Global active-key quotas and #126 email compatibility are explicit non-goals.
- Config / project setup, Legacy compatibility / examples, Documentation / migration notes — selected only for existing app/plugin/test-clock integration, unchanged configuration and documented window interpretation; no new env, dependency, state schema or compatibility shim.
- Release / packaging / dependency compatibility, File IO / path safety / overwrite — selected for source/compiled owned file-DB realHTTP recovery/restart smoke and cleanup; no production filesystem changes.
- Evidence floor: parent semantic tracer RED, controlled-Date realTCP scenarios and crypto overlap oracle, full checks plus contract generation, strict OpenSpec, source/compiled smoke. Three expanded seats; implementation may not weaken this fixture to clear a finding.

验证记录（#21）：真实 TCP tracer 在实现前得到200而非429（36 pass / 1 fail），实现后通过。补充 Date-only 时钟、真实 scrypt 回调屏障、错误计数/回滚断言后，`pnpm fmt && pnpm check` 402 unit / 41 integration 全部通过，重复率2.48%；429 契约由生成器更新。源/编译真实 TCP 文件库证明10次失败后的429、邮箱/映射IP别名同键、另一来源成功、精确900000ms恢复及重开应用清空限流而保留账号/会话/审计；原生 Map 构造观察证明无关过期键回收、扫除节奏与活跃限额保留，无生产观测API。e2e健康/迁移通过。补充断言首次GREEN如实保留，不宣称全部独立RED。

Review 修复（#21）：恢复改写竞态用例遗漏的完整失败审计元数据、无成功事件及用户/会话/审计总量断言；400 不计数改用同一邮箱/来源的非字符串密码，避免换键导致弱判据。完整检查仍402 unit / 41 integration通过。源/编译 smoke 改为真实独立 Node 子进程重开文件库，先验证原会话/审计完全保留，再证明原被限流凭据登录200、原 cookie 经真实HTTP登出204；429 审计逐字段断言时间、规范邮箱/来源、空目标和空细节。此前“全部旧断言保留”描述不准确，已按 review 恢复，不改生产行为。

### Issue #22 risk/evidence map (task 6.7 only)

- Public API / CLI / script entry, Schema / columns / units / field names, Auth / permissions / secrets — selected: declared change-password204/400/401/500 contract, raw current/new fields, Unicode identity, cookie-only actor, old-token revocation/fresh-cookie recognition and exact safe audit/redaction.
- Concurrency / shared state / ordering — selected: initial read-only recognition plus post-crypto transaction recheck; real-scrypt held revocation/competing rotation and disabled/expired/hash-change siblings; no mutex or long DB transaction.
- Error handling / rollback / partial outputs — selected: failure snapshots include activity timestamps; real SQL faults prove hash/revocation/reissue/audit atomicity and retry, with no success cookie/event on error.
- Legacy compatibility / examples, Config / project setup — selected: preserve renewal defaults and all existing auth/logger callers; existing cookieSecure/trustedProxies reused, no new configuration or interface alias.
- Resource limits / large input / discovery — selected: canonical bounded password derivation and existing HTTP bounds; no crypto for missing identity, no new limiter/global quota. Release / packaging / dependency compatibility and File IO / path safety / overwrite — selected only for owned source/compiled file-DB HTTP/reopen/cleanup proof; no production filesystem or dependency change.
- Documentation / migration notes — selected: route/error/atomicity/secrecy boundary documented here; no schema/data migration. Evidence floor: staged tracer RED, controlled real-crypto/SQLite failure oracles, actualTCP named scenarios/logger redaction, full checks/contract/strictOpenSpec and source/compiled smoke; three expanded seats.
- Fixture revision: phase-specific crypto errors (verification and replacement hashing) preserve full state/no cookie/no secrets; one real replacement-hash callback barrier proves revocation or competing rotation wins after the final crypto await, not merely during initial verification.

验证记录（#22）：真实 TCP tracer404→204先RED后GREEN；最终 `pnpm fmt && pnpm check` 419 unit / 80 integration通过，重复率2.69%，新路由契约由生成器更新。真实 scrypt 两阶段故障/回调屏障、SQL四写入阶段回滚与重试、>=60s失败不续期、Unicode身份、旧浏览器撤销/其他账号隔离、限流保持及新字段实际logger脱敏均有断言。源/编译文件库真实HTTP证明旋转、审计失败原子回滚、cookie及完整审计元数据、限定磁盘/日志扫描、重开后新cookie可用和新旧密码区分；真实prepare初始化错误正常reject且调用方DB可用；e2e健康/迁移通过。补充断言首次GREEN如实保留；共享真实crypto测试helper未改变旧断言。

### Issue #23 risk/evidence map (task 6.8 only)

- Public API / CLI / script entry, Auth / permissions / secrets, Schema / columns / units / field names — selected: all four platform mutations enforce exact configured Origin and JSON before effects;403/415 and logout JSON/Origin contract generated, full-state/no-cookie rejection matrix.
- Config / project setup, Legacy compatibility / examples — selected: existing publicUrl reused, every positive mutation caller migrated without guard bypass; safe/non-platform requests preserved; future platform method inheritance and raw physical duplicate-Origin proof.
- Error handling / rollback / partial outputs, Concurrency / shared state / ordering — selected for early-hook ordering before parsing/crypto/session renewal/audit/limiter; invalid traffic cannot alter existing nine-failure count or>=60s activity; existing async auth race/rollback tests remain unchanged in meaning.
- Resource limits / large input / discovery — selected: reject before body parsing/crypto; existing header/body limits retained, no repeated URL normalization or CORS/token dependency. File IO / path safety / overwrite and Release / packaging / dependency compatibility — selected only for owned source/compiled file-DB HTTP smoke/reopen/cleanup, no production path/dependency changes.
- Documentation / migration notes — selected: intentional Origin/JSON/logout caller cutover documented, WebSocket/DSH boundary explicit. Evidence floor: tracer RED, realTCP adversarial Origin/media matrix with full state, all positive flows/regressions, generated contract, strictOpenSpec and source/compiled smoke; three expanded seats.
- Fixture revision: paired invalid-Origin+malformed-JSON/unsupported-media requests prove403 precedes400/415; after nine failures and guard-rejected traffic, valid wrong-password401 followed by correct-password429 proves the limiter was neither incremented nor reset.

验证记录（#23）：真实TCP无Origin注册201→403先RED后GREEN，正向调用统一迁移Origin/JSON，登出显式`{}`。最终`pnpm check`449 unit/87 integration通过，重复率2.93%；契约生成/校验通过。完整状态矩阵、解析前403优先级、物理重复头、未来方法继承、安全/非平台豁免、拒绝前无crypto及九次失败后401→429判据通过。原始Node头数组缺Host导致传输层400，经独立探针确认后修测试传输，不改403要求；有效429照旧新增失败审计，修正了误要求审计不变的新判据。源/编译真实TCP文件库四路由拒绝无副作用、JSON charset正向流程、重复头和重开仍执行边界通过；e2e健康/迁移通过。补充断言首次GREEN，不宣称每条独立RED。

### Issue #24 risk/evidence map (task 6.9 only)

- Public API / CLI / script entry, Auth / permissions / secrets — selected: strict admin/create/email args, TTY-only hidden double input, no argument/env credential path, administrator identity/promotion/reset and safe audit; real source/compiled PTY and HTTP login proof.
- Schema / columns / units / field names, Legacy compatibility / examples — selected: canonical email/id/password extraction preserves registration; existing rows/status/creation time/sessions preserved unless reset; NULL deployment actor/source and existing audit identifiers, no migration.
- Concurrency / shared state / ordering, Error handling / rollback / partial outputs — selected: prompt/hash outside transaction, snapshot recheck and atomic role/password/revocation/audits, cancellation no late commit, SQL faults and terminal restoration; no retries.
- Resource limits / large input / discovery, File IO / path safety / overwrite — selected: canonical password bounds, owned database/TTY/listener cleanup, no unexpected dump/secret echo; data path ownership/config reused. No global account quotas or untrusted network terminal service.
- Config / project setup, Release / packaging / dependency compatibility, Documentation / migration notes — selected: source/compiled CLI entry, root cli/test:cli scripts and verification matrix/constraints, Python3 standard-library PTY prerequisite for tests, no production dependency/schema change; flag rule-file review for Epic-end human review.
- Evidence floor: staged parent RED/GREEN with actual command failures classified separately from bootstrap/missing-entrypoint errors, real PTY hidden-input/echo restoration/cancel, real DB mutation/rollback/concurrency and source/compiled CLI-to-HTTP smoke, full checks/strictOpenSpec. Three expanded seats; admin UI is later scope, not fake acceptance.

验证记录（#24）：`pnpm check`通过522 unit/106 integration，含19条CLI实际进程测试，重复率2.89%；源/编译CLI真实PTY创建管理员、HTTP登录、重设后旧密码及旧cookie均401、新密码管理员登录200；真实scrypt回调挂起后SIGTERM退出1，完整users/sessions/audits不变，终端模式恢复且输入未泄露。独立复制产物的echo故障使泄漏判据变红，恢复后变绿。最初缺入口只记bootstrap RED，不冒充行为TDD；输入error经readline转发导致未处理异常的单测先RED后GREEN。PTY不获取控制终端，避免macOS会话退出撤销终端；257码点PTY边界使用混合字符，纯astral计数边界保留于单测。过程曾触发三轮复查限制，用户明确追加修复授权后才继续；未降低门禁。规则文件的CLI内存库单测许可及Python3/命令验证矩阵加入Epic末人工审查。

Review修复（#24）：确认普通pnpm包装器在Node校验前打印被拒绝的密码参数；源码支持命令改为显式`pnpm --silent cli admin create <email>`，不修改全局日志配置。真实钉定pnpm的两种密码参数拒绝均非零、无回显且无数据创建，PTY创建/隐藏输入/恢复/HTTP管理员登录通过。完整检查522 unit/109 integration（22条CLI）通过，重复率2.87%；源/编译smoke复跑通过。命令文档检查器识别`--silent`；独立夹具证明存在命令通过、不存在命令拒绝。共享创建/参数测试按启动器参数化，保留全部断言并将原密码空白及环境哨兵判据扩展到包装器。

## 7. 完整用户镜像（任务包 1.5）

依赖：第 1 组；7.3 起依赖第 3 组。

- [x] 7.1 加入 `pnpm test:docker` 入口（`package.json`、`AGENTS.md` 验证矩阵、CI 任务），在 giap-vps 上按 `.tool-versions` 装好 Node 和 pnpm（装在 ubuntu 用户目录下，不动系统包）；带第一个用例：构建用户镜像，容器里 `dsh --version` 输出钉定版本。验证：`pnpm test:docker` 通过且结束后没有带 `dsh-team-test` 前缀的资源；`pnpm lint:agents` 通过。
- [x] 7.2 镜像里装 Python 3 和 `python-docx`。验证：`pnpm test:docker`——在断开网络的容器里运行一段生成 DOCX 的脚本，产物能被解析库打开。
- [x] 7.3 按第 3 组的结论在镜像里预置 `$DSH_HOME/profiles/`，并把整个 `profiles/` 目录原样拷贝到 `/opt/dsh-team/profile-seed/`（层级相同，只读）。验证：`pnpm test:docker`——空状态卷首次启动后卷里的 `profiles/` 与 `profile-seed/` 逐文件一致；改动卷里的 `profiles/` 后镜像里的 `profile-seed/` 不变。
- [x] 7.4 镜像启动验证：用一份手写的最小覆盖层和第 1 组的安全设置启动容器。验证：`pnpm test:docker`——60 秒内日志里出现令牌行、3080 可连接；不带 cookie 请求首页得到 401；DSH 进程用户不是 root；进程环境里有关闭遥测的变量；状态目录和工作目录是两个挂载点。

Suggested fixture level: expanded - 用户镜像是关键路径，决定每个实例的运行环境
Minimal mergeable slice: 7.1（测试入口和一个用例，约 120 行，不依赖第 3 组的结论，不改镜像）

### Issue #25 risk/evidence map (task 7.1 only)

- Public API / script entry, Config / project setup, Release / packaging — selected: `pnpm test:docker` discovery separate from check/coverage; pinned user-home Node/pnpm on giap-vps; actual build and exact DSH version; existing commands unaffected.
- File IO / overwrite, Concurrency / shared state, Error handling / partial outputs — selected: invocation-unique resources, exact cleanup on success/induced failure, timeout and cleanup error nonzero, unrelated sentinel preserved; no global Docker prune.
- Auth / permissions / secrets, Schema / field identity — selected: trusted-session reviewed-SHA admission; no VPS credential in public CI; owner-only latest exact-SHA success status; squash tree-equivalence binding; wrong/missing/failed/publisher/latest-status/mismatched-tree gate fixtures.
- Resource limits — selected for bounded Docker subprocess/test duration and run cleanup, not production container quotas. Legacy compatibility and Documentation — selected: root scripts/CI aggregator/command validation preserved, rule and workflow changes disclosed; no image behavior change.
- Evidence sequence: fixture review/strict validate; local discovery/gate-negative checks and full `pnpm check`; initial three-seat full-candidate review before admitting remote code; trusted parent exact-SHA VPS run plus failure/cleanup proof; finish evidence adjudication and publish dedicated status only after reviewed candidate passes. Any source fix invalidates admission/evidence and requires appropriate re-review. CI verifies evidence and is rerun explicitly after status publication; no missing-evidence skip.
- User decision: “仅授权审查后的提交” authorizes this controlled external evidence path, not a persistent runner or broader shared-host access. Main squash CI must establish tree-equivalent reuse explicitly. Docker/CI evidence belongs in PR runtime section; human rule/workflow review remains deferred to Epic completion.

验证记录（#25）：三席对`489556aeb04b9f9d044c44e53868773e13332244`代码准入审查无阻塞后，可信会话在giap-vps检出完全相同提交；用户目录Node24.13.1/pnpm10.34.6执行`pnpm test:docker`，真实构建/容器输出精确`0.2.0-rc.2`。独立检查成功、诱导版本断言失败后均无本次资源；独立哨兵容器/镜像/卷/网络不变，最后由其所有者删除。真实`docker start --attach`200ms超时返回ETIMEDOUT，原容器仍运行时进入清理，清理后容器不存在、镜像已移除、哨兵保留；专用42退出区分预期超时与探针自身断言失败。不宣称构建器整个进程树或SIGKILL恢复已验证。本地`pnpm check`522 unit/164 integration通过，重复率2.74%；真实GitHub缺状态拒绝和CI缺证据失败已观察。最终精确头状态、CI复跑及合并树等价结果记录在PR运行证据，不用旧SHA冒充新SHA直接执行。

### Issue #26 risk/evidence map (task 7.2 only)

- Release / packaging / dependency compatibility, Config / project setup — selected: distro Python3/python-docx in unchanged apt layer; existing DSH pin and user environment preserved; complete Docker suite on giap-vps.
- Public API / script entry, Schema / content fields — selected: Python save/reopen yields exact Chinese paragraph/table contents; actual `--network none` configuration inspected independently. Invalid content is rejected, not merely nonempty file/ZIP.
- Auth / permissions / secrets, File IO / path safety, Concurrency / shared state, Error handling / partial outputs — selected: normal uid1001 writes container workspace, no host mounts/credentials, canonical invocation ownership/cleanup/error tests retained and no leftover resources.
- Resource limits — selected only for existing bounded test/subprocess cleanup; no production resource policy. Legacy compatibility — selected for canonical helper clean cutover, all original version/ownership/failure assertions retained. Documentation — selected for image capability and critical-path deferred human review.
- Sequence: fixture review/strict validate; test-only helper/scenario commit and read-only admission before real image-capability RED; add packages; local check; expanded three-seat full final-candidate admission; exact-head real Docker GREEN/readback/cleanup; owner status and CI; merge. No local Docker, no unreviewed remote source or model call.

验证记录（#26）：test-first审查提交`8a08ed7`在giap-vps真实RED（DSH版本通过、缺Python导致DOCX失败），清理后无本次资源；加入Debian包后，三席准入审查的`3184920`实际`pnpm test:docker`两条通过，网络模式none、默认用户dsh、有效uid1001，保存后重新解析的中文段落及表格内容精确匹配，独立资源清点为空。本地`pnpm check`522 unit/172 integration通过，重复率2.84%；旧版本/清理所有权断言全部保留。一次外层SSH1200秒超时丢失诊断，仅记不确定结果；未改代码或内部时限，改为远端持久日志/退出文件后取得上述15.74秒GREEN，不冒称已诊断前次超时根因。最终精确SHA实测与CI证明保留于PR，镜像关键路径人工逐行审查按用户要求后置。

### Issue #27 risk/evidence map (task 7.3 only)

- Release / packaging, Config / project setup, Public script entry — selected: release-owned boot-free profile initialization, exact plugin peer pin/artifact bytes, named context migrated across all four builders; existing image versions/DOCX/probes preserved.
- File IO / path safety / overwrite, Auth / permissions, Schema / layout — selected: real named-volume first-copy byte/path equality with meaningful required entries; writable uid1001 live profiles and root-owned non-writable seed files/parents; write/replacement denial, no Session/workspace/secret seed.
- Concurrency / shared state, Error handling / partial outputs, Resource limits — selected: unique owned volume/container/image lifecycle, volume reuse preserves edits without resetting, independent cleanup including failure, wrong-label resources never removed, bounded operations.
- Legacy compatibility / examples, Documentation — selected: canonical helper and all build caller clean cutover, no duplicated plugin/YAML/init implementation; document named-context requirement and critical-path deferred human review.
- Evidence sequence follows #26: reviewed test-first exact SHA actual unseeded-image RED; image/caller implementation; local gates; expanded three-seat admission; real final-SHA volume/seed GREEN and independent inventories; owner status/CI/merge. Browser/server initialization, office presets, managed overlay and workspace registration are explicit later-slice non-goals.

验证记录（#27）：审查后test-first`58e90ba`在真实VPS为2通过/1失败（缺少profile-seed），修改镜像后审查提交`610c5d5`三条全部通过；本地`pnpm check`522 unit/216 integration通过，重复率2.67%。独立真实Docker探针保留两次容器的实际imageID、volume/mount/user/network检查及fresh/reuse完整JSON：初次树/字节相同、四插件hash与仓库一致、uid1001 live修改持久，种子四种写/删/替换均EACCES且hash不变。版本断言、seed断言、实际创建volume后报错、实际创建container后报错四类失败均保留原因并清理；独立哨兵四种资源始终保留，最后由所有者删除，独立清点为空。迁移后的`pnpm probe:sandbox`真实通过Docker默认策略工作区可写/状态目录拒写；未声称重跑需要浏览器/模型的另两探针。最终精确SHA实测/状态/CI保留于PR，关键路径人工审查后置。

### Issue #28 risk/evidence map (task 7.4 only)

- Public API / CLI / script entry — selected: `pnpm test:docker` adds actual released Web launch; host-side unauthenticated HTTP401 within the same60s deadline as the genuine token line.
- Config / project setup; Release / packaging / dependency compatibility — selected: literal minimal readonly overlay, existing narrow build contexts and pinned DSH, explicit shipped seccomp; inspect actual security/port configuration.
- File IO / path safety / overwrite; Schema / columns / units / field names — selected: actual distinct owned named-volume mount identities at `/data/home` and `/data/work`, readonly overlay; parse selected process UID/environment and Docker boundary data, reject malformed/missing observations.
- Auth / permissions / secrets — selected: actual DSH nonroot process, telemetry-disabled environment, HTTP401 without credentials, loopback-only publication; launch token/raw logs never emitted even on failure.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: one monotonic60s startup deadline, bounded observations and early-exit detection; unique exact-owned resources and Docker-assigned ephemeral port avoid cross-run collisions.
- Error handling / rollback / partial outputs — selected: retain existing lifecycle regressions; real success and induced Web assertion failure clean only owned resources, independent inventory and foreign sentinels prove boundary; no claim of cleanup after host/process death.
- Documentation / migration notes — selected: record runtime command/results, platform limits, trusted exact-head evidence and Epic-end human white-box deferral. `pnpm check` and strict OpenSpec must pass.
- Legacy compatibility / examples — not selected: no legacy API migration; all three existing Docker cases, named-context builder consumers and cleanup invariants must remain unchanged.
- Oracle qualification: known-good observations and discriminating missing token/early exit/deadline/HTTP200/root/missing telemetry/wrong or shared mount cases; real baseline may be GREEN because task7.4 verifies existing image behavior. No fabricated semantic RED from import/setup failure.

验证记录（#28）：初始审查提交`05492ce`真实Docker四条通过，但补充探针捕获启动公告前HTTP404，不能用偶发GREEN掩盖此时序缺陷。新增确定性回归先以401断言失败，再将HTTP验收顺序移到真实公告之后；仍使用启动前建立的同一60秒期限，不特判404、不放宽公告后的401要求。修复审查提交`dc3ae1b`在giap-vps根`pnpm test:docker`四条通过，Web令牌/HTTP401于1985ms就绪，实际DSH为PID1、uid1001且遥测关闭；本地`pnpm check`522unit/255integration通过、重复率2.61%。独立补充探针的成功及验收后人为断言失败均清理本次资源并保留四类外部哨兵，所有者最后删除哨兵并恢复初始清点；记录的是实际Dockerinspect响应截获与fixture选定进程摘要，不冒充第二套独立进程识别器。完整脱敏证据、最终精确SHA复验和CI状态见PR#135；Ubuntu22.04、浏览器/模型和进程被强杀后的清理未验证，关键路径人工白盒审查按用户决定后置到Epic结束。

## 8. 受管覆盖层（任务包 1.6）

依赖：第 3、4 组；8.4 起依赖第 7 组。模块在 `platform/src/managed-config/`。

- [x] 8.1 生成函数：输入模型设置和默认权限档，输出覆盖层内容（监听地址、OpenAI 兼容 provider、密钥所在环境变量名、模型清单、带上下文窗口的模型写出 `contextWindow`、默认模型、去掉每个预设的联网搜索和网页抓取、界面语言和关闭公告）。纯函数，不做文件操作。验证：单元测试——输出里没有密钥原文，只有环境变量名；联网工具不在任何预设的工具清单里；配置了上下文窗口的模型有 `contextWindow`，没配置的没有。
- [x] 8.2 覆盖层写入：整份写入临时文件后原子改名，文件权限只读；目录由配置项指定（加进 `config.ts` 和 `.env.example`）；路径由用户标识拼出，标识不合规时拒绝。验证：单元测试（临时目录）——并发写两次后文件是其中一份完整内容，不是混合；写入中途失败时旧文件不变；带 `../` 的标识被拒绝（规格“覆盖层整份生成”）。
- [x] 8.3 模型地址、密钥、清单、默认模型任一项未配置时，生成函数返回“未配置模型”，不产出覆盖层。验证：单元测试——四项各缺一项时都返回该结果。
- [x] 8.4 在真实 DSH 上验证受管值不可覆盖：启动实例，在用户自己的配置目录里写入另一个模型地址和联网工具后重启。验证：`pnpm test:docker`——DSH 合成后的配置里模型地址仍是受管值，工具清单里仍没有联网工具，配置了上下文窗口的模型生效值等于配置值（规格“员工不能覆盖受管配置”“去掉联网工具”和“模型的上下文窗口”场景）。
      Task8.4 additionally owns the `managed-config` complete-composition/canonical-artifact input adapter: include non-default, user-added/custom and later office presets, independently compare effective roster versus transformed coverage after edits/restart, and add a preset containing a renamed nested network component. Prove editing the user-writable locale-patch copy cannot change trusted canonical policy. Retain actual fresh non-loopback/English-navigator and reload observations for Chinese/no-notice/editable composer, model selection and General settings; do not substitute shipped-roster-only or text-shape proof. Qualify the adapter through the Docker test boundary before task9.3 production wiring.
- [x] 8.5 模型地址不可达时的行为：把模型地址指向一个拒绝连接的地址，另起一个记录请求的替身服务作为“别的地址”写进用户自己的配置。验证：`pnpm test:docker`——发一条消息后 Session 里出现错误，替身服务没有收到任何请求（规格“模型不可用时明确报错”）。

Suggested fixture level: expanded - 写文件、路径安全，且承载模型密钥相关的生产配置
Minimal mergeable slice: 8.1（纯生成函数和单元测试，约 150 行，没有调用方）

### Issue #29 risk/evidence map (task 8.1 only)

- Public API / CLI / script entry; Config / project setup — selected: public pure generator returns one parseable complete patch document; source and compiled smoke; `pnpm check` and strict OpenSpec.
- Schema / columns / units / field names; Release / packaging / dependency compatibility — selected: published0.2.0-rc.2 schemas/composer, whole-config replacement, exact provider/default/contextWindow behavior, canonical locale rows as trusted input rather than a copied implementation.
- Auth / permissions / secrets — selected: credential reference only, no actual key input/output; resolved permission configuration preserved without premature tier mapping; remove released network-tool component from every supplied preset, including nested groups and renamed component IDs.
- Concurrency / shared state / ordering — selected: deterministic order and no mutation under frozen inputs; no shared mutable cache or environment-dependent output.
- Resource limits / large input / discovery — selected: one bounded-by-input traversal of complete preset entry trees; do not traverse arbitrary plugin config; no hard-coded preset count. Runtime roster completeness is the consumer contract exercised in task8.4, not claimed from one fixture.
- Legacy compatibility / examples; Documentation / migration notes — selected: preserve all non-network plugins/preset metadata, exact canonical UI composition and all existing probe/image callers; document purity, complete-composition ownership and permission-mapping deferral.
- File IO / path safety / overwrite; Error handling / rollback / partial outputs — not selected for this pure slice: no filesystem, publication, persistence or partial output; writer/path/atomicity is task8.2, incomplete-model result task8.3.
- Required proof: staged behavior RED/GREEN; effective released-parser/composer smoke with real shipped preset/locale data, synthetic credential-free settings and source/dist equivalence; three expanded review seats and trusted exact-head Docker/CI baseline remain required before merge.

验证记录（#29）：模型、预设策略、完整组成三条路径均由parent先观察语义RED再实现；纯生成器五例通过，`pnpm check`527unit/255integration、generator100%覆盖、重复率2.68%。初次真实发行版composer拒绝错误目标`permission-presets`；发布包dsh-base声明的实际row为`permission`，修正契约断言先RED、再修目标，未忽略warning或另插权限插件。审查修复提交`3928004`在giap-vps以真实0.2.0-rc.2 `loadOverlayPatches`/`composeEntries`执行source与dist生成结果，字节相同、零warning，provider/default/可选contextWindow/完整权限配置及canonical中文roster生效于合成结果。四个实际预设standard/ptc/minimal/cordis的联网组件分别1/1/0/1变为0/0/0/0，非联网叶插件28/29/6/29及配置元数据保持；独立清点无测试资源残留。同提交`pnpm test:docker`四例通过。此为离线合成证明，不冒充插件激活、模型请求、浏览器UI、用户修改后生产roster完整性或默认权限档映射；后续责任见task8.4/9.3/16.1–16.2。最终精确SHA复验和CI证据见PR#136。

### Issue #30 risk/evidence map (task 8.2 only)

- Public API / CLI / script entry; Config / project setup — selected: public async writer/path return, configured absolute directory, invalid-env fail-loud, every typed consumer migrated; source/dist smoke and `pnpm check`.
- File IO / path safety / overwrite; Schema / columns / units / field names — selected: exact12lowercasealnum ID rejection with zero filesystem calls, stable per-user filename, same-directory exclusive temp/rename, UTF-8 exact readback and0444mode, symlink-target and unrelated-user preservation.
- Auth / permissions / secrets — selected: real missing-root0700/held-temp0600/final0444 observations and unchanged existing ancestor modes; no document logging or actual credential; no claim against hostile parent replacement.
- Concurrency / shared state / ordering — selected: deterministic overlapping writes/reads and failure while a sibling temp is held; complete last-successful publication, no mixed content, held file/foreign sentinel preserved. Forced exclusive-create collision preserves preexisting bytes/mode and old destination.
- Error handling / rollback / partial outputs — selected: actual partial-write,chmod,close,rename faults preserve old bytes/mode or initial absence; combined cleanup error retains both distinct causes, closes handles and deletes only owned temp. Controlled child must reach a real prepublication checkpoint before termination; old target preserved without claiming crash-temp cleanup.
- Release / packaging / dependency compatibility; Legacy compatibility / examples — selected: source/dist public APIs, existing filesystem test conventions, all config literals and `.env.example`; no dependency or generated OpenAPI changes.
- Documentation / migration notes — selected: writer/config contracts, trusted-directory and process-death limits, inode replacement caveat for9.3/15.3; strict OpenSpec, updated evidence after smoke.
- Resource limits / large input / discovery — not selected: content is the already-generated bounded-by-configuration string, no new discovery/pagination/quota policy or input-driven recursion. Existing whole-document allocation belongs to generation; no redundant parse/copy in the writer.

验证记录（#30，本地候选）：parent先观察缺失文件的发布RED、cleanup错误丢失的语义RED、配置缺失/不拒绝非法值的RED，再完成实现。`pnpm check`557unit/255integration通过，writer24例、行97.56%/分支93.75%；重复率原始510/17013行低于3%（显示四舍五入3.00%），门禁未改。真实source/dist临时目录smoke分别观察4/5次并发读，均为完整旧/新版本；模式root0700/temp0600/final0444、UTF-8内容、路径及既有父目录模式正确。两种入口的受控子进程在实际临时inode写入16字节后报告checkpoint，再由parent发送SIGKILL；旧目标字节/模式保持，遗留私有temp由harness所有者观察后清理，不冒充writer崩溃清理。普通失败表覆盖partial-write/chmod/close/rename、真实exclusive EEXIST、双错误聚合、他人临时文件与符号链接目标保护。重叠测试早期按抵达顺序选择阻塞者导致一次timeout，改为按实际文档身份选择，未增加超时或重试。最终提交审查、可信Docker基线与CI证据保留于本issue PR；未声称断电持久性、敌对父目录竞态或单文件bind的即时更新。

审查闭环（#30，fixpass1）：补强两类证据而非改变生产行为：每个已取得句柄的失败案例在teardown之前检查真实FileHandle.fd为-1；并发文档改为不同baseURL/模型/contextWindow/default正文，不再仅追加换行。held writer在finally释放并等待结束，checkpoint同时响应writer拒绝。补强后`pnpm check`仍557unit/255integration通过，重复率2.98%；source/dist实际并发与16字节checkpoint中断smoke重跑通过（4/5次完整版本观察），旧目标/权限及harness所有权清理结论保持。

### Issue #31 risk/evidence map (task 8.3 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: atomic discriminated-result cutover, optional missing settings and explicit key-availability metadata; all existing consumers narrow configured content, root typecheck/check and source/dist branch smoke.
- Config / project setup; Auth / permissions / secrets — selected: four independent missing-field cases, false actual-key presence despite nonempty reference name, blank/whitespace/empty list behavior, unchanged successful secret-free serialization; no environment or credential-value input.
- Concurrency / shared state / ordering — selected: readiness before overlay composition, no mutation/global cache; preserved configured-path behavior and error propagation. No async state machine added.
- Error handling / rollback / partial outputs — selected: exact unconfigured result with no partial/content field, no empty-document fallback or catch-all. Caller smoke leaves old file unchanged; writer remains separately tested and unmodified.
- Release / packaging / dependency compatibility; Legacy compatibility / examples — selected: complete migration of generator/writer-test consumers, preserved released JSON policy and source/dist behavior; existing Docker4case baseline.
- Documentation / migration notes — selected: explicit actual-key-versus-reference distinction, future8.4/9.3/settings presence producer ownership, ordinary outcome not instance error; strict OpenSpec and runtime evidence.
- File IO / path safety / overwrite; Resource limits / large input / discovery — not selected: this function performs no IO/discovery and adds only bounded presence checks; atomic writer and its existing guarantees stay unchanged.

验证记录（#31，本地候选）：四项独立缺失的初始语义RED为557pass/4fail（旧实现返回JSON字符串而非精确unconfigured结果）；最终`pnpm check`571unit/255integration通过，generator行/分支100%，writer原24例保留。生成器返回discriminated result，`apiKeyConfigured`由可信调用者提供实际credential slot存在性，非空引用名不能代替；未配置分支在composition之前返回且无content。source/dist真实临时文件smoke各覆盖8个未配置输入：调用者不发布、旧目标字节/inode/模式及目录库存保持；配置完整时可替换为另一完整0444文档，两入口内容一致。无生产启动调用方，未声称容器阻止启动或实际密钥有效。重复代码门禁曾报3.10%、3.03%、3.04%，通过writer测试局部narrower、同表presence案例及共享实际文件arrange去重到2.92%，不删断言或放宽3%门槛；公开结果类型由typed writer-test消费者使用，dead-code通过。最终提交审查、可信Docker4case基线和CI结果保留于本issue PR。

### Issue #32 risk/evidence map (task8.4 including the task8.1 adapter handoff)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: reusable image-execution adapter validates released JSON and complete preset/canonical inputs; public generator/writer composed through Docker, unit semantic RED/GREEN and source/build behavior.
- Config / project setup; Auth / permissions / secrets — selected: actual user-edit precedence, trusted immutable policy versus writable copy, uid1001, exact effective model/default/contextWindow, real Host-bound browser authority; no secrets/model requests in observations.
- File IO / path safety / overwrite; Concurrency / shared state / ordering — selected: same owned state/work volumes across controlled restart, reread changed composition before atomic publication/recreation, no stale bind-inode assumption, no user expression execution during extraction, canonical lifecycle ownership and ordinary failure cleanup.
- Resource limits / large input / discovery — selected: complete all-preset discovery without default-only/truncated success, bounded command/readiness/browser/output paths; malformed/missing/broken inventory must fail rather than vacuously pass.
- Error handling / rollback / partial outputs — selected: extraction/parser/skipped-bundle/malformed-result errors reject; disposable adverse observations and no-managed-overlay control qualify enforcement oracle; preserve failure and resource-ownership evidence.
- Release / packaging / dependency compatibility; Legacy compatibility / examples — selected: installed0.2.0-rc.2 parser/runtime APIs and real expression round-trip, retain four Docker baselines and existing browser probe callers; no ahead-source authority or duplicate parser/lifecycle.
- Documentation / migration notes — selected: concrete adapter handoff to9.3, exact-head Linux evidence/screenshots and limitations, initial/restart model/UI observations, explicit workspace test setup boundary versus12.2, strict OpenSpec and CI.

验证记录（#32）：adapter、缺失custom preset、失败证据保留、helper归属/镜像/挂载guard及Chrome失败清理均取得此前记录的语义RED/GREEN。真实运行逐步揭示并修正发布版RPC参数、原生provider注册、effective fiber/ref读取、EntryGroup描述字段不插值和ConfigEditor写出格式等契约差异，未改DSH源码或删除验收断言。经项目方授权的第九轮修复后，审查准入提交`d8806c66c046436559b2c1edc1dc4fbe7e9a32b4`在giap-vps运行完整`pnpm test:docker`：5/5通过、exit0、62.03秒，原四例全部保留，独立清点无测试资源残留。初始及受管重启均仅intranet alpha/beta、默认beta、contextWindow500000/262144；员工负对照实际暴露alternate地址/default、personal模型、原生provider和custom-office联网工具；重新读取组成并生成覆盖层后custom-office保留且禁用web_search/web_fetch，正常工具及有效readLimit500保留。真实浏览器初始/重启及各自reload的中文、无公告、输入、General和模型选择均通过，consoleErrors均为空，截图及逐阶段receipt保留于PR#139证据。员工编辑至最终检查的profile字节完全相同，home/live/seed/marker保留断言通过；安装清单确认loader1.0.5、preset-registry/tool-fs0.2.0-rc.2。阶段摘要保留为失败诊断证据，不包含原始配置或凭据。工作区初始化是该测试的显式fixture操作，不冒充task12.2生产首次进入流程；未发送模型请求，task8.5/9.3/权限档映射仍由后续任务负责。最终合并提交的精确SHA复验和CI结果见PR#139。

### Issue #33 risk/evidence map (task8.5 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: released Session creation/prompt/terminal error contract; actual accepted message, correlated terminal failure and user-visible screenshot, not a transport-only error. Root Docker suite and adverse-oracle qualification.
- Config / project setup; Auth / permissions / secrets — selected: managed unavailable endpoint overrides persisted employee alternative; valid test-owned credential, actual effective provider identity; no real keys/services, body/header logging or model-admin API change.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: recorder reachability control before attempt, stable baseline until correlated turn completion, bounded request ledger and deadlines, no delayed fallback race accepted as zero.
- File IO / path safety / overwrite; Error handling / rollback / partial outputs — selected: reuse atomic overlay and owned state lifecycle, retain failed scenario evidence before cleanup; all new recorder/browser/container resources removed on success/failure, foreign resources untouched.
- Release / packaging / dependency compatibility; Legacy compatibility / examples — selected: installed0.2.0-rc.2 API/error behavior; all five existing Docker cases retained, common lifecycle/browser callers unchanged. No runtime/package upgrade.
- Documentation / migration notes — selected: explicit test fixture/reachability/terminal-state evidence and limits; root `pnpm check`, strict OpenSpec, full exact-head Docker run and CI. Rollback removes only this verification path, not employee state.

验证记录（#33）：审查准入提交`66e95edcf57513d752bf53cf338ee9b5087db5e5`在giap-vps完整运行`pnpm test:docker`，6/6通过、exit0、90.13秒，原五例保留，独立清点无资源残留。真实UI提交一条消息，Session接收requestId后对应turn1从userSeq8到terminalSeq31，以TRANSPORT/Connection error终止，实际使用intranet/beta、running=false，截图显示明确错误，consoleErrorCount0。实例内预检确认受管地址ECONNREFUSED、替身地址HTTP204、dummy credential有效；recorder基线1，回合结束且截图后仍total1/inflight0/overflowfalse，仅保留预检GET，无模型请求回退。拒绝错误/旧回合/缺失终止事件及额外请求的独立oracle通过反例资格验证。浏览器异常路径曾丢失已接收prompt证据：实际driver与受控CDP/真实子进程回归先299pass/1fail，再300integration全过，截图失败也保留Session/request/admission并终止Chrome。另一次真实运行发现13位测试用户标识无效，仅改为符合既有12位约束的fixture，未放宽writer。最终本地`pnpm check`591unit/300integration通过、重复率2.84%；无真实凭据或现有服务调用，未新增生产重试/回退实现。最终PR头复验、审查和CI证据见PR#140。

## 9. 编排器（任务包 1.7）

依赖：第 4、5、7、8 组。本组用 `published-loopback` 方式够到实例，`network` 方式在第 10 组。

- [x] 9.1 `platform/src/orchestrator/` 的 Docker 客户端：经 Unix socket 用 `node:http` 发请求、解析 JSON 和流式日志、把 Docker 的错误转成带状态码的错误；传输函数可注入。socket 路径是配置项。验证：单元测试（假传输）——JSON、流式日志和错误三种回应的解析；`pnpm test:docker`——能读到 Docker 版本；请求不存在的容器得到 404 类型的错误；socket 路径不存在时错误信息指出路径。
- [x] 9.2 卷：按用户创建状态卷和工作卷（带标签），已存在时复用。验证：`pnpm test:docker`——创建两次得到同一对卷；标签含用户标识；两个用户得到四个不同的卷。
- [x] 9.3 容器创建和启动：名称、主机名、标签、两个卷、只读挂载的覆盖层、启动命令（`--trusted-host` 取 4.6 的 authority）、环境变量（模型密钥、关闭遥测）、非特权；seccomp 文件路径是配置项，读入内容后传给 Docker；3080 只发布到 `127.0.0.1` 的随机端口，上游地址和端口存进 `instances` 表；写审计（实例创建、实例启动）。验证：`pnpm test:docker`——查看容器得到的名称、主机名、挂载和安全选项与设计一致；端口只绑定在回环地址；容器不是特权模式，没有挂载 Docker socket；删除后重建主机名不变（规格“每个实例有唯一且稳定的主机名”）；审计里有这两种事件。
      Task9.3 MUST consume task8.4's qualified complete-composition/trusted-canonical input adapter and the pure generator's single overlay; it MUST NOT rebuild a partial preset roster or duplicate canonical patch rows. Task8.1 alone does not claim this production wiring.
- [x] 9.4 资源上限：CPU、内存取自 `settings`，另设进程数上限。验证：`pnpm test:docker`——查看容器得到的三项上限等于设置值；改设置后新启动的容器用新值；内存上限设为 256M 时在实例里申请 512M，该容器里的进程被终止，同时运行的另一个实例仍然可用（规格“资源上限”的两个场景）。
- [x] 9.5 读启动令牌并换 DSH cookie：从容器日志匹配令牌行，用 `node:http` 带平台对外 authority 作为 `Host` 换 cookie，存进 `instances` 表。验证：`pnpm test:docker`——换到的 cookie 带着同一 `Host` 请求首页得到 200，换一个 `Host` 得到 401；日志和审计里没有令牌和 cookie 原文。
- [x] 9.6 就绪判定和启动失败：就绪时写审计（实例就绪）；60 秒内未就绪则停止容器，状态记为“出错”，存最后 50 行日志（先去掉令牌行），写审计（启动失败）。验证：`pnpm test:docker`——正常启动后审计里有“实例就绪”；用一份故意错误的覆盖层启动，状态变为“出错”，最近一次错误里有日志且不含令牌，审计里有“启动失败”。
- [x] 9.7 停止和删除：停止容器并删除容器，卷保留；调用方传入停止原因（空闲、管理员、禁用、出错），写审计（实例停止，带原因）。验证：`pnpm test:docker`——在工作目录和状态目录各写一个文件，停止、删除、重新创建后两个文件都在（规格“停止和重建后数据恢复”）；审计里的停止原因等于传入值。
- [x] 9.8 每用户串行：同一用户的生命周期操作排队执行。验证：单元测试——对同一用户并发发起十次启动，只执行一次创建；对两个用户并发启动互不等待（规格“一个用户恰好一个实例”）。
- [x] 9.9 同时运行上限：处于“启动中”和“运行中”的实例数达到上限时拒绝新的启动，返回“已满”，不停止已有实例；模型未配置时返回“未配置模型”，不创建容器、不记为出错。验证：`pnpm test:docker`——上限设为 1，第二个用户的启动被拒绝且第一个实例仍在运行；第一个停止后第二个能启动；清空模型设置后启动返回“未配置模型”且没有容器被创建（规格“同时运行的实例有上限”“模型未配置时不启动实例”）。
- [x] 9.10 平台启动时对账：按标签列出容器，与 `instances` 表比对并修正状态（库里“运行中”但容器不在 → 记为已停止；容器在跑但库里没有 cookie → 停止容器）。验证：`pnpm test:docker`——人为制造这两种不一致后执行对账，状态与 Docker 一致；两个实例运行中时重建编排器对象再对账，两个实例仍被识别为运行中且可访问（规格“平台重启后实例状态一致”的“平台重启时有实例在运行”场景）。
- [ ] 9.11 恢复配置目录：实例停止的状态下，用用户镜像起一个一次性容器，挂载该用户的状态卷，把 `profiles/` 整个换成镜像里 `/opt/dsh-team/profile-seed/` 的内容，其余不动；容器用完删除。验证：`pnpm test:docker`——事先把 `profiles/` 里的配置文件写坏，并在 `sessions/` 放一个文件；执行后 `profiles/` 与 `profile-seed/` 逐文件一致，`sessions/` 里的文件原样，没有残留的一次性容器。

Suggested fixture level: expanded - 持有 Docker socket 的关键路径，涉及并发、持久状态和凭据
Minimal mergeable slice: 9.1（Docker 客户端、单元测试和三个真实 Docker 用例，约 250 行，没有调用方）

### Issue #34 risk/evidence map (task9.1 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: public JSON/status/log contracts, actual Docker multiplex frames and unchanged bytes; injected transport tests plus real Unix HTTP smoke.
- Config / project setup; Legacy compatibility / examples — selected: explicit socket setting and all typed config consumers; invalid path validation and unchanged daemon-independent startup, `.env.example`, root checks.
- Auth / permissions / secrets — selected: privileged socket stays platform-side; no automatic body/log disclosure, HTTP errors expose status not credentials; adverse body sentinel checks.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: incremental frames/backpressure, cancellation and truncated stream rejection; stream tests demonstrate output before completion and source teardown, bounded partial buffering.
- Error handling / rollback / partial outputs; Release / packaging / dependency compatibility — selected: malformed JSON, exact HTTP404 despite malformed error body, real missing socket diagnostics; three read-only Docker cases on giap-vps with existing six-case baseline.
- Documentation / migration notes — selected: public client scope, critical-path human review, runtime proof and deferred lifecycle ownership; strict OpenSpec and CI.
- File IO / path safety / overwrite — no persistent writes or deletions in this slice; socket path validated and no TCP fallback. Smoke owns and removes only its temporary socket directory.

验证记录（#34）：配置先观察5个语义RED，再实现显式socket字段与全部typed fixture迁移；新client经public index测试JSON/空响应/HTTP状态/安全错误、split/coalesced日志帧、UTF-8字节保留、非法/截断帧、背压和Abort/early-return释放。`pnpm check`阶段622unit/301integration通过，client行97.64%/分支92.85%，最终移除未使用类型导出后dead-code及typecheck通过；重复率2.80%。独立真实Unix HTTP smoke证明默认传输JSON、错误体非JSON仍404、中文stderr分帧在EOF前输出、取消使服务端连接关闭、缺失socket路径报错。三席审查准入提交`6b531f9a1cc3f75b9b4b26d55c748e69556d6052`在giap-vps完整`pnpm test:docker`9/9通过、exit0、91.43秒：新增version/404/missing-socket三例及原六例均通过，独立资源清点为空。未添加生命周期、重试、SDK或启动时daemon依赖。关键路径仍需人工逐行审查，按用户指令在Epic完成时统一提交；最终PR头复验与CI见PR#141。

### Issue #35 risk/evidence map (task9.2 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: public pair operation, canonical names and `dsh-team.user`; public behavioral tests and real Docker readback.
- File IO / path safety / overwrite; Auth / permissions / secrets — selected: persistent volumes cannot be adopted/deleted on conflict; safe user identity, request/response ownership validation; no credentials or mounts introduced.
- Concurrency / shared state / ordering; Error handling / rollback / partial outputs — selected: repeat/partial-success reuse without destructive rollback; failure tests, same-user repeat and two-user real acceptance. Process locks belong to task9.8.
- Resource limits / large input / discovery — selected only for bounded two-volume operation and scoped cleanup; no global resource enumeration in production.
- Config / project setup; Release / packaging / dependency compatibility — not selected: reuse explicit Docker client and installed daemon, no config or dependency changes.
- Legacy compatibility / examples; Documentation / migration notes — selected: preserve nine Docker cases and existing client behavior; document result here after root checks, strict OpenSpec, full exact-head Docker run and CI.

验证记录（#35）：公开 `ensureUserVolumes` 复用现有Unix客户端，按用户创建/复用home/work，校验名字与用户标签；冲突拒绝且不接管/删除，第二卷失败保留第一卷供重试。归属分支观察语义RED；24单元场景及真实Unix HTTP smoke覆盖复用、冲突、无破坏重试。三席审查发现验收请求挂起可阻止清理，第一修复轮为实际验收helper加入独立逐请求期限；Unix server持久化后不结束响应的回归先RED（需watchdog救援），后GREEN（取消/连接关闭/仅清理本次卷/保留无关卷和原始错误）。最终本地 `pnpm check` exit0，646unit/302integration通过、volumes100%覆盖、重复率2.74%，strictOpenSpec通过；全diff复审clean/ADMIT。审查头`a1b4d02a0174a5192539e7867c1e6f58d929a507`在giap-vps完整Docker10/10通过、exit0、91.36秒，新增双用户四卷及原9例均过，独立资源清点为空。最初两次父进程运行缺少审查头/Chrome环境变量，不计成功；补齐显式环境后全量通过。最终PR头与CI见PR#142，关键路径人工白盒审查按用户指令后置至Epic完成。

### Issue #36 risk/evidence map (task9.3 only)

- Public API / CLI / script entry; Config / project setup — selected: exported operation plus explicit image/seccomp configuration and all typed callers; config RED/GREEN, public startup tests, real exported-operation acceptance, ordinary health remains daemon-independent.
- File IO / path safety / overwrite; Schema / columns / units / field names — selected: existing atomic overlay writer, real seccomp content, owned volume mounts, instance fields/port; malformed policy/inspect failure cases and real independent filesystem/Docker/SQLite readback.
- Auth / permissions / secrets; Concurrency / shared state / ordering — selected: exact user ownership, no foreign adoption, secret only in intended container environment, no key in errors/audit; create/start/inspect/DB-audit ordering and helper cleanup. Per-user locking is task9.8, not claimed here.
- Credential evidence specifically exercises the exported operation with complete model inputs/key-variable name but missing or empty actual key: unconfigured, no final DSH container/endpoint/creation-start audits. The operation derives availability from the actual injection value.
- Resource limits / large input / discovery; Error handling / rollback / partial outputs — selected: finite helper/acceptance operations and bounded output; owned helper cleanup on failed composition, no destructive volume rollback, malformed/failed daemon or DB/audit rejects without false success. Resource caps are task9.4.
- Legacy compatibility / examples; Release / packaging / dependency compatibility — selected: same captured image for released composition and DSH; preserve shipped seccomp/default sandbox and all ten baseline Docker cases; pinned-node full Docker regression.
- Documentation / migration notes — selected: canonical defaults in environment documentation, truthful starting-not-ready contract and evidence here; strict OpenSpec, root checks, final-head source review/runtime/CI.

验证记录（#36）：导出 `startUserContainer` 实际串联同一镜像/用户卷的完整composition适配器、唯一只读覆盖层、安全Docker创建/启动、回环端点检查和SQLite审计事务；返回starting而非就绪。配置7例语义RED、外来容器启动前归属RED后修复；三席审查发现缺模型仍依赖基础设施，提取managed-config单一完整性谓词，10例真实SQLite/不可用socket场景先RED后GREEN且旧overlay/状态不变。真实Docker随后暴露CLI空inspect stdout为`[]`或换行，与原空字符串判定不兼容；保留精确目标/状态/诊断约束修复，生命周期回归4fail/12pass到16pass。最终本地完整`pnpm check`exit0，694unit/339integration、重复率2.76%，strictOpenSpec通过；两次全diff修复复审准入。审查头`104f905af028730aaf8d6b3c0a2e0444e6cb39e0`在giap-vps固定Node24.13.1/pnpm10.34.6工具链执行完整Docker11/11、exit0、100.41秒，新增实际入口两次启动/重建同主机名、独立inspect、4条审计、两个helper清理；原10例通过，独立资源清点为空。首轮Docker10/11失败不计成功；最终PR头/CI见PR#143。关键路径人工白盒审查按用户指令后置至Epic完成。

### Issue #37 risk/evidence map (task9.4 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: existing exported startup reads persisted limits, CPU/MiB conversion to Docker fields; public behavior RED/GREEN and independent inspect.
- Config / project setup — selected: existing settings defaults and changed rows observed anew; no new environment/schema fields, invalid conversion fails before mutations.
- Resource limits / large input / discovery; Concurrency / shared state / ordering — selected: finite CPU/memory/PID cgroups, fixed512PID and no extra swap; snapshot per creation, existing sibling unchanged,256MiB/512MiB actual OOM and sibling usability proof.
- Auth / permissions / secrets; File IO / path safety / overwrite; Error handling / rollback / partial outputs — selected: exact-owned test targets only, OOM payload stays inside container, no globalhost controls or secret leakage, failure preserves guards/overlay/index/audit contract and cleanup evidence.
- Legacy compatibility / examples; Release / packaging / dependency compatibility — selected: existing startup/composition security and eleven Docker cases retained, pinned host cgroup/daemon observations; no dependency change.
- Documentation / migration notes — selected: fixedPID/no-extra-swap/create-time semantics documented here; root checks, strict OpenSpec, exact-head source review/Docker/CI.

验证记录（#37）：每次配置完整的启动读取持久settings，安全转换NanoCpus/Memory，MemorySwap=Memory、PidsLimit512；资源16例语义RED后GREEN，模型未配置仍不依赖settings。复用公告后HTTP401观察，修复启动时序；真实Docker诊断确认内核可终止整个256MiB实例，符合规格“进程被终止或实例退出”，不能要求同cgroup观察器幸存。用户授权追加一轮后，改为工作卷持久化请求/实际触页进度与宿主精确实例OOM状态关联，只读受管helper读取；没有增加内存、修改OOM优先级或降低隔离验收。审查头`3696e81157a2d5503c20c335c4c8420107d4361f`在固定Node24.13.1/pnpm10.34.6 giap-vps完整Docker12/12、exit0、116.67秒：申请536870912字节，已触页154140672字节，B OOMKilled=true且退出137；cgroup memory.max268435456/swap0/pids512，原A相同身份/上限且HTTP401前后可用，平台health200前后可用，清理清点为空。旧11例保留；本地pnpmcheck通过，694unit/386integration，strictOpenSpec通过。最终头/CI见PR#144；人工白盒审查按用户指令后置Epic完成。

### Issue #38 risk/evidence map (task9.5 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: current instance lookup, public token-to-cookie operation and canonical parser cutover; split log/HTTP/SQLite behavioral tests.
- Auth / permissions / secrets; Concurrency / shared state / ordering — selected: exact owned current container, explicit authority, backend-only credential, conditional clearing/update and active-account check; stale exchange/account races and real same-Host200/wrong-Host401.
- Resource limits / large input / discovery; Error handling / rollback / partial outputs — selected: bounded stream/HTTP/header handling, deadlines/cancellation/teardown, no old credential after failure, no raw-secret errors; adverse boundary tests.
- File IO / path safety / overwrite — not selected: no new file publication or deletion; existing test-owned lifecycle handles cleanup.
- Config / project setup; Legacy compatibility / examples; Release / packaging / dependency compatibility — selected: reuse existing authority/endpoint/client and released parser/protocol; migrate parser consumers, preserve twelve Docker cases, no dependency or configuration changes.
- Documentation / migration notes — selected: starting-not-ready and backend-only cookie contract; root checks, strict OpenSpec, full exact-head Docker/CI evidence.
- Immutable creation identity repair: persist nullable image_id alongside unchanged image_tag via forward migration; historical-null rejection is explicit, no current-tag backfill. Prove migration preservation, fresh startup persistence, retag/removal acquisition and foreign-image rejection through local and actual Docker boundaries.

验证记录（#38）：导出acquireDshCookie重组stdout完整启动行，通过node:http显式Host交换并条件持久化当前实例cookie，不返回凭据、不标记就绪；单一解析器迁入orchestrator、消费者全部迁移。splitstdout语义RED1fail后GREEN；审查发现可变tag重新解析导致旧实例失效，修复前retag/removal/创建身份/迁移RED4fail88pass，改为迁移2新增nullableimage_id、启动原子保存immutableID、交换不再查询tag；历史未知身份拒绝且不清旧cookie。最终本地pnpmcheck exit0，755unit/430integration、strictOpenSpec通过。审查头`19184a9a9767ed9dd28c9cc590fbab3aab15ed73`在固定Node24.13.1/pnpm10.34.6 giap-vps实际完整Docker13/13、exit0、126.93秒：生产启动/交换后的数据库cookie同Host200、异Host401，真实日志/审计secretSafe，受管可变tag换指向和移除后均成功，外来镜像拒绝；状态仍starting，12基线保留，独立资源清点为空。完整修复审查clean；最终头/CI见PR#145。人工白盒依用户指令后置Epic完成，未豁免。

### Issue #39 risk/evidence map (task9.6 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: exported readiness, starting→running/error and existing last_error/cookie/audit fields; real HTTP/SQLite state/audit proof, no migration.
- Auth / permissions / secrets; Concurrency / shared state / ordering — selected: authenticated200, current instance/account/immutable image, conditional transitions, safe retained logs; stale/cross-instance and credential-fragment regressions.
- Resource limits / large input / discovery; Error handling / rollback / partial outputs — selected: one60s deadline, bounded log/request/stop lifetime and memory, early-exit/cancellation/stop/DB failure; finite cleanup preserves errors without raw secrets.
- File IO / path safety / overwrite — not selected for production: no file write/delete; controlled bad-overlay injection and existing owned cleanup only in Docker acceptance.
- Config / project setup; Legacy compatibility / examples; Release / packaging / dependency compatibility — selected: existing authority/client/endpoint/parser policy, no knobs/dependencies; preserve13Docker baselines and starting-only/credential APIs.
- Documentation / migration notes — selected: readiness/failure transition and bounded diagnostic contract; root checks, strictOpenSpec, exact-head actual good/bad-overlay Docker and CI.

验证记录（#39）：waitForUserContainerReady复用单一凭据获取，使用本次实际提交的cookie认证HTTP200后才条件原子提交running/instance.ready；统一60秒就绪窗口、提前退出检测、独立有界日志与停止清理；失败记录error/清cookie/instance.start-failed，不删除容器或卷。保留最后50行安全诊断，分流重组UTF8/帧、整行超限丢弃，控制字符规范化先于凭据检测，禁止过滤后重建秘密。语义RED包括真实200后未转换状态及NUL重建秘密泄漏，均修复；本地完整pnpmcheck exit0，795unit/508integration、strictOpenSpec通过。审查头`f1968a708d2477988b59cbc58995e49eba55ef6a`固定Node24.13.1/pnpm10.34.6 giap-vps实际完整Docker15/15、exit0、92.25秒：正常路径running/认证200/ready审计，受管已绑定覆盖层原位损坏后error/真实安全日志/start-failed审计且已停止，秘密不外泄；13基线保留，独立资源清点为空。全diff修复审查clean；最终头/CI见PR#146；人工白盒依用户指令后置Epic完成。

### Issue #40 risk/evidence map (task9.7 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: new retirement operation, stopped/current runtime-field clearing and exact stop reason; public realtransport/SQLite tests, no migration.
- Auth / permissions / secrets; Concurrency / shared state / ordering — selected: exact owned current immutable identity, disabled-account stop, stale replacement and credential clearing; negative mutation guards and atomic audit/state.
- File IO / path safety / overwrite; Error handling / rollback / partial outputs — selected: destructive container operation must never remove either persistent volume; actual sentinel survival, partial Docker/DB failure and absent-container retry without false success.
- Resource limits / large input / discovery — selected: bounded stop/delete/inspect with cancellation; no discovery over arbitrary containers, no unbounded retries.
- Config / project setup; Legacy compatibility / examples; Release / packaging / dependency compatibility — selected: existing client/identity/image/volumes/startup contracts, no new config/dependency; preserve15Docker baseline scenarios.
- Documentation / migration notes — selected: stopped-field and no-op/partial-failure contracts; root checks, strictOpenSpec, exact-head fullDocker/CI and human critical-path review ledger.

验证记录（#40）：stopUserContainer按捕获的当前受管容器ID停止、确认停止、无force/卷删除选项地移除并确认不存在，再原子清运行时身份/端点/cookie并记录调用方原因，保留历史时间/错误；禁用账号可停止，已完成操作不重复审计，部分Docker/DB失败不伪造成功。真实UnixHTTP/SQLite语义RED先观察停止后尚未删除，后GREEN；本地完整pnpmcheck exit0，830unit/561integration、stop.ts逐项100%覆盖率、重复率2.69%、strictOpenSpec通过。三席全diff审查clean；审查头`ddb927cc5aa0fd4a5ab0fc844b0bfb54a4f5030b`固定Node24.13.1/pnpm10.34.6 giap-vps完整Docker16/16、exit0、96.76秒：实际uid1001写入状态/工作卷精确文件，经生产停止删除重建后字节不变、原ID不存在、新ID不同、两卷/主机名保持，审计原因idle，独立兄弟实例/文件/行/审计不变；15基线保留，独立资源清点为空。最终头/CI见PR#147；人工关键路径审查按用户要求后置Epic完成。

### Issue #41 risk/evidence map (task9.8 only)

- Public API / CLI / script entry; Legacy compatibility / examples — selected: explicit factory lifecycle cutover, all consumers migrated, no bypass aliases; preserve old behavior except required idempotent reuse of validated starting/running instance.
- Concurrency / shared state / ordering; Error handling / rollback / partial outputs — selected: per-user FIFO, different-user independence, cancellation/head-failure cleanup, no recursive lock or poisoned queue; deterministic public lifecycle barriers with real persisted state.
- Auth / permissions / secrets; Schema / columns / units / field names — selected: user key/instance identity/current account/cookie and existing audit/row contracts; prevent stale cached outcome, moved key or repeated audit, no schema changes.
- Resource limits / large input / discovery — selected: idle queue-entry cleanup, existing bounded IO deadlines, no global blocking or abandoned work; cancellation/settlement tests.
- File IO / path safety / overwrite — selected for preservation: shared startup/retirement still obey managed overlay and volume ownership rules; full baseline Docker data recovery and exact-owned cleanup retained.
- Config / project setup; Release / packaging / dependency compatibility — selected: explicit one-context-per-database ownership, no new settings/dependency; entirecaller cutover and full pinnedDocker verification.
- Documentation / migration notes — selected: method-input/caller migration, truthful starting/running reuse and context lifetime; root checks, strictOpenSpec, full exact-head Docker/CI.
- New reuse branch evidence is explicit: valid starting and genuinely running results preserve full row/cookie/overlay/audits; foreign/stopped/malformed/stale reuse, non404 inspect and exact404/name collision fail closed; changed account/model eligibility is re-read on each call.

验证记录（#41）：createOrchestrator绑定client/database并独占每用户FIFO，四个生命周期方法所有调用者原子迁移，无隐藏全局队列/旧公共旁路；同用户十次启动仅创建一次、不同用户独立、失败/排队取消不阻塞后续、运行中取消持锁直到实际清理结束。启动在队列内重新验证账号/模型与当前实例，真实starting/running复用返回对应状态，不改行/cookie/覆盖层/审计；精确404仍可重建，异主/异常/过期均拒绝。排队前取消明确保留旧凭据且无IO，活动中取消行为保留。真实Unix/SQLite并发语义RED后GREEN；本地完整pnpmcheck exit0，879unit/568integration、coordinator100%覆盖、重复率2.67%、strictOpenSpec通过。三席全diff审查clean；审查头`5001780009ace9f88205167151da83ff4b49bee5`固定Node24.13.1/pnpm10.34.6 giap-vps完整Docker16/16、exit0、110.89秒：共享owner十次初始启动同一实例/一个创建启动审计对，原重建和16基线全部保留，独立清点为空。最终头/CI见PR#148；人工白盒按用户要求后置Epic完成。

### Issue #42 risk/evidence map (task9.9 only)

- Public API / CLI / script entry; Schema / columns / units / field names — selected: typed full outcome, persisted maxRunningInstances and counted states; all result consumers migrated, no schema change.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: cross-user synchronous reservation, pending/persisted distinct-count handoff, actual cleanup settlement and separate-user independence; deterministic last-slot/race/failure proofs.
- Config / project setup; Legacy compatibility / examples — selected: fresh persisted limits, missing-model precedence and full-capacity validated reuse; current owner/API/caller semantics retained.
- Auth / permissions / secrets; File IO / path safety / overwrite; Error handling / rollback / partial outputs — selected: full/unconfigured no container/helper/volume/overlay/row/audit/error mutation, no eviction or cross-user changes; ownership and failure cleanup regressions plus actual preserved A endpoint.
- Release / packaging / dependency compatibility; Documentation / migration notes — selected: no new dependency/config/claim schema, documented state-based occupancy and pending lifecycle; root/strictOpenSpec, full pinned Docker/CI and deferred human-review ledger.

验证记录（#42）：同一owner同步准入，pending与持久starting/running按用户去重，实际清理结束后释放pending；每次准入读取最新上限，满额复用不占新名额，full/unconfigured无创建或状态/审计/覆盖层变更，模型缺失优先。真实Unix/SQLite持久上限拒绝场景观察RED后GREEN；并发最后名额、limit2独立推进、持久交接、清理阻塞/取消和新旧配置边界有确定性测试。本地完整pnpmcheck exit0，899unit/575integration，orchestrator100%覆盖、重复率2.72%、strictOpenSpec通过。三席全diff审查clean；审查头`e586eea88148c9a8206feba06a175e0bab7db164`在固定Node24.13.1/pnpm10.34.6 giap-vps完整Docker17/17、exit0、115.29秒：limit1真实ready A保持HTTP200且B返回full，停止A后B启动且ready HTTP200，清空已有/新用户规范模型输入均unconfigured且无拒绝副作用；原16基线保留，独立清点为空。最终头/CI见PR#149；人工白盒按用户要求后置Epic完成。

### Issue #43 risk/evidence map (task9.10 only)

- Public API / CLI / script entry; Config / project setup — selected: explicit owner.reconcile startup operation and optional signal, #56 owns application startup await; no artificial current main.ts wiring.
- Schema / columns / units / field names; Concurrency / shared state / ordering — selected: Docker truth with exact persisted identity fences, same owner/per-user queue, idempotent stopped transitions and healthy credential preservation; real SQLite/Unix race/error proof.
- Auth / permissions / secrets; Error handling / rollback / partial outputs — selected: validate immutable ownership and active account, no credential regeneration/logging; non404 not absence, no false success after partial retirement/persistence failure.
- Resource limits / large input / discovery; File IO / path safety / overwrite — selected: label-filtered bounded discovery including stopped containers, cancellation/settlement, no orphan/helper/data deletion or overlay mutation; exact-owned Docker cleanup and capacity correction.
- Legacy compatibility / examples; Release / packaging / dependency compatibility; Documentation / migration notes — selected: no schema/config/dependency changes, seventeen baseline Docker cases retained; root/strictOpenSpec/full final-head Docker/CI plus deferred human review.
- Integration sequence: #43 supplies and verifies explicit reconciliation after owner reconstruction; #47 adds network recovery; #56 must construct the single application owner and await reconciliation before serving lifecycle/upstream-routing requests. This task does not claim existing main.ts startup invocation.

验证记录（#43）：owner.reconcile通过原有每用户队列执行标签发现、精确ID验证和安全退休；健康实例保留全部身份/cookie/地址/覆盖层/审计，缺失容器或cookie纠正为stopped并保留卷，不把非404错误当缺失。构造时依赖和入口signal一次捕获；发现响应限4MiB、有限时限，其他JSON调用默认行为不变。自然过期的结构合法cookie不阻止对账退休，新获取过期cookie仍拒绝。公共Unix/SQLite缺失身份观察RED后GREEN；审查修复过期、owner替换、signal替换三类8项回归，另以有效超限JSON和临时移除预算的失败控制证明限额测试有效。完整pnpmcheck exit0：953unit/601integration，reconcile100%行/函数、92.15%分支，重复率2.94%，strictOpenSpec通过。首轮三席提出问题、修复1/2轮后全diff复审clean。审查头`053c5cf137a13025dd550167c17729f33b043454`在固定Node24.13.1/pnpm10.34.6 giap-vps完整Docker18/18、exit0、122.07秒：两个原实例重建owner前后均HTTP200，缺失容器与缺失cookie均纠正，4个卷保留、停止审计2条，原17基线保留且独立清点为空。最终头/CI见PR#150；实际应用接线仍由#56负责，人工白盒后置Epic完成。

## 10. 实例网络（任务包 1.10）

依赖：第 9 组。

- [x] 10.1 子网分配：从配置的地址段里按 `/28` 分配，已用的子网从 Docker 现有网络读出，不存进数据库；地址段用尽时返回明确错误。地址段是配置项。验证：单元测试——连续分配互不重叠；释放后可再用；地址段不足以放下同时运行上限时平台启动即报错并指名该项。
- [x] 10.2 每实例网络：启动时创建带标签的 bridge 网络并把实例接入，停止时删除。验证：`pnpm test:docker`——起两个实例，从一个实例里连接另一个实例的地址和主机名的 3080 和其他端口都失败（规格“实例之间网络不可达”的第一个场景）。
- [x] 10.3 `network` 方式：配置项选择够到实例的方式（`network` 为默认，`published-loopback` 仅供平台进程直接跑在宿主机上时用）；`network` 下实例不发布任何端口，平台容器（名字是配置项）在实例启动时接入该实例的网络、停止时断开，上游地址取容器在该网络里的地址。验证：`pnpm test:docker`——起一个替身容器充当平台容器，实例启动后替身被接入该网络并能从替身里连上实例的 3080；实例容器没有任何端口映射；实例停止后替身不再在该网络里且网络被删除（规格“实例不暴露宿主端口”）。
- [x] 10.4 对账时恢复网络：平台启动对账时把平台容器重新接入每个运行中实例的网络，接不上的实例停止并记为出错；没有对应容器的实例网络删除。验证：`pnpm test:docker`——两个实例运行中时删除并重建替身平台容器，对账后替身能连上两个实例；人为留下一个无主的实例网络，对账后它被删除（规格“平台容器被重建”场景）。
- [x] 10.5 起 61 个网络不耗尽地址。验证：`pnpm test:docker`——用平台的分配器连续创建 61 个带 `dsh-team-test` 前缀的网络全部成功，随后全部删除。

Suggested fixture level: expanded - 隔离边界的一部分，涉及共享的地址资源
Minimal mergeable slice: 10.1（纯分配函数和单元测试，约 120 行）

### Issue #44 risk/evidence map (task10.1 only)

- Public API / CLI / script entry; Schema / columns / units / field names; Config / project setup — selected: pure allocator and real main startup validation, explicit subnetPool environment/field, /28 capacity against persisted settings, no second limit/schema.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: readonly Docker-IPAM snapshot and interval jumping, no hidden reservation; #45 owns fresh discovery and serialized select/create.
- Error handling / rollback / partial outputs; Auth / permissions / secrets — selected: explicit malformed/exhausted error and before-listen config-key rejection; no selector Docker/DB writes or credentials.
- File IO / path safety / overwrite; Legacy compatibility / examples — selected: owned startup DB lifecycle, migrated config consumers and unchanged health/API; no network/data deletion.
- Release / packaging / dependency compatibility; Documentation / migration notes — selected: source/built startup smoke, retained18Docker baselines, no dependency; root/strictOpenSpec/final-headCI and deferred human review.
- Handoff: task10.2 supplies fresh all-network IPAM occupancy and serializes selection/create; task10.1 pure selector is not a claim of wired Docker allocation.

验证记录（#44）：纯allocateSubnet按当前IPAM子网快照以无符号区间首适配选/28，包含/更小范围均按重叠排除，释放快照可复用、耗尽明确报错；无数据库预留或隐藏状态，Docker快照读取/选择创建串行化归#45。PLATFORM_SUBNET_POOL默认172.30.0.0/16，仅缺省时应用；主进程迁移后读取持久maxRunningInstances，在监听前用同一解析器校验容量。实际source进程/27+limit3错误HTTP200的RED已观察；修复后父级source及compiled smoke均为limit3退出1/指名pool/无health，limit2返回HTTP200。完整pnpmcheck exit0：1020unit/605integration，subnet100%覆盖，重复率2.92%，strictOpenSpec通过。三席全diff审查clean，审查头`749a5d1e06939c3643ef2fa667da18cdd3072aad`固定Node24.13.1/pnpm10.34.6 giap-vps完整18Docker基线全部通过，exit0、116.48秒，覆盖全部dsh-team容器/卷/测试镜像的独立清点为空。最终头/CI见PR#151；人工白盒与环境规则变更审查后置Epic完成。

### Issue #45 risk/evidence map (task10.2 only)

- Public API / CLI / script entry; Config / project setup; Legacy compatibility / examples — selected: existing owner start/stop/readiness integration and required subnetPool propagation; loopback upstream remains until #46, all callers and eighteen baselines retained.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: owner-local short allocation queue, fresh all-network IPAM and sole allocator, bounded requests/cancellation and actual-settlement lock ownership; public deterministic race/failure tests.
- Auth / permissions / secrets; Schema / columns / units / field names — selected: exact immutable network/container ownership, canonical bridge/subnet/sole attachment, full current row/account fences and existing atomic audits; no schema/reservation or credential exposure.
- Error handling / rollback / partial outputs; File IO / path safety / overwrite — selected: safe empty-network rollback, missing-container retirement cleanup, stopped-container readiness compensation and truthful failures; volumes/overlays/sibling networks preserved.
- Release / packaging / dependency compatibility; Documentation / migration notes — selected: actual non-vacuous two-instance IP/hostname isolation and removal proof, exact-owned network-aware teardown/inventory; full root/strictOpenSpec/final-headDocker/CI and deferred human review.

验证记录（#45）：生产实例创建直接接入独立、验证过的标签bridge，owner短队列串行读取全部网络IPAM/分配/创建，后续用户生命周期独立；验证单一附着和网络身份，正常退休及已确认停止的readiness补偿删除验证过的空网络，保留卷/兄弟实例。未知创建结果仅在当前owner内按用户隔离，自动重试/对账不采用未知桥，只有显式完成安全退休及stopped审计提交解除；不声称跨owner持久隔离。公共Unix/SQLite初始默认bridge语义RED，审查中错误IPv6快照/已提交创建取消4项RED及未知桥重试/对账/无操作退休4项RED后修复。完整pnpmcheck exit0：1076unit/625integration，全部逐文件覆盖门禁通过、重复率2.93%，strictOpenSpec通过。两轮普通修复后真实Docker发现新增测试错误要求已停止容器Networks映射为空；物理网络已独立验证不存在，但Engine保留无活动端点的声明。用户明确授权一轮，仅删除该表示形式断言，保留物理网络不存在/停止/错误审计/凭据安全/数据保留检查，fresh全diff复审clean。审查头`36eab2bac84bc57fe066c652d234a23fd0a5afb0`在固定Node24.13.1/pnpm10.34.6 giap-vps完整19/19Docker通过，11文件、130.83秒、exit0：两实例3080/3099有正向监听控制，跨IP/主机名双向均隔离，独立退休且兄弟不变；原18基线含bad-overlay全部保留。全部dsh-team容器/网络/卷/测试镜像独立清点为空。最终头/CI见PR#152；人工白盒后置Epic完成。

补充验证（#45）：上述通过后的文档头`a5771c6`最终复验为18通过/1失败，仅兄弟实例inspect中同一Mounts项顺序变化；未将早先19通过冒充最终验收，也未重跑碰顺序。用户再次明确授权一轮定向修复：仅对挂载数组副本按Destination规范顺序，保留全部成员/字段和完整兄弟实例比较、HTTP200断言；冻结输入及相同排列/不同Source/不同RW/缺失成员四项控制通过。完整pnpmcheck为1076unit/629integration、重复率2.92%、strictOpenSpec通过；fresh全diff复审clean。审查头`ba82531dd5b6372c60106dfef6c7cc842fce84f6`固定工具链完整19Docker再次通过，11文件、137.69秒、exit0；包含真实隔离、兄弟保持和bad-overlay网络删除，独立容器/网络/卷/测试镜像清点为空。最终头/CI仍以PR#152绑定证据为准；两次用户追加授权均有门禁记录，未放宽行为验收。

### Issue #46 risk/evidence map (task10.3 only)

- Public API / CLI / script entry; Config / project setup; Schema / columns / units / field names — selected: network default plus explicit host mode, validated platform name, captured owner configuration and verified IPv4:3080 in existing columns; public/config negative tests and full caller migration.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: per-user lifecycle retains submitted attach/detach settlement and bounded requests; deterministic cancellation/failure controls, no global blocking of unrelated users, preserve allocation quarantine.
- Auth / permissions / secrets; Error handling / rollback / partial outputs — selected: exact platform/network/instance identity, narrow endpoint allowlist, no host ports, persisted upstream mismatch rejection, connect failure and readiness/stop compensation with truthful audits; unknown/third endpoint and failed disconnect preserve resources.
- File IO / path safety / overwrite; Legacy compatibility / examples — selected: no data deletion; local host mode explicit in existing callers/19Docker baselines; startup/reuse/credentials/readiness/retirement/reconciliation validators share transport contract and preserve current-account/row fences.
- Release / packaging / dependency compatibility; Documentation / migration notes — selected: `.env.example` and environment guidance explain network-default vs local-only loopback, root checks/source-built startup, strictOpenSpec and final-head CI; real platform stand-in HTTP3080/no-publication/retirement plus independently empty cleanup inventory. No dependency/schema change.
- Non-goals: task10.4 platform-recreation recovery and orphan sweep, task10.5 count stress, gateway/compose; human white-box remains deferred, not waived.

验证记录（#46）：owner捕获network默认/published-loopback显式开发方式及平台容器名，验证并固定平台不可变ID；实例无宿主端口、独立bridge的IPv4:3080写入现有索引，启动连接平台、退休断开且验证空网络删除，数据与兄弟保留。初始公共Unix/SQLite语义RED后实现；三次用户授权的本地追加复验修复遗漏导入、规范fixture复用及清理回调绑定，门槛未放宽。审查两轮修复分别处理readiness保留的已停止脱网容器退休（2项RED）及补偿stop等待中拓扑/声明/发布变化的删除前再验证（3项RED）；完整pnpmcheck为1130unit/644integration、全部逐文件覆盖通过、重复率2.85%、strictOpenSpec通过。source与compiled实际进程均拒绝非法mode（exit1、指名变量），合法两种mode在Docker不存在时health200。fresh全diff复审clean；审查头`57eb07fea4118b6a4f6c5d4b568b2cf047cb09a7`固定Node24.13.1/pnpm10.34.6 giap-vps完整20/20Docker通过，12文件、131.86秒、exit0：真实平台替身到两个未发布实例3080均HTTP401，独立退休/脱网/数据和兄弟保持，原19基线全保留；独立项目容器/网络/卷/测试镜像清点为空。最终头/CI以PR#153绑定证据为准；不声称实现#47平台重建恢复/孤儿清理，人工白盒后置Epic完成。

### Issue #47 risk/evidence map (task10.4 only)

- Public API / CLI / script entry; Config / project setup; Legacy compatibility / examples — selected: same explicit owner.reconcile and captured transport config; fresh-owner replacement platform, unchanged live-owner pin and loopback behavior. No app wiring until#56.
- Concurrency / shared state / ordering; Resource limits / large input / discovery — selected: bounded labelled network discovery, per-user scheduling for network-only candidates, submitted mutation settlement/cancellation and unknown-create quarantine; deterministic same-user start/cleanup races with unrelated-user progress.
- Auth / permissions / secrets; Schema / columns / units / field names — selected: exact network/container/platform identity, row/account snapshots, canonical+indexed container404 absence, preserved healthy credentials and safe error/stopped audits; no new schema or credential generation.
- Error handling / rollback / partial outputs; File IO / path safety / overwrite — selected: attach failure stops/marks error, unconfirmed outcomes preserve resources; orphan deletion only after fresh verified absence/empty endpoints, no volumes/foreign endpoint mutation. Positive/negative publicUnixSQLite controls plus atomic persistence failures.
- Release / packaging / dependency compatibility; Documentation / migration notes — selected: real recreated stand-in/new owner reaches both original instances and removes a registered orphan, all20baseline cases retained, complete project-resource inventory; fullpnpmcheck/strictOpenSpec/finalheadDocker/CI, deferred human white-box.
- Non-goals: mid-owner platform-ID reset, global prune/retries, new schema/config/dependencies, gateway/compose/app startup wiring, count stress.

验证记录（#47）：新owner对重建的平台按配置名解析并固定新ID，恢复其他身份/地址/凭据均有效实例的连接；原owner不重置身份。仅明确提交且确定响应、两侧均确认缺席的接入失败授权安全退休并原子提交error/null与error原因停止审计；未知结果保留健康实例。孤儿网络在既有每用户队列内按标签/规范名/ID/子网及规范与索引容器404、完整row/account快照、空或可信平台唯一端点重新验证，未知创建隔离仍有效，不删卷或外来端点。初始真实Unix/SQLite平台重建恢复语义RED；本地三轮后用户授权一次旧missing-platform契约迁移，保留start/reuse拒绝与所有其他安全控制，未就绪实例安全退休、健康实例恢复。审查C1四项未知接入结果RED后修复；G1追加恢复后退休保护的回归，临时移除唯一第二次成员检查时真实行为RED，原样恢复后GREEN，未保留生产变更。完整pnpmcheck：1164unit/652integration、逐文件覆盖通过、重复率2.80%、strictOpenSpec通过，fresh全diff复审clean。审查头`640cf90324f2141c41a63313b91e99348bab2e24`固定Node24.13.1/pnpm10.34.6 giap-vps完整20/20Docker通过，12文件、132.87秒、exit0：真实平台替身重建后两实例保留且原cookie认证200，孤儿删除，原缺容器/缺凭据纠正等20基线保留；独立项目容器/网络/卷/测试镜像清点为空。最终头/CI以PR#154绑定证据为准；应用启动接线仍归#56，人工白盒后置Epic完成。

### Issue #48 risk/evidence map (task10.5 only)

- Resource limits / large input / discovery; Concurrency / shared state / ordering — selected:61 simultaneous bridges from fresh all-network IPAM via default-pool allocator, independent count/uniqueness/nonoverlap checks; sequential scenario, no new concurrency policy.
- Auth / permissions / secrets; Error handling / rollback / partial outputs; File IO / path safety / overwrite — selected: invocation-labelled absent-before-create exact resources, negative overlap attempt, immutable-ID/empty-network deletion and partial-failure cleanup; no foreign/data mutation.
- Public API / CLI / script entry; Config / project setup; Schema / columns / units / field names — existing allocateSubnet/default config and Docker/IPAM boundary, no API/schema/config change; assert /28/default-pool and literal test network prefix.
- Legacy compatibility / examples; Release / packaging / dependency compatibility; Documentation / migration notes — selected: all20baseline tests preserved plus one real61network case, fullchecks/strictOpenSpec/finalhead21Docker/CI and empty independent inventory; no dependencies, record evidence and human critical-path disclosure.

验证记录（#48）：测试直接复用公开allocateSubnet与loadConfig默认172.30.0.0/16，每次读取真实全部网络IPAM后创建dsh-team-test前缀bridge；61个同时存在，独立按名和ID检查、统计唯一/28与池内不重叠。额外注册的重叠CIDR控制由既有DockerAPI客户端观察到明确HTTP403，原61完整inspect与inventory不变；仅验证过的本次调用空网络按不可变ID清理，名称/ID及调用inventory均确认不存在。共享测试cleanup补齐身份/端点/无效删除负向控制，无生产源码改动；一轮审查修复错误依赖CLI脱敏前stderr的判据，未绕过脱敏或改门槛。完整pnpmcheck：1164unit/656integration、逐文件覆盖通过、重复率2.77%、strictOpenSpec通过；fresh全diff复审clean。审查头`3425dbf181ce2a786356dda1a79bbcfd3f2c02b6`固定Node24.13.1/pnpm10.34.6 giap-vps完整21/21Docker通过，13文件、146.58秒、exit0，新61网络用例18.926秒；原20基线保留，独立项目容器/网络/卷/测试镜像清点为空。这是现有分配器的真实边界刻画，已观察正确61网络、错误重叠拒绝及空清理恢复，不伪称生产bugRED。最终头/CI以PR#155绑定证据为准；人工审查按Epic统一后置。

## 11. 网关（任务包 1.8）

依赖：第 6 组；测试用本地替身上游，不依赖第 9 组。模块在 `platform/src/gateway/`。

- [x] 11.1 路由划分：`/_platform/` 和 `/healthz` 由平台处理，其余路径进网关；未登录时页面请求跳转登录页，其他请求返回 401。验证：集成测试覆盖 `gateway-routing` 规格“平台路径与实例路径分开”的全部场景和“实例由平台会话决定”的两个未登录场景。
- [x] 11.2 HTTP 转发：上游由平台会话对应的用户决定，不读取请求里的任何实例标识；去掉客户端的全部 `Cookie`，只注入该实例的 DSH cookie；`Host` 改为平台对外 authority；去掉响应里的 `Set-Cookie`。验证：集成测试（替身上游记录收到的请求）——上游收不到平台会话 cookie；浏览器收不到 DSH cookie；上游看到的 `Host` 是平台对外 authority；请求里伪造的实例标识头和查询参数不改变上游（规格“实例由平台会话决定”“DSH 凭据只在平台服务端”和“上游使用固定的对外地址”场景）。
- [ ] 11.3 流式转发：请求体和响应体不缓冲。验证：集成测试——上传和下载各一个 200MB 的流，平台进程的内存增长不超过 50MB，内容校验和一致（规格“大文件上传和下载”场景）。
- [x] 11.4 WebSocket 转发：在 `upgrade` 事件里做同样的鉴权和改写，校验 `Origin`，然后对接两端 socket。验证：集成测试——双向消息往返成功；未登录的升级被拒绝；`Origin` 不是平台对外地址的升级被拒绝（规格“WebSocket 可用”场景和“长连接只接受来自平台页面的升级”）。
- [ ] 11.5 连接登记和断开：按用户登记所有打开的连接；提供“销毁某用户全部连接”的函数。验证：集成测试——一个用户有两条长连接和一个进行中的下载时调用该函数，三者在 1 秒内全部断开，另一个用户的连接不受影响。
- [ ] 11.6 平台会话失效后的长连接：平台会话被删除后，由它建立的长连接被断开。验证：集成测试覆盖规格“平台会话失效后长连接不再可用”的场景。
- [ ] 11.7 实例未运行时的回应：页面请求被重定向到 `/_platform/wait`，其他请求得到 503 和机器可读的原因（已停止、启动中、已满、出错、未配置模型）；实例状态由注入的查询函数提供。验证：集成测试——五种状态下页面请求都得到指向等待页的重定向，接口请求都得到 503 和对应原因。

Suggested fixture level: expanded - 平台对外的共享入口，承担鉴权和凭据隔离
Minimal mergeable slice: 11.1（路由划分和未登录回应，约 120 行，此时被转发的路径统一返回 503）

### Issue #49 risk/evidence map (task11.1 only)

- Public API / Auth permissions secrets / Legacy compatibility: buildApp HTTP and real upgrade evidence; health200, unknown reserved404, anonymous HTML302 to fixedlogin, nonpage401, valid session503, no outbound requests/credential disclosure. Existing auth routes and guards unchanged.
- Concurrency shared state ordering / Error handling: expired/revoked/disabled session rejection, sliding renewal, database failure generic500, upgrade close and listener teardown; no new shared mutable state or retries.
- Schema / Config project setup / Release packaging / Documentation: explicit response schemas, hidden instance wildcard, generated contract check, full pnpmcheck and source/built runtime proof; no dependency/config/persisted format changes. Scope and temporary503 recorded here.
- Resource limits: pre-body HTTP admission for unsupported content and malformedJSON; upgrade sockets terminate, no buffering or upstream streams. File IO not selected: no introduced IO; existing database fixture lifetime retained.
- Both HTTP and real TCP upgrades cover the entire missing/malformed/duplicate/expired/revoked/disabled/valid-session matrix; revocation/disable occur after prior admission in the same app. Upgrade wire status plus EOF, reserved404, database500, peer-abort then health200 prove admission/error/lifecycle behavior. Forged authority/instance fields point at an observed local listener: gateway503, zero outbound connections.

验证记录（#49）：页面404→302、真实升级未结束→401/EOF 的 RED/GREEN 已观察。保留平台健康/鉴权/Origin 边界；HTTP与真实升级均验证缺失、畸形、重复、过期、撤销、禁用会话及有效会话503，精确登录令牌滑动续期、解析前拒绝请求体、存储失败安全500与脱敏错误日志。首轮审查发现升级半关闭受客户端FIN控制、absolute-form平台路径误分类及静默500；三项负向回归均先失败，修复后完整 `pnpm check` 1176单元/669集成、逐文件覆盖、重复率2.74%、契约及strict OpenSpec通过。独立source/built实际TCP证明拒绝401/503/absolute平台404完整发送且服务端主动释放，即使客户端不发送FIN；`pnpm e2e`通过。没有上游连接、容器操作或登录页渲染；这些仍属后续issue。最终审查/CI与冻结提交以PR#156记录为准。

### Issue #50 risk/evidence map (task11.2 only)

- Public API / Auth permissions secrets / Legacy compatibility: real two-user/two-upstream requests use only the current session ID, exact paired DSH cookie and configured Host; forged routing inputs cannot cross users. Both multiple client cookies and response Set-Cookie are removed. Preserve all task11.1 platform/anonymous/upgrade controls.
- Shared state ordering / Error partial outputs / Resource limits: synchronous uncached resolution, response ownership before parsing, pipe/backpressure, client/upstream abort teardown, before-headers502 versus after-headers termination, no retries. Actual event-based negative controls, no timing sleeps.
- Schema / Configuration / Packaging / Documentation: resolver dependency through the public gateway/app seam, no environment or DB change; explicit error schemas and unchanged platform contract. Full root check, strictOpenSpec, source/built real forwarding smoke, final-head full21Docker and CI.
- File IO not selected: no new filesystem operation.200MB memory qualification, WebSocket forwarding, per-user connection registry, wait reasons and real instance lookup remain their existing dependent tasks; basic byte-preserving piping and paired-resource cleanup are required now.
- Ownership/stream controls: malformedJSON POST remains byte-identical; upstream401 JSON extra fields survive gateway schemas; upload and download prefixes observed before producer completion. Lifecycle controls independently cover invalid endpoint, upstream101, unfinished-upload abort, response-client close, normal upload followed by delayed response, pre-header502 and post-header truncation; server-observed cleanup and subsequent successful request, no wall-clock sleeps.

验证记录（#50）：公开buildApp可注入仅接收当前会话用户ID的同步resolver，端点和DSH Cookie成对返回；未接入resolver的main仍保持503，真实实例查询留给#56。真实双用户/双上游证明伪造另一用户路径/头/查询/正文和真实上游authority均不改变所选实例；全部客户端Cookie、逐跳头先去除，再注入固定Host/DSH Cookie，响应多个Set-Cookie和凭据trailer均不外传。畸形JSON、二进制、上游401额外字段、增量上传/下载、两端取消与错误清理已验证。首轮审查发现Node对DELETE/GET/HEAD/OPTIONS/TRACE不自动chunk，五种方法的真实前缀回归均先RED；统一重建请求framing后，chunked、保留Content-Length与被Connection提名去除的长度三种情况全过。完整pnpmcheck1187单元/686集成、逐文件覆盖、重复率2.69%、契约/strictOpenSpec通过。源码提交`58dc06ffdbea8efb996efb82b39055171ff61a65`的source/built实际TCP进一步证明DELETE前缀在客户端end之前抵达、完整正文及201回应、凭据边界正确；e2e通过。最终头Docker/CI及复审以PR#157记录为准。

### Issue #52 risk/evidence map (task11.4 only)

- Public API/auth/secrets/invariant: existing active-session admission, exact single configured Origin, session-selected paired resolver, trusted Host/DSH Cookie and stripped response Set-Cookie. Real two-user upgrade/frame tests and rejected missing/wrong/duplicate Origin controls prove custody and zero cross-user/upstream activity.
- Shared state/order/errors/resources: client and upstream parser heads exactly once; abort-before-handshake fences late handoff; both disconnect directions, refusal/non101/invalid protocol and app shutdown settle owned resources. Event-based real TCP probes, no sleeps, no generic TCP tunnel.
- Compatibility/schema/config/packaging/docs: canonical auth Origin predicate extraction with unchanged mutation behavior; existing publicUrl passed to gateway, no config/dependency/migration; ordinary HTTP framing/admission preserved. Semantic RED/GREEN, complete root checks, generated contract check, strict OpenSpec, independent source/built smoke and final21Docker/CI.
- File IO not selected; no production filesystem operation. Per-user connection management, revocation-driven teardown and instance wiring stay #53/#54/#56. #51's unresolved50MB requirement is not bypassed or copied onto this independent DAG branch.
- Protocol/oracle closure: after admission and Origin, unsupported client Upgrade token/list gives400 without resolution or upstream activity; invalid upstream101 gives502. Test-only literal RFC6455 frames plus crypto prove both directional prefixes before producer release, complete equality and continued open-connection messages. Pending and established app-close cases and credential-bearing sanitized-error controls close lifecycle/evidence gaps.

验证记录（#52）：真实升级503→101、缺失/错误/重复Origin的502→403、非WebSocket协议503→400均有先RED后GREEN。24项实际TCP升级用例验证双向逐段帧在生产者继续前抵达、两端握手head恰一次、双用户端点/Cookie隔离、101去Set-Cookie、协议协商、待握手取消、错误/非101/错误协议以及应用关闭；既有HTTP和平台Origin行为保留。完整`pnpm check`通过：1197单元及逐文件覆盖、710集成、构建/契约/anti-drift（重复率2.74%）。独立source/built运行各证明401/403拒绝不调用resolver、有效101只选择当前用户、真实掩码文本解码hi及二进制[0,255]返回、app关闭客户端；e2e通过。初始化实现曾在流量结束后卡住关闭，改为preClose拥有升级连接且半关闭先flush后成对释放；另有关闭过程中排队升级逃出快照的RED，关闭准入栅栏后不再获取上游。原始失败/诊断与最终通过保留`.run/issue52/`。最终审查、冻结头Docker及CI以PR记录为准；#51内存门槛未被宣称通过。

## 12. 按需启动和空闲停止（任务包 1.9）

依赖：第 2、9、10、11 组。

- [ ] 12.1 把网关接到编排器：上游地址、端口和 DSH cookie 取自 `instances` 表；提供 `POST /_platform/api/instance/start`（幂等，返回当前状态）和 `GET /_platform/api/instance`（状态和原因）。启动只有这一个入口。验证：`pnpm test:docker`——注册并登录后调用启动接口，轮询状态到就绪，随后首页请求得到 DSH 的界面；实例运行中时首页请求直接得到 DSH 的界面；对已在运行的实例再调启动接口不产生第二个容器；`pnpm contract:check` 通过（规格“登录后按需启动”的“首次登录”“实例已在运行”场景）。
- [ ] 12.2 新实例可直接使用：按第 3 组的结论。验证：`pnpm test:docker`——新用户首次进入，不经任何选择即可创建 Session；界面语言为中文；没有公告（规格“新实例可以直接使用”）。
- [ ] 12.3 活动记录：网关按用户维护活动连接数和最后活动时间，写回 `instances` 表（最多每分钟一次）。验证：集成测试——有长连接时活动连接数为 1，断开后为 0 且最后活动时间更新。
- [ ] 12.4 空闲回收：每分钟检查一次，按第 2 组结论的信号判断是否有运行中的任务；没有连接、没有任务且持续达到配置分钟数才停止，停止原因为“空闲”；空闲分钟数每次检查时从 `settings` 读取。验证：用可控时钟的 `pnpm test:docker` 覆盖规格“空闲后停止”的四个场景（规格若已按 2.3 改写，则覆盖改写后的场景）。
- [ ] 12.5 回收后恢复：验证：`pnpm test:docker`——实例被空闲回收后，平台会话仍有效的用户不重新登录，直接请求首页被重定向到等待页，调用启动接口后就绪，之前的 Session 和工作目录里的文件都在（规格“平台会话有效而实例已停止”和“停止后再启动”场景）。
- [ ] 12.6 已满、出错和未配置时的状态：验证：`pnpm test:docker`——上限设为 1，第二个用户调用启动接口得到“已满”，第一个用户不受影响，第一个停止后第二个重试成功；实例出错后再调启动接口会重新启动；模型未配置时得到“未配置模型”（规格“有人空出位置后可以进入”“出错后重试”场景）。

Suggested fixture level: expanded - 把网关和编排器连起来，涉及定时任务和持久状态
Minimal mergeable slice: 12.1（网关接编排器、启动接口和状态接口，约 250 行，此时没有空闲回收，实例只会被手动停止）

## 13. 平台前端基线和账号页面（任务包 1.4、1.9 的界面部分）

依赖：第 6、11、12 组。

- [ ] 13.1 新建工作区包 `platform/web/`（React 18 加 Vite），构建为静态文件，由平台在 `/_platform/` 下提供；开发和构建脚本接入根 `package.json`。验证：`pnpm build` 产出静态文件；`pnpm e2e` 里请求 `/_platform/login` 得到页面。
- [ ] 13.2 Playwright 基线：加入 `pnpm test:ui`（登记到 `package.json`、`AGENTS.md` 验证矩阵、CI），删除 `constraints.yaml` 里 `ui_e2e_tests` 这条延后项。验证：一个用例打开登录页并断言表单存在；`pnpm lint:agents` 和 `pnpm check` 通过。
- [ ] 13.3 登录页：含加载中、出错（邮箱或密码错误、限流、账号被禁用）和成功三种状态，成功后进入工作台。验证：`pnpm test:ui`——登录走通；三种错误各显示对应的中文提示。
- [ ] 13.4 注册页：含加载中、出错（重复邮箱、密码太短）和成功三种状态。验证：`pnpm test:ui`——注册走通并处于已登录状态；两种错误各显示对应的中文提示。
- [ ] 13.5 改密码页和登出入口。验证：`pnpm test:ui`——改密码后用新密码能登录、旧密码不能；当前密码错误时显示提示；登出后回到登录页。
- [ ] 13.6 等待页 `/_platform/wait`：调用启动接口并轮询状态接口，就绪后进入工作台；显示启动中、已满（“当前使用人数已满，请稍后再试”）、出错（启动失败、重试按钮、仍失败时联系管理员）、未配置模型（“管理员尚未完成模型配置”）四种状态。验证：`pnpm test:ui`（两个接口用替身）——四种状态各显示对应文案；点击重试会再次调用启动接口；就绪后页面跳转（`gateway-routing` 规格“实例未运行时的回应”的三个等待页场景，`instance-lifecycle` 规格“上限已满”“启动超时”场景的界面部分）。

Suggested fixture level: expanded - 在平台进程的共享入口下加静态文件服务，改 CI 和门禁配置，且是认证界面
Minimal mergeable slice: 13.1 加 13.2（空的前端包、静态文件服务和 Playwright 基线，约 250 行）

## 14. 管理后台：账号和实例（任务包 1.11）

依赖：第 12、13 组。接口在 `platform/src/admin/`。

- [ ] 14.1 管理员鉴权：`/_platform/api/admin/` 下的全部接口要求管理员角色。验证：集成测试——未登录 401、员工 403、管理员 200（规格“只有管理员能进后台”）。
- [ ] 14.2 账号列表接口：邮箱、角色、状态、创建时间；按邮箱搜索，分页。验证：集成测试——回应里没有密码哈希、平台会话、DSH cookie；搜索和分页结果正确，无匹配时返回空列表（规格“账号列表”）。
- [ ] 14.3 实例列表接口：每个用户实例的状态（未创建、已停止、启动中、运行中、出错）、最近启动时间、最近活动时间、最近一次错误。验证：集成测试——五种状态各有一行且字段正确；回应里没有 DSH cookie（规格“实例状态与操作”）。
- [ ] 14.4 禁用和启用：禁用按“标记禁用、删除平台会话、销毁全部连接、停止实例（原因“禁用”）”的顺序在一次操作里完成；管理员不能禁用自己；写审计。验证：`pnpm test:docker`——被禁用用户的长连接在 5 秒内断开、实例停止、再登录被拒；启用后能登录且数据还在；审计里有禁用、启用和原因为“禁用”的实例停止（规格“禁用和启用账号”“禁用账号立即断开”）。
- [ ] 14.5 重置密码：管理员设置新密码，删除该用户的全部平台会话；写审计（不含密码）。验证：集成测试——旧密码不能登录，新密码能；该用户已有的平台会话失效；5 位新密码被拒绝且原密码不变（规格“重置密码”）。
- [ ] 14.6 重启实例：指定一个（运行中、已停止或出错的都可以），或全部运行中的；停止原因为“管理员”；写审计（重启实例）。验证：`pnpm test:docker`——重启运行中的实例后容器的启动时间更新，Session 和文件还在；对出错的实例执行重启后它被启动；审计里有该事件（规格“管理员重启实例”的两个场景）。
- [ ] 14.7 重置实例配置接口：停止实例，调用 9.11 的恢复函数，写审计（重置实例配置）。验证：`pnpm test:docker`——事先把 `profiles/` 里的配置文件写成无法解析的内容使实例启动失败，并在工作目录放一个文件；经接口重置后实例能启动，工作目录里的文件和已有的 Session 都还在；审计里有该事件（规格“重置实例配置”）。
- [ ] 14.8 审计查询接口：只读，带筛选和分页。验证：集成测试——员工请求 403；按邮箱筛选只返回该员工作为操作者或对象的记录；契约文件里审计相关的接口只有查询，管理员可调用的接口没有任何一个返回员工的文件、Session 或对话内容（规格“管理员查询审计”“审计不可经接口修改”“后台不提供员工内容”）。
- [ ] 14.9 后台框架和账号页：后台导航，员工访问后台地址被拒绝；账号列表（搜索、禁用启用、重置密码），区分加载中、空、无匹配、请求失败四种状态，破坏性操作先确认。验证：`pnpm test:ui`——禁用、启用、重置密码各走通一次；四种状态各有用例（请求失败时显示加载失败和重试按钮）。
- [ ] 14.10 实例页：状态、最近启动时间、最近活动时间、最近一次错误（可展开看日志）、重启、重置配置；四种列表状态；重置前显示“会恢复该用户的 DSH 设置，文件和对话保留”并确认。验证：`pnpm test:ui`——出错的实例能看到日志；重启和重置各走通一次；确认框文案正确。
- [ ] 14.11 审计页：按事件类型、邮箱、时间范围筛选，分页；四种列表状态。验证：`pnpm test:ui`——三种筛选各走通一次；翻页正确（规格“界面状态完整”由 14.9 到 14.11 共同覆盖）。

Suggested fixture level: expanded - 管理权限、平台会话失效和对实例的破坏性操作
Minimal mergeable slice: 14.1 加 14.2（管理员鉴权和只读的账号列表接口，约 200 行）

## 15. 模型配置和运行参数后台（任务包 1.12）

依赖：第 8、14 组。

- [ ] 15.1 模型配置接口：读写地址、密钥、模型清单（每项是模型名加可选的上下文窗口）、默认模型；读取时密钥只返回“已设置”或“未设置”；默认模型必须在清单里；写审计（不含密钥）。验证：集成测试——读接口的回应里没有密钥的任何片段；默认模型不在清单里时被拒绝；保存后平台日志和审计里没有密钥原文（规格“模型由管理员统一配置”的“默认模型必须在清单内”场景和“密钥不出现在界面和日志里”）。
- [ ] 15.2 运行参数接口：空闲分钟数、单实例 CPU 和内存、同时运行上限、默认权限档；取值范围校验；写审计。验证：集成测试——越界值（0、非数字）被拒绝并指出范围；合法值保存后读回一致；把同时运行上限从 60 改为 2 后第三个用户的启动得到“已满”（规格“运行参数页”）。
- [ ] 15.3 配置变更的生效：变更后已在运行的实例不变，下次启动用新配置；接口返回“有 N 个运行中的实例仍在用旧配置”。验证：`pnpm test:docker`——改模型清单后，未重启的实例里模型选择器不变，重启后变化；模型选择器里只有已配置的模型且默认选中默认模型（规格“配置变更在下次启动时生效”和“模型选择器只有已配置的模型”场景）。
- [ ] 15.4 模型配置页：表单和校验提示；密钥输入框保存后只显示“已设置”；保存后提示“下次启动实例时生效”并提供“重启全部运行中的实例”。验证：`pnpm test:ui`——填写、保存走通；保存后页面收到的数据里没有密钥（规格“模型配置页”）。
- [ ] 15.5 运行参数页：表单、取值范围提示、保存。验证：`pnpm test:ui`——修改并保存走通；越界值显示提示。
- [ ] 15.6 不配置个人密钥即可完成真实工具调用。加入 `pnpm test:model` 入口（`package.json`、`AGENTS.md`、CI 里在受信任事件上运行）。验证：`pnpm test:model`——管理员配置开发模型后，新员工注册登录，不做任何模型设置，让 Agent 在工作目录写一个文件，文件真实存在（规格“员工无需配置即可对话”，验收 3 的本阶段部分）；`DMXAPI_KEY` 缺失时该命令失败并指出缺少密钥。

Suggested fixture level: expanded - 处理模型密钥，并改变所有实例的生产配置
Minimal mergeable slice: 15.1（模型配置读写接口和测试，约 200 行）

## 16. 权限三档（任务包 1.13）

依赖：第 8、15 组。

- [ ] 16.1 在钉定的 DSH 发行版上查明：三档各对应权限预设表里的哪一项、默认档怎么设、按 Session 切换的界面入口；把对应关系写进 `design.md` 决定 13。验证：决定 13 的表里每一档都有具体的预设标识。
- [ ] 16.2 受管覆盖层按 `settings` 里的默认权限档写入。验证：`pnpm test:docker`——默认档设为 Yolo 时新 Session 是 Yolo；改为人工批准并重启后新 Session 是人工批准（规格“默认权限档由管理员设定”）。
- [ ] 16.3 人工批准档和 Yolo 档的行为。验证：`pnpm test:model`——人工批准档下写文件前出现询问，同意后写入、拒绝后文件不存在；Yolo 档下写入且没有询问；在同一实例的两个 Session 里设不同档位互不影响（规格“人工批准档”“Yolo 档”“三档可选并按 Session 切换”）。
- [ ] 16.4 Auto 档的行为。验证：`pnpm test:model`——在开发模型上审查可用时，普通写文件被放行且没有询问；审查不可用时退为询问。把在开发模型上观察到的结果写进 `design.md` Open Questions 第四条（规格“Auto 档”）。

Suggested fixture level: compact - 改动只是覆盖层里的一个取值，其余是验证
Minimal mergeable slice: 16.1 加 16.2（对应关系和默认档写入，约 80 行；行为验证随后补）

## 17. 两个办公 Agent（任务包 1.15）

依赖：第 7、15 组。

- [ ] 17.1 在钉定的 DSH 发行版上做出一个最小的自定义预设 bundle（一个预设、一句指令），装进镜像的预置配置目录（`profile-seed/` 随之包含）。验证：`pnpm test:docker`——新实例的预设选择器接口里出现该预设。
- [ ] 17.2 `plugins/office-agents/`：`office-general`（默认）和 `office-writer` 两个预设，各有标识、中文名、职责、指令、Skills、工具清单、版本、启用状态；工具清单里没有联网搜索和网页抓取。验证：`pnpm test:docker`——选择器里两个预设都在且默认是综合办公；实例里生效的工具清单不含联网工具；一个检查脚本确认八项字段都有值（规格“预置两个办公 Agent”“办公 Agent 没有联网工具”）。
- [ ] 17.3 手动选择公文写作生成 DOCX。验证：`pnpm test:model`——选择 `office-writer` 提出通知任务，工作目录出现能被解析库打开的 DOCX，正文含标题、主送对象、事项、落款和日期（规格“手动指定专业 Agent 真实生效”）。
- [ ] 17.4 综合办公下的自然语言委派。验证：`pnpm test:model`——在 `office-general` 下提出同一任务，出现一个由该 Session 派生、使用 `office-writer` 预设的子 Session，工作目录出现可打开的 DOCX（规格“自然语言任务由综合办公委派”）。
- [ ] 17.5 把 17.3、17.4 登记为两个预设各自的验收任务，写进 `plugins/office-agents/` 的说明文件。验证：说明文件列出每个预设的验收命令；`DMXAPI_KEY` 缺失时两个任务失败而不是跳过（规格“每个 Agent 有可执行的验收任务”）。

Suggested fixture level: expanded - 改动关键路径 `images/dsh-user/` 的预置内容，并决定每个实例里生效的工具清单
Minimal mergeable slice: 17.1（最小预设 bundle 和它的测试，约 60 行，证明机制可用）

## 18. 部署骨架（任务包 1.16）

依赖：第 12、14、15 组。

- [ ] 18.1 平台镜像 `platform/Dockerfile`：多阶段构建，产物含 `platform/dist`、前端静态文件、迁移文件、`images/seccomp/dsh-user.json` 和生产依赖（含在 amd64 上编译的 better-sqlite3），以非 root 用户运行。验证：构建成功；`docker run --rm <镜像> node platform/dist/cli.js --help` 列出 `admin create`；镜像里 seccomp 文件在配置项默认指向的路径上。
- [ ] 18.2 `deploy/compose.yml`：平台服务（容器名固定为 `dsh-team-platform`），挂载 Docker socket、数据目录、覆盖层目录（宿主和容器内同一路径），只发布平台一个端口；变量来自仓库根目录 `.env.example` 的拷贝，不另建示例文件。加入 `pnpm test:deploy` 入口（`package.json`、`AGENTS.md`、CI）。验证：`pnpm test:deploy`——`docker compose up -d` 后 `/healthz` 正常；创建管理员后能登录后台；配置模型后新员工注册并进入实例（规格“一条命令起全套”，对话部分由 15.6 覆盖）。
- [ ] 18.3 配置校验：平台读取的全部环境变量在启动时校验，必填项缺失或不合法时退出并指名该项；一个检查脚本比对 `config.ts` 读取的变量名和根目录 `.env.example` 里的变量名，接入 `pnpm check`。验证：单元测试——每个必填项缺失时错误信息含该项名；检查脚本在两边不一致时失败（在 `scripts/test-guardrails.sh` 里加这条拒绝用例）；示例文件里没有真实密钥（`gitleaks` 通过）。
- [ ] 18.4 平台数据持久。验证：`pnpm test:deploy`——两个实例运行中时删除并重建平台容器，已有账号能登录，模型配置和审计不变，两个实例不需重启即可继续使用（规格“平台数据持久”和“平台容器被重建”场景）。
- [ ] 18.5 只有平台对外。验证：`pnpm test:deploy`——两个实例运行时，实例容器没有任何端口映射，本部署发布的宿主端口只有平台一个；只有平台容器挂载了 Docker socket（规格“只有平台对外”“实例不暴露宿主端口”）。
- [ ] 18.6 前置代理下的 HTTPS。验证：`pnpm test:deploy`——在 compose 里临时加一个终结 TLS 的代理容器（自签证书），对外地址配为 `https://`、开启仅 HTTPS 发送、代理地址填入受信代理后，登录、工作台和长连接都正常，平台会话 cookie 带 `Secure`，登录的审计记录里来源地址是客户端的而不是代理的（规格“可在前置代理后使用 HTTPS”）。
- [ ] 18.7 部署文档 `docs/DEPLOY.md`：前置条件、构建两个镜像、填写配置、启动、创建管理员、配置模型、在目标机执行沙箱探针，以及本阶段不提供的功能和隔离的已知边界（实例能访问宿主机所在内网的其他地址；模型密钥在实例内可读）。验证：在 giap-vps 上从一份干净的检出只按文档操作，完成 18.2 的全部步骤，结束后删除所有带 `dsh-team` 前缀的容器、镜像、卷和网络；文档里列出了 `instance-isolation` 规格“已知边界写明”要求的每一条（规格“部署文档”“已知边界写明”）。

Suggested fixture level: expanded - 生产配置和交付形态
Minimal mergeable slice: 18.1（平台镜像定义，约 60 行，不影响现有命令）

## 19. 隔离测试和阶段验收（任务包 1.17）

依赖：第 18 组。只放跨组的整套检查；各组自己的测试已在各组内。

- [ ] 19.1 经平台接口越界。验证：`pnpm test:deploy`——用户 B 的平台会话请求任何路径，带上 A 的用户标识、A 的 Session 标识、伪造的转发头，都只到达 B 的实例或被拒绝；B 列不出也打不开 A 的 Session 和文件；员工的平台会话请求管理接口得到 403（规格“用户看不到他人的文件和 Session”“实例不能借平台接口越权”）。
- [ ] 19.2 经长连接越界。验证：`pnpm test:deploy`——B 的长连接里发送指向 A 的 Session 标识的消息，得不到 A 的任何内容。
- [ ] 19.3 从实例内部越界。验证：`pnpm test:deploy`——在 B 的实例里执行命令：读 A 的卷路径、读 Docker socket、连接 A 实例地址的任意端口、不带平台会话请求平台的管理接口、写受管覆盖层文件，全部失败（规格“实例之间网络不可达”“实例没有平台的权限”“受管覆盖层在实例内不可写”）。
- [ ] 19.4 凭据互换和平台数据。验证：`pnpm test:deploy`——把 A 实例的 DSH cookie 和启动令牌拿到 B 的实例上使用被拒绝；在 B 的实例里遍历文件系统和环境变量，找不到平台的数据库文件、任何平台会话令牌和 A 的 DSH cookie；实例容器不是特权模式（规格“A 的 DSH 凭据在 B 处无用”“实例内读不到平台数据”场景）。
- [ ] 19.5 Yolo 档下重复 19.3。验证：`pnpm test:model`——让 B 的 Agent 在 Yolo 档下尝试 19.3 的同一组操作，全部失败（规格“任何档位都不能越过实例边界”）。
- [ ] 19.6 凭据全量扫描。验证：`pnpm test:deploy`——完成注册、登录、对话、改密码、修改模型配置、禁用账号后，在审计表和平台日志里搜索用到的每一个密码、平台会话令牌、DSH 启动令牌、DSH cookie、模型密钥和一条带特定标记的消息原文，一处都找不到（规格“不记录内容和凭据”）。
- [ ] 19.7 审计事件覆盖。验证：`pnpm test:deploy`——19.6 的操作序列加上一次管理员重启、一次重置实例配置和一次空闲回收之后，`audit-log` 规格“记录的事件范围”列出的每一种事件类型在审计里至少各有一条，操作者和对象正确。
- [ ] 19.8 阶段完成条件对照：把验收 1、2、13，以及验收 3、12 的本阶段部分，逐条对应到通过的测试名，写进 `docs/STAGE_1_ACCEPTANCE.md`。验证：文档里每一条验收都有测试名和最近一次运行结果；`pnpm check`、`pnpm test:docker`、`pnpm test:deploy`、`pnpm test:model` 全部通过。

Suggested fixture level: compact - 只新增测试和一份对照文档，不改运行时行为
Minimal mergeable slice: 19.1（经平台接口越界的一组用例，约 150 行，独立于其余用例）
