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

- [ ] 3.1 新建 `scripts/probe-first-run.sh`：用空状态卷起实例，记录首次打开界面时是否需要选择或创建工作区、界面语言、是否弹出公告。验证：脚本输出这三项的现状。
- [ ] 3.2 在探针里依次尝试用受管覆盖层、预置配置目录里的文件、启动参数三种办法，使新实例首次打开即可输入、界面为中文、没有公告；记录每种办法是否生效。验证：输出里三项各有一种生效的办法，或明确写“无法做到”及现象。
- [ ] 3.3 把结论写回 `design.md` 决定 10、12 和 Open Questions 第三条。三项都能做到：写出具体做法（哪个配置键或哪个文件）。有一项做不到：停下来把现象交项目方确认；确认后在同一个 PR 里改写 `instance-lifecycle` 规格“新实例可以直接使用”的要求和场景。验证：这三处写出具体做法；有做不到的项时 PR 描述里有项目方的确认，且规格与设计一致。

Suggested fixture level: compact - 只新增一个探测脚本和文档结论
Minimal mergeable slice: atomic - 三步是一条探测链，只有结论写回才有可合入的产出

## 4. 数据库和基础配置（任务包 1.3 的剩余部分）

依赖：无。

- [ ] 4.1 加入 better-sqlite3 依赖，在 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里登记；`platform/src/db/` 提供打开数据库的函数（开启外键和 WAL，数据库文件权限 0600）。配置项 `PLATFORM_DATA_DIR` 加进 `config.ts` 和 `.env.example`。在 `platform/AGENTS.md` 写明单元测试可以用内存 SQLite。验证：单元测试——内存库上外键约束生效；集成测试——在临时目录打开数据库，文件权限为 0600；`pnpm lint:deps` 通过（只有 `db` 引用驱动）。
- [ ] 4.2 迁移执行器：按编号读取 `platform/src/db/migrations/` 下的 SQL 文件，在一个事务里应用未应用的部分并记入 `schema_migrations`。验证：单元测试（内存库）——空库全量应用成功；再次执行不重复应用；一个迁移里有错误语句时整批回滚、`schema_migrations` 不变。
- [ ] 4.3 第一份迁移：`users`、`platform_sessions`、`instances`（含上游地址和端口）、`settings`、`audit_events` 五张表及索引和约束（邮箱唯一、角色和状态的取值约束、外键）。验证：单元测试——重复邮箱插入失败、非法角色插入失败、删除用户的平台会话行不影响用户行。
- [ ] 4.4 `settings` 的读写函数和默认值（空闲 30 分钟、2 核、4G、同时运行 60、默认权限档 Yolo；模型清单每项是模型名加可选的上下文窗口）。验证：单元测试——空库读到默认值；写入后读到新值；非法取值（负数、未知档位、上下文窗口不是正整数）被拒绝。
- [ ] 4.5 平台启动时打开数据库并应用迁移；`buildApp` 接收数据库句柄。删除 `constraints.yaml` 里 `integration_tests_real_db` 这条延后项，在 `AGENTS.md` 验证矩阵里补上数据库一行。验证：集成测试——重新打开同一数据库文件后数据还在；`pnpm e2e` 通过且数据目录里生成了数据库文件；`pnpm check` 通过。
- [ ] 4.6 基础配置项：平台对外地址、cookie 仅 HTTPS 发送、受信代理列表（默认为空）。加进 `config.ts` 和 `.env.example`；对外地址缺失或不合法时启动失败并指名该项；从对外地址导出 authority 供后续模块使用。验证：单元测试——三项各自的合法和非法取值；缺少对外地址时错误信息含该变量名（`deployment` 规格“配置项明确且缺失时启动失败”的“缺少对外地址”场景）。

Suggested fixture level: expanded - 新建持久化表结构和迁移机制，后续每个模块都依赖它
Minimal mergeable slice: 4.1 加 4.2（驱动、打开函数、迁移执行器和它们的测试，约 250 行；此时没有任何迁移文件，平台行为不变）

## 5. 审计写入（任务包 1.14 的写入部分）

依赖：第 4 组。

- [ ] 5.1 `platform/src/audit/` 提供记录事件的函数：事件类型是一个封闭的列表（见 `audit-log` 规格“记录的事件范围”），每种类型有一份允许出现在细节里的字段白名单，白名单之外的字段被丢弃。验证：单元测试——未知事件类型被拒绝；细节里带 `password`、`token`、`cookie`、`apiKey` 字段时写入的记录里没有这些字段。
- [ ] 5.2 审计查询函数：按时间倒序，按事件类型、账号邮箱（作为操作者或对象）、时间范围筛选，分页。验证：单元测试（内存库）——三种筛选各自只返回匹配的记录；分页的两页不重叠也不遗漏。
- [ ] 5.3 平台日志的脱敏：Fastify 日志配置里屏蔽 `Cookie`、`Set-Cookie`、`Authorization` 请求头和响应头，以及请求体里的密码字段。验证：集成测试——带这些头和字段发请求后，捕获的日志输出里找不到它们的原文。

Suggested fixture level: expanded - 持久化记录，且承担“不落凭据”的安全要求
Minimal mergeable slice: 5.1（事件类型、白名单和写入函数，约 150 行，没有调用方时不改变平台行为）

## 6. 账号（任务包 1.4）

依赖：第 4、5 组。模块在 `platform/src/auth/`。

- [ ] 6.1 密码模块：scrypt 哈希和恒定时间校验，长度规则 6 到 256 位；保留参考实现的版权声明。验证：单元测试——5 位被拒、6 位通过、256 位通过、257 位被拒；同一密码两次哈希结果不同但都能校验通过；错误密码校验失败。
- [ ] 6.2 平台会话模块：签发（32 字节随机令牌，库里只存 SHA-256）、校验、7 天滑动续期（最后活动时间最多每分钟写一次）、按用户全部删除。验证：用可控时钟的单元测试——第 6 天活动后第 12 天仍有效；7 天无活动后失效；数据库里找不到令牌原文。
- [ ] 6.3 注册接口 `POST /_platform/api/register`：邮箱去首尾空格并转小写，重复邮箱返回 409，成功后直接登录；写审计。验证：集成测试覆盖 `account-auth` 规格“邮箱加密码自助注册”和“密码规则”的全部场景，以及“首个管理员由部署命令创建”里的“注册接口不能指定角色”场景（请求体里带管理员角色字段，注册出的账号仍是员工）；`pnpm contract:check` 通过。
- [ ] 6.4 登录和登出接口：登录成功下发 `HttpOnly`、`SameSite=Lax` 的 cookie（`Secure` 按配置）；邮箱不存在和密码错误返回同样的回应；被禁用的账号不能登录；登出删除当前平台会话；写审计。验证：集成测试覆盖规格“登录和登出”“平台会话 7 天滑动续期”和“平台会话令牌不被脚本读取，也不以可用形式落盘”的全部场景。
- [ ] 6.5 来源地址：取直接连接的对端地址；对端在受信代理列表内时改用转发头里的客户端地址；注册和登录的审计记录这个地址。验证：集成测试覆盖规格“来源地址的确定”的两个场景，以及 `audit-log` 规格“代理之后记录真实来源”。
- [ ] 6.6 登录失败限流：同一邮箱加来源地址 15 分钟内失败 10 次后返回 429。验证：用可控时钟的集成测试覆盖规格“登录失败限流”的全部场景（含另一邮箱不受影响、窗口过后恢复）。
- [ ] 6.7 改密码接口：需要当前密码；成功后删除该用户的全部平台会话并为当前浏览器重新签发；写审计。验证：集成测试覆盖规格“改密码”的全部场景（另一浏览器的旧平台会话随即失效；当前密码错误时不改）。
- [ ] 6.8 `Origin` 校验：所有改变状态的平台接口只接受 JSON 请求体，且 `Origin` 必须等于平台对外地址。验证：集成测试——缺少 `Origin`、`Origin` 是别的站点、请求体是表单编码，三种情况都被拒绝且状态不变（规格“改变状态的请求必须来自平台自己的页面”）。
- [ ] 6.9 管理员命令 `platform/src/cli.ts`（`admin create <邮箱>`）：从终端不回显地读密码；邮箱不存在则创建管理员，已存在则提升并可选重设密码；没有终端时拒绝；写审计。验证：测试覆盖规格“首个管理员由部署命令创建”里除“注册接口不能指定角色”（由 6.3 覆盖）之外的全部场景（含非终端环境下退出码非零、参数里带密码被拒绝）。

Suggested fixture level: expanded - 认证、平台会话和公开接口
Minimal mergeable slice: 6.1 加 6.2（密码和平台会话两个模块及单元测试，约 300 行，不新增任何路由）

## 7. 完整用户镜像（任务包 1.5）

依赖：第 1 组；7.3 起依赖第 3 组。

- [ ] 7.1 加入 `pnpm test:docker` 入口（`package.json`、`AGENTS.md` 验证矩阵、CI 任务），在 giap-vps 上按 `.tool-versions` 装好 Node 和 pnpm（装在 ubuntu 用户目录下，不动系统包）；带第一个用例：构建用户镜像，容器里 `dsh --version` 输出钉定版本。验证：`pnpm test:docker` 通过且结束后没有带 `dsh-team-test` 前缀的资源；`pnpm lint:agents` 通过。
- [ ] 7.2 镜像里装 Python 3 和 `python-docx`。验证：`pnpm test:docker`——在断开网络的容器里运行一段生成 DOCX 的脚本，产物能被解析库打开。
- [ ] 7.3 按第 3 组的结论在镜像里预置 `$DSH_HOME/profiles/`，并把整个 `profiles/` 目录原样拷贝到 `/opt/dsh-team/profile-seed/`（层级相同，只读）。验证：`pnpm test:docker`——空状态卷首次启动后卷里的 `profiles/` 与 `profile-seed/` 逐文件一致；改动卷里的 `profiles/` 后镜像里的 `profile-seed/` 不变。
- [ ] 7.4 镜像启动验证：用一份手写的最小覆盖层和第 1 组的安全设置启动容器。验证：`pnpm test:docker`——60 秒内日志里出现令牌行、3080 可连接；不带 cookie 请求首页得到 401；DSH 进程用户不是 root；进程环境里有关闭遥测的变量；状态目录和工作目录是两个挂载点。

Suggested fixture level: expanded - 用户镜像是关键路径，决定每个实例的运行环境
Minimal mergeable slice: 7.1（测试入口和一个用例，约 120 行，不依赖第 3 组的结论，不改镜像）

## 8. 受管覆盖层（任务包 1.6）

依赖：第 3、4 组；8.4 起依赖第 7 组。模块在 `platform/src/managed-config/`。

- [ ] 8.1 生成函数：输入模型设置和默认权限档，输出覆盖层内容（监听地址、OpenAI 兼容 provider、密钥所在环境变量名、模型清单、带上下文窗口的模型写出 `contextWindow`、默认模型、去掉每个预设的联网搜索和网页抓取、界面语言和关闭公告）。纯函数，不做文件操作。验证：单元测试——输出里没有密钥原文，只有环境变量名；联网工具不在任何预设的工具清单里；配置了上下文窗口的模型有 `contextWindow`，没配置的没有。
- [ ] 8.2 覆盖层写入：整份写入临时文件后原子改名，文件权限只读；目录由配置项指定（加进 `config.ts` 和 `.env.example`）；路径由用户标识拼出，标识不合规时拒绝。验证：单元测试（临时目录）——并发写两次后文件是其中一份完整内容，不是混合；写入中途失败时旧文件不变；带 `../` 的标识被拒绝（规格“覆盖层整份生成”）。
- [ ] 8.3 模型地址、密钥、清单、默认模型任一项未配置时，生成函数返回“未配置模型”，不产出覆盖层。验证：单元测试——四项各缺一项时都返回该结果。
- [ ] 8.4 在真实 DSH 上验证受管值不可覆盖：启动实例，在用户自己的配置目录里写入另一个模型地址和联网工具后重启。验证：`pnpm test:docker`——DSH 合成后的配置里模型地址仍是受管值，工具清单里仍没有联网工具，配置了上下文窗口的模型生效值等于配置值（规格“员工不能覆盖受管配置”“去掉联网工具”和“模型的上下文窗口”场景）。
- [ ] 8.5 模型地址不可达时的行为：把模型地址指向一个拒绝连接的地址，另起一个记录请求的替身服务作为“别的地址”写进用户自己的配置。验证：`pnpm test:docker`——发一条消息后 Session 里出现错误，替身服务没有收到任何请求（规格“模型不可用时明确报错”）。

Suggested fixture level: expanded - 写文件、路径安全，且承载模型密钥相关的生产配置
Minimal mergeable slice: 8.1（纯生成函数和单元测试，约 150 行，没有调用方）

## 9. 编排器（任务包 1.7）

依赖：第 4、5、7、8 组。本组用 `published-loopback` 方式够到实例，`network` 方式在第 10 组。

- [ ] 9.1 `platform/src/orchestrator/` 的 Docker 客户端：经 Unix socket 用 `node:http` 发请求、解析 JSON 和流式日志、把 Docker 的错误转成带状态码的错误；传输函数可注入。socket 路径是配置项。验证：单元测试（假传输）——JSON、流式日志和错误三种回应的解析；`pnpm test:docker`——能读到 Docker 版本；请求不存在的容器得到 404 类型的错误；socket 路径不存在时错误信息指出路径。
- [ ] 9.2 卷：按用户创建状态卷和工作卷（带标签），已存在时复用。验证：`pnpm test:docker`——创建两次得到同一对卷；标签含用户标识；两个用户得到四个不同的卷。
- [ ] 9.3 容器创建和启动：名称、主机名、标签、两个卷、只读挂载的覆盖层、启动命令（`--trusted-host` 取 4.6 的 authority）、环境变量（模型密钥、关闭遥测）、非特权；seccomp 文件路径是配置项，读入内容后传给 Docker；3080 只发布到 `127.0.0.1` 的随机端口，上游地址和端口存进 `instances` 表；写审计（实例创建、实例启动）。验证：`pnpm test:docker`——查看容器得到的名称、主机名、挂载和安全选项与设计一致；端口只绑定在回环地址；容器不是特权模式，没有挂载 Docker socket；删除后重建主机名不变（规格“每个实例有唯一且稳定的主机名”）；审计里有这两种事件。
- [ ] 9.4 资源上限：CPU、内存取自 `settings`，另设进程数上限。验证：`pnpm test:docker`——查看容器得到的三项上限等于设置值；改设置后新启动的容器用新值；内存上限设为 256M 时在实例里申请 512M，该容器里的进程被终止，同时运行的另一个实例仍然可用（规格“资源上限”的两个场景）。
- [ ] 9.5 读启动令牌并换 DSH cookie：从容器日志匹配令牌行，用 `node:http` 带平台对外 authority 作为 `Host` 换 cookie，存进 `instances` 表。验证：`pnpm test:docker`——换到的 cookie 带着同一 `Host` 请求首页得到 200，换一个 `Host` 得到 401；日志和审计里没有令牌和 cookie 原文。
- [ ] 9.6 就绪判定和启动失败：就绪时写审计（实例就绪）；60 秒内未就绪则停止容器，状态记为“出错”，存最后 50 行日志（先去掉令牌行），写审计（启动失败）。验证：`pnpm test:docker`——正常启动后审计里有“实例就绪”；用一份故意错误的覆盖层启动，状态变为“出错”，最近一次错误里有日志且不含令牌，审计里有“启动失败”。
- [ ] 9.7 停止和删除：停止容器并删除容器，卷保留；调用方传入停止原因（空闲、管理员、禁用、出错），写审计（实例停止，带原因）。验证：`pnpm test:docker`——在工作目录和状态目录各写一个文件，停止、删除、重新创建后两个文件都在（规格“停止和重建后数据恢复”）；审计里的停止原因等于传入值。
- [ ] 9.8 每用户串行：同一用户的生命周期操作排队执行。验证：单元测试——对同一用户并发发起十次启动，只执行一次创建；对两个用户并发启动互不等待（规格“一个用户恰好一个实例”）。
- [ ] 9.9 同时运行上限：处于“启动中”和“运行中”的实例数达到上限时拒绝新的启动，返回“已满”，不停止已有实例；模型未配置时返回“未配置模型”，不创建容器、不记为出错。验证：`pnpm test:docker`——上限设为 1，第二个用户的启动被拒绝且第一个实例仍在运行；第一个停止后第二个能启动；清空模型设置后启动返回“未配置模型”且没有容器被创建（规格“同时运行的实例有上限”“模型未配置时不启动实例”）。
- [ ] 9.10 平台启动时对账：按标签列出容器，与 `instances` 表比对并修正状态（库里“运行中”但容器不在 → 记为已停止；容器在跑但库里没有 cookie → 停止容器）。验证：`pnpm test:docker`——人为制造这两种不一致后执行对账，状态与 Docker 一致；两个实例运行中时重建编排器对象再对账，两个实例仍被识别为运行中且可访问（规格“平台重启后实例状态一致”的“平台重启时有实例在运行”场景）。
- [ ] 9.11 恢复配置目录：实例停止的状态下，用用户镜像起一个一次性容器，挂载该用户的状态卷，把 `profiles/` 整个换成镜像里 `/opt/dsh-team/profile-seed/` 的内容，其余不动；容器用完删除。验证：`pnpm test:docker`——事先把 `profiles/` 里的配置文件写坏，并在 `sessions/` 放一个文件；执行后 `profiles/` 与 `profile-seed/` 逐文件一致，`sessions/` 里的文件原样，没有残留的一次性容器。

Suggested fixture level: expanded - 持有 Docker socket 的关键路径，涉及并发、持久状态和凭据
Minimal mergeable slice: 9.1（Docker 客户端、单元测试和三个真实 Docker 用例，约 250 行，没有调用方）

## 10. 实例网络（任务包 1.10）

依赖：第 9 组。

- [ ] 10.1 子网分配：从配置的地址段里按 `/28` 分配，已用的子网从 Docker 现有网络读出，不存进数据库；地址段用尽时返回明确错误。地址段是配置项。验证：单元测试——连续分配互不重叠；释放后可再用；地址段不足以放下同时运行上限时平台启动即报错并指名该项。
- [ ] 10.2 每实例网络：启动时创建带标签的 bridge 网络并把实例接入，停止时删除。验证：`pnpm test:docker`——起两个实例，从一个实例里连接另一个实例的地址和主机名的 3080 和其他端口都失败（规格“实例之间网络不可达”的第一个场景）。
- [ ] 10.3 `network` 方式：配置项选择够到实例的方式（`network` 为默认，`published-loopback` 仅供平台进程直接跑在宿主机上时用）；`network` 下实例不发布任何端口，平台容器（名字是配置项）在实例启动时接入该实例的网络、停止时断开，上游地址取容器在该网络里的地址。验证：`pnpm test:docker`——起一个替身容器充当平台容器，实例启动后替身被接入该网络并能从替身里连上实例的 3080；实例容器没有任何端口映射；实例停止后替身不再在该网络里且网络被删除（规格“实例不暴露宿主端口”）。
- [ ] 10.4 对账时恢复网络：平台启动对账时把平台容器重新接入每个运行中实例的网络，接不上的实例停止并记为出错；没有对应容器的实例网络删除。验证：`pnpm test:docker`——两个实例运行中时删除并重建替身平台容器，对账后替身能连上两个实例；人为留下一个无主的实例网络，对账后它被删除（规格“平台容器被重建”场景）。
- [ ] 10.5 起 61 个网络不耗尽地址。验证：`pnpm test:docker`——用平台的分配器连续创建 61 个带 `dsh-team-test` 前缀的网络全部成功，随后全部删除。

Suggested fixture level: expanded - 隔离边界的一部分，涉及共享的地址资源
Minimal mergeable slice: 10.1（纯分配函数和单元测试，约 120 行）

## 11. 网关（任务包 1.8）

依赖：第 6 组；测试用本地替身上游，不依赖第 9 组。模块在 `platform/src/gateway/`。

- [ ] 11.1 路由划分：`/_platform/` 和 `/healthz` 由平台处理，其余路径进网关；未登录时页面请求跳转登录页，其他请求返回 401。验证：集成测试覆盖 `gateway-routing` 规格“平台路径与实例路径分开”的全部场景和“实例由平台会话决定”的两个未登录场景。
- [ ] 11.2 HTTP 转发：上游由平台会话对应的用户决定，不读取请求里的任何实例标识；去掉客户端的全部 `Cookie`，只注入该实例的 DSH cookie；`Host` 改为平台对外 authority；去掉响应里的 `Set-Cookie`。验证：集成测试（替身上游记录收到的请求）——上游收不到平台会话 cookie；浏览器收不到 DSH cookie；上游看到的 `Host` 是平台对外 authority；请求里伪造的实例标识头和查询参数不改变上游（规格“实例由平台会话决定”“DSH 凭据只在平台服务端”和“上游使用固定的对外地址”场景）。
- [ ] 11.3 流式转发：请求体和响应体不缓冲。验证：集成测试——上传和下载各一个 200MB 的流，平台进程的内存增长不超过 50MB，内容校验和一致（规格“大文件上传和下载”场景）。
- [ ] 11.4 WebSocket 转发：在 `upgrade` 事件里做同样的鉴权和改写，校验 `Origin`，然后对接两端 socket。验证：集成测试——双向消息往返成功；未登录的升级被拒绝；`Origin` 不是平台对外地址的升级被拒绝（规格“WebSocket 可用”场景和“长连接只接受来自平台页面的升级”）。
- [ ] 11.5 连接登记和断开：按用户登记所有打开的连接；提供“销毁某用户全部连接”的函数。验证：集成测试——一个用户有两条长连接和一个进行中的下载时调用该函数，三者在 1 秒内全部断开，另一个用户的连接不受影响。
- [ ] 11.6 平台会话失效后的长连接：平台会话被删除后，由它建立的长连接被断开。验证：集成测试覆盖规格“平台会话失效后长连接不再可用”的场景。
- [ ] 11.7 实例未运行时的回应：页面请求被重定向到 `/_platform/wait`，其他请求得到 503 和机器可读的原因（已停止、启动中、已满、出错、未配置模型）；实例状态由注入的查询函数提供。验证：集成测试——五种状态下页面请求都得到指向等待页的重定向，接口请求都得到 503 和对应原因。

Suggested fixture level: expanded - 平台对外的共享入口，承担鉴权和凭据隔离
Minimal mergeable slice: 11.1（路由划分和未登录回应，约 120 行，此时被转发的路径统一返回 503）

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
