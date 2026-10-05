# Design

## Context

动机见 `proposal.md`。本文只写怎么做，以及哪些地方还不知道。

现状：`platform/` 是一个只有 `GET /healthz` 的 Fastify 应用，工程门禁（lint、类型、逐文件覆盖率、模块边界、契约快照、守卫自测、CI）已就绪。阶段 0 在 `verify/phase0/` 里用一次性脚本验证过整条链路的可行性，结论记在 `docs/DSH_Enterprise_Architecture_Analysis.md` 第 3、6 节；那些脚本是证据，不是本阶段代码的起点。

约束：

- DSH 源码不改（D1）。DSH 钉在 npm 发行版 `@deepseek-ai/dsh@0.2.0-rc.2`，一切以发行版的实际行为为准，不以 `resource/deepseek-harness` 的源码为准。
- 平台是一个 Node 进程加一个 SQLite 文件（D2、D19），单机 Docker（D3），Docker socket 只给平台。
- 仓库门禁：模块之间只经 `index.ts` 引用；只有 `db` 模块碰 SQLite；每个 PR 不超过 400 行；`platform/src/orchestrator/`、`images/seccomp/`、`images/dsh-user/` 是关键路径。
- 术语按 `openspec/glossary.md`：平台、实例、受管覆盖层、网关、平台会话、Session。

## Goals / Non-Goals

**Goals:**

- 达到 `docs/IMPLEMENTATION_PLAN.md` 阶段 1 的完成条件：验收 1、2、13 的自动化测试通过；验收 3 的“不配置密钥即可完成真实工具调用”部分通过；验收 12 的“停止或重建后恢复”部分通过。
- 隔离边界从第一天起由自动化测试守住，后续阶段只在其上增加用例。
- 三个探针（沙箱、DSH 接口、预置工作区）先做，结论写回本文的 Open Questions，再做依赖它们的任务。

**Non-Goals:**

- 账号删除。只做禁用和启用。
- 邮箱验证、注册审批、邮箱域名限制、注册数量限制（D4）。
- RAGFlow 的一切：只读代理、插件、知识库选择（阶段 2）。
- Office 的一切：Document Server、ONLYOFFICE 插件、`dsh-better-sidebar` 补丁、字体、HTML 预览沙箱设置（阶段 2）。
- 管理后台的 RAGFlow 连接、插件目录、Agent 目录三个页面（阶段 2、3）；插件页的安装入口处理（F46，阶段 2）。
- 其余八个办公 Agent（阶段 3）。
- TLS 和证书管理（D17）。
- 离线打包、升级、回滚、备份恢复脚本（阶段 3）。
- 容量测量（验收 14，阶段 3）。
- 每用户独立模型密钥、平台模型代理（D7、T12）。
- 运行中任务的断点续跑（F14）。
- 多机部署。

## Decisions

### 1. 路由划分：平台只占 `/_platform/` 和 `/healthz`，其余全部转发给实例

DSH 的界面和接口用根路径下的绝对地址（`/`、`/api/...`、WebSocket），不能挂到子路径下。所以平台自己的页面和接口全部放在 `/_platform/` 前缀下（登录、注册、等待页、管理后台、平台接口），再加已有的 `/healthz`；其余任何路径都由网关转发到当前用户的实例。

- 未登录访问被转发的路径：页面请求跳转到 `/_platform/login`，其他请求返回 401。
- 备选：给每个实例一个子域名。否决：需要通配 DNS 和通配证书，内网部署成本高，且 DSH 的 cookie 绑定 Host，子域名并不带来额外隔离。

### 2. 数据模型：五张表加迁移记录，迁移只向前

| 表                  | 内容                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | 标识（12 位随机小写字母数字，不是邮箱）、邮箱（去首尾空格并转小写后唯一）、密码哈希、角色（`admin` / `employee`）、状态（`active` / `disabled`）、创建时间 |
| `platform_sessions` | 令牌的 SHA-256、用户、创建时间、最后活动时间                                                                                                               |
| `instances`         | 用户（主键）、容器标识、状态、上游地址和端口、DSH cookie、镜像标签、最后一次启动时间、最后活动时间、最近一次错误                                           |
| `settings`          | 键值：模型地址、模型密钥、模型清单（每项是模型名加可选的上下文窗口）、默认模型、默认权限档、空闲分钟数、单实例 CPU 和内存上限、同时运行上限                |
| `audit_events`      | 时间、操作者、事件类型、对象、来源地址、按事件类型白名单过滤后的细节                                                                                       |
| `schema_migrations` | 已应用的迁移编号                                                                                                                                           |

- 迁移是编号的 SQL 文件，平台启动时在一个事务里按序应用未应用的部分；不写回滚脚本。升级前的备份由阶段 3 的部署脚本负责。验证方式是“空库全量应用成功，再次启动不重复应用”。
- 备选：带 up/down 的迁移工具。否决：单文件 SQLite 的回退靠备份文件更可靠，down 脚本是从不执行的第二套代码。
- 驱动是 better-sqlite3（D19）。它是原生模块：`pnpm-workspace.yaml` 要把它列进 `onlyBuiltDependencies`，平台镜像要在 amd64 上构建。
- 模型密钥明文存在 `settings` 里。D7 已接受这把密钥在用户容器内可读，数据库文件权限设为仅平台进程用户可读。

### 3. 密码和平台会话

- 密码：至少 6 位、至多 256 位，无复杂度要求（D20）。scrypt 加 16 字节随机盐，参数随哈希一起存，比较用恒定时间函数。实现参考 `resource/dsh-team-hub/src/passwords.mjs`（MIT，保留版权声明）。
- 平台会话：32 字节随机令牌放在 `HttpOnly`、`SameSite=Lax` 的 cookie 里，数据库只存它的 SHA-256。距最后活动超过 7 天即失效；最后活动时间最多每分钟写一次（D21）。cookie 的 `Secure` 属性由配置项决定（D17）。
- 禁用账号、管理员重置密码、用户改密码时删除该用户的全部平台会话（D21）。
- 登录失败限流：同一邮箱加来源地址 15 分钟内失败 10 次后返回 429，直到窗口过去。计数放内存，平台重启即清零。这一条不在压测清单里，是为“开放注册加弱密码”补的最小防护；备选是不做，代价是任何人可以对任一邮箱无限次试密码。
- 来源地址：取直接连接的对端地址；只有对端地址在“受信代理”配置项列出的地址里时，才改用该代理写入的转发头里的客户端地址。受信代理默认为空，此时转发头一律忽略。限流和审计都用这个地址。这一条同样不在压测清单里：不做的话，放在前置代理之后（D17）限流会退化为只按邮箱，任何人错输 10 次就能让别人 15 分钟登不上。
- 改变状态的平台接口只接受 JSON 请求体并校验 `Origin` 等于平台对外地址；WebSocket 升级同样校验 `Origin`。

### 4. 首个管理员：平台镜像里的一条命令

`node platform/dist/cli.js admin create <邮箱>`，从终端交互读取密码（不回显）。邮箱不存在则创建管理员；已存在则提升为管理员，并可选择重设密码（D18）。命令直接读写数据库，不经过 HTTP。没有终端时拒绝执行，不接受从参数或环境变量传密码。

### 5. 编排器：直接调用 Docker Engine API，不引入客户端库

平台用 `node:http` 经 Unix socket 调用 Docker Engine API。用到的只有容器的创建、启动、停止、删除、查看、读日志，以及网络和卷的创建、删除、连接、断开。

- 备选：dockerode。否决：多一个依赖树，离线交付和供应链检查都要多带一份，而用到的接口不到十个。
- 命名（`<id>` 是用户标识）：容器 `dsh-team-u-<id>`，主机名 `u-<id>`（T7），卷 `dsh-team-home-<id>` 和 `dsh-team-work-<id>`，网络 `dsh-team-net-<id>`。所有资源带标签 `dsh-team.user=<id>`。
- 状态以 Docker 为准、数据库为索引：平台启动时按标签列出容器，与 `instances` 表对账。
- 同一用户的生命周期操作串行执行（每用户一把进程内的锁）。
- 启动命令是 `dsh --profile web --patch <覆盖层> --no-open --trusted-host <平台对外 authority>`（T4），环境变量注入模型密钥和 `DSH_TELEMETRY_DISABLED=1`。
- 容器安全设置的 seccomp 文件随平台镜像交付，路径是配置项；编排器创建容器时读入文件内容传给 Docker（Engine API 要的是内容，不是宿主路径）。
- 资源上限：`NanoCpus`、`Memory` 取自 `settings`（默认 2 核、4G，D22），另设进程数上限。
- 同时运行上限：处于“启动中”和“运行中”的实例数达到上限（默认 60）时，新的启动请求被拒绝，不停止任何已有实例（D22）。

### 6. 启动令牌和就绪判定

编排器读容器 stdout，匹配 `dsh web: http://.../?token=<令牌>` 这一行；用 `node:http` 带上 `Host: <平台对外 authority>` 请求 `/?token=...` 换到 DSH cookie（T2；`fetch` 不能改 Host，换到的 cookie 会绑错 authority）；cookie 存进 `instances` 表。每次启动都重新换一次，不依赖旧 cookie 仍然有效。

就绪 = 令牌行出现、换到 cookie、带 cookie 请求 `/` 得到 200。60 秒内未就绪则停止容器，状态记为“出错”，把最后 50 行容器日志存为最近一次错误，供后台查看。

### 7. 网络：每个实例一个网络，子网由平台分配

每个实例一个独立的 bridge 网络（T9）。实例启动时平台容器接入该网络，停止时断开并删除网络。平台容器自己的名字是配置项（compose 里固定为 `dsh-team-platform`）。平台启动对账时，把平台容器重新接入每个运行中实例的网络（平台容器被重建后原有的接入都没了）；接不上的实例停止并记为出错；没有对应容器的实例网络删除。不同 bridge 网络之间默认不互通，所以实例之间不可达。

- 子网由平台从一个配置的地址段里按 `/28` 分配并在创建网络时显式指定。原因：Docker 默认地址池只够约 31 个 bridge 网络，60 个实例会耗尽。
- 实例需要访问模型地址（开发期是公网的 dmxapi，生产是内网的 sub2api），所以网络不设为 `internal`。实例因此也能访问宿主机所在内网的其他地址，这一点列在风险里。
- 平台如何够到实例有两种方式，由配置项选择：
  - `network`（生产和 compose 部署）：平台在容器里，经上述网络用容器地址访问实例的 3080 端口。实例不发布任何宿主端口（F10）。
  - `published-loopback`（只用于平台进程直接跑在宿主机上，即在 VPS 上跑 `pnpm test:docker` 的时候）：实例把 3080 发布到 `127.0.0.1` 的随机端口。平台不在容器里时没法接入实例网络，没有这个方式编排器的测试就跑不起来。这个方式下 F10 不成立，所以隔离测试只针对 compose 部署运行。

### 8. 网关

- 被转发的请求：去掉客户端带来的全部 `Cookie`（平台会话令牌不进实例），只注入该实例的 DSH cookie；`Host` 改为平台对外 authority（T1）；响应里的 `Set-Cookie` 去掉。
- WebSocket：在 HTTP `upgrade` 事件里做同样的校验和改写，然后把两端的 socket 直接对接。不解析帧，不引入 WebSocket 库。
- 请求体和响应体都按流转发，不缓冲，上传下载不受内存限制。
- 实例由平台会话决定，不读取请求里的任何实例标识（F9）。
- 网关按用户登记所有打开的连接。禁用账号时：标记禁用、删除平台会话、销毁该用户的全部连接、停止实例，按这个顺序在一次操作里完成（F3）。
- 实例未运行时：页面请求被重定向到 `/_platform/wait`；其他请求得到 503 和机器可读的原因（已停止、启动中、已满、出错、未配置模型）。等待页调用 `POST /_platform/api/instance/start`（幂等，登录后进入和出错后重试都走它）并轮询 `GET /_platform/api/instance`，就绪后回到工作台。启动只有这一个入口，登录本身不启动实例。

### 9. 空闲停止

网关记录每个用户的活动连接数和最后活动时间。一个后台定时器每分钟检查一次：实例处于“运行中”、没有任何活动连接、没有运行中的任务、且这一状态已持续达到配置的空闲分钟数（默认 30，D5），就停止它。

采用 DSH `0.2.0-rc.2` 的 `POST /api/session/list`：平台带该实例的 DSH cookie 和匹配的 Host，发送 `client-request` envelope（`method: "session/list"`，`payload: { args: { _request: {} } }`），读取成功 `server-response` 的 `result.value.items[].running`。任一条为 `true` 表示有运行中任务；只有完整、有效的列表全部为 `false` 才可判空闲。请求失败、超时、响应结构不符均为未知，不得据此停止实例。生产回收实现须覆盖全部 Session（若列表分页，遍历全部页或验证服务端运行中过滤），不能把不完整列表当作空闲。

任务包 1.1 在 giap-vps（Ubuntu 24.04 / amd64、Docker 29.1.3）通过实际 Web UI 完成三次真实工具任务：HTTP 值每次均为运行中 `true`、结束后 `false`，实例累计 1–3 个 Session。运行窗口由工具创建的开始/完成标记独立确认，结束还等待 UI 停止生成控件消失。WS `/api/remote.mux` 的 `api-session/status` 在采样窗口内仅观察到结束 `false`，运行中为未知，不采用；宿主扫描状态目录返回 `EACCES`，不采用文件通道。本结论只覆盖该发行版与本次小规模样本，不宣称 WS/文件永远不可用；未走 F13 退路，默认空闲时间仍为 30 分钟。

### 10. 受管覆盖层

平台为每个实例生成一份覆盖层文件，整份写入临时文件后原子改名（不追加），以只读方式挂进容器，由 `--patch` 加载（T3）。本阶段的内容：

- `webserver` 监听 `0.0.0.0:3080`。
- 模型：一个 OpenAI 兼容的 provider（地址、密钥所在的环境变量名、模型清单，模型带上下文窗口时写出 `contextWindow`），以及默认模型（F17）。模型地址、密钥、清单、默认模型任一项未配置时不生成覆盖层，也不启动实例，状态接口返回“未配置模型”。
- 去掉每个预设的联网搜索和网页抓取工具（F24）。
- 默认权限档（D23）。
- 中文界面和无首次公告（F44）的已验证机制是 `plugins/zh-locale/`：客户端通过公开的 `ctx.locale.setLocale('zh')` 在每次加载时设置中文，canonical `cordis.patch.yml` 插入该插件并仅停用 `ui-settings-models` 行。2026-10-04 在 giap-vps 的 DSH `0.2.0-rc.2`、非 loopback hostname、English navigator 下，首次进入和真实页面刷新均通过中文、无公告、输入及清除标记判据，consoleErrors 为空；不是 loopback 对照的替代结论。
- 原配置/文件/启动参数方法的负结果保留：宿主 `locale.config.preference: zh` 和 `ui-settings-general.config.welcomeNoticeVersion: "2026-09-28.1"` 不控制远程浏览器；`ui-settings-models.config.credentialOnboarding: false` 只关闭独立 API-key 引导。项目方选择“扩大到插件或镜像定制”，没有批准需求降级；受管配置生成（#29）应复用插件的 canonical patch，不再把这三个无效/不完整的键当作远程首次进入配方。
- 停用的组件拥有员工个人 provider/密钥管理页及公告、API-key 引导，不是模型执行或切换服务。D6/F17/F18 要求模型由管理员统一配置，未要求保留该个人管理页。独立的 `ui-model-selection`、composer 模型位和 `/model` 保留在 roster；实际 UI 已验证 General 设置可用，并列出、逐个选择两个配置模型。无模型消息提交，不修改 DSH 源码、不伪造 native/localhost 权限、不以 CSS 隐藏或永不完成的 onboarding 步骤遮挡公告。

本阶段各实例的覆盖层内容相同；按实例生成是因为阶段 2 的 Office 插件配置每个实例不同，现在就按最终形态建立路径。

文件怎么到容器里：覆盖层目录用“宿主机和平台容器内路径相同”的绑定挂载，平台写文件后把同一路径只读绑定进实例。备选是 Docker 卷的子路径挂载，否决：依赖较新的 Docker 版本，目标机的版本未知。

配置变更在实例下次启动时生效（F20）；后台提供“重启指定实例”和“重启全部运行中的实例”。

### 11. 重置实例配置

停止实例；用用户镜像起一个一次性容器，挂载该用户的状态卷，把 `$DSH_HOME/profiles/` 整个目录换成镜像里 `/opt/dsh-team/profile-seed/` 的内容（后者是 `profiles/` 的完整拷贝，层级相同）；`sessions/`、`storages/`、`attachments/`、`.credentials.yaml` 和整个工作目录卷不动（F7）。之后实例照常启动。

### 12. 用户镜像和容器安全设置

- 基础 `node:24-bookworm-slim`；装 bubblewrap、Python 3 和 `python-docx`（公文写作 Agent 生成 DOCX 用）、pnpm、`@deepseek-ai/dsh@0.2.0-rc.2`；非 root 用户 uid 1001；`DSH_HOME=/data/home`，工作目录 `/data/work`。
- 镜像里预置 `$DSH_HOME/profiles/web/`（含办公 Agent 的 bundle），并把整个 `$DSH_HOME/profiles/` 目录原样拷贝一份到 `/opt/dsh-team/profile-seed/`（即 `profile-seed/web/` 对应 `profiles/web/`）。新用户的状态卷第一次挂载时 Docker 会把镜像里的目录内容带进去（T5 前半，阶段 0 已实测）。
- 任务包 1.2 已验证工作区文件机制：`$DSH_HOME/storages/workspace.json` 使用 `unit: { name: "workspace", version: 2 }`、`global` 和 `tables.workspaces`，目标记录的 `path` 为 `/data/work`。新实例读取预置记录后选中 `work`，其 Session cwd 也是 `/data/work`；发现阶段产生的 Session 标识不是生产种子契约。生产镜像预置仍由任务 7.3 实现，本 PR 不把测试状态整树复制进镜像。`workspace-controller.config.documentsDirectory` 会追加 `deepseek-harness/default-workspace`，不能直接替代 `/data/work` 记录。
- 中文插件的交付文件为 `plugins/zh-locale/{package.json,index.js,client.js,cordis.patch.yml}`；放到 `$DSH_HOME/profiles/web/node_modules/@dsh-team/zh-locale/`，再应用 canonical patch。探针复制同一组文件并记录哈希，运行前严格比对 `dsh --version` 与插件精确 peer pin；不运行包管理器、不联网安装。#27 的镜像预置和 #29 的受管配置生成应复用这些文件及版本约束；本次 bind-mount 探针不冒充 Docker 命名卷首次填充或生产镜像升级验证。
- 2026-10-03 在 giap-vps（amd64、Ubuntu 24.04、Linux `6.8.0-117-generic`、Docker 29.1.3）实测最小额外放宽集合为空：Docker 内嵌默认即能让 DSH `0.2.0-rc.2` 的真实 `bash` 工具在“工作区内修改”模式下写工作区并拒绝写状态目录。另对交付的 `images/seccomp/dsh-user.json` 独立验证通过：该文件与 Moby `seccomp/v0.2.3` 默认策略语义相同，不追加 syscall allow，不增加 capabilities，不使用 `systempaths=unconfined` 或 privileged；来源哈希及显式调用见 `images/seccomp/README.md`。两次均保留 Landlock partial-ABI 警告。阶段 0 的 arm64 Docker Desktop 需要 seccomp 与 `/proc` 两项放宽（T8），与本次不同；差异根因未证明，不能由 VPS 结果替代目标机验证。
- 探针是一个可重复执行的脚本：在项目方的 VPS（amd64，Ubuntu 24.04）上由 Agent 执行（D16）；目标机 Ubuntu 22.04 上由项目方再执行一次。本阶段其余需要 Docker 的构建、测试和整套部署也都在这台 VPS 上做（D16）。VPS 上只创建带 `dsh-team` 前缀的镜像、容器、卷和网络，结束时删除，不动机器上其他项目的东西。

### 13. 权限三档

| 档位     | 行为                                               |
| -------- | -------------------------------------------------- |
| 人工批准 | Agent 写文件或执行命令前询问员工                   |
| Auto     | 由模型逐次审查，放行的不询问（DSH 的 Auto review） |
| Yolo     | 不询问，完全权限                                   |

三档对应 DSH 权限预设表里的哪几行、怎么设默认档，由任务包 1.13 在发行版上确认后写进受管覆盖层。默认档初始为 Yolo（D23），存在 `settings` 里，后台可改。

### 14. 办公 Agent

`plugins/office-agents/` 是一个 DSH bundle：`office-general`（综合办公，默认预设）和 `office-writer`（公文与材料写作）两个预设，各带人设、Skills 和工具清单。bundle 在镜像构建时装进预置的配置目录。自定义预设 bundle 的写法在阶段 0 没有验证过，所以这一组的第一个任务是在发行版上做出一个最小可用的预设。

### 15. 平台前端

`platform/web/` 是一个 React 18 加 Vite 的工作区包，构建为静态文件，由平台在 `/_platform/` 下提供。页面：登录、注册、改密码、等待页、管理后台（账号、实例、模型配置、运行参数、审计）。第一个界面 PR 同时补上 Playwright 基线和验证矩阵的界面行（`constraints.yaml` 里登记的延后项到此解除）。

### 16. 部署骨架

`deploy/compose.yml` 定义平台服务：挂载 Docker socket、数据目录（SQLite 文件）和覆盖层目录（宿主和容器内同一路径）。变量只列在仓库根目录的 `.env.example` 一份文件里，compose 用它的拷贝。启动步骤：构建用户镜像和平台镜像，`docker compose up -d`，再执行一次创建管理员的命令。

### Sketch seams under test

1. **平台 HTTP 接口，经真实 TCP 端口**（已有：`buildApp` 加 `listen`）。账号、管理接口、网关的转发规则都从这里测；网关的上游用测试里起的一个本地 HTTP/WebSocket 服务顶替。理由：这是平台对外的唯一入口，测它就测到了路由、鉴权和改写的组合。
2. **Docker Engine API，对 VPS 上真实的 Docker（D16）**。编排器的测试真的创建、启动、停止、删除带 `dsh-team-test` 前缀的容器、卷和网络。理由：编排器的全部风险在于它和 Docker 的真实交互，替身测不出命名、标签、挂载和网络的错误。
3. **compose 部署，从外部看**。用 HTTP 和 WebSocket 客户端走完注册、登录、对话，再用 `docker exec` 进实例做越界尝试。理由：隔离和验收只在整套部署上才成立（见决定 7）。

不为模块内部函数另开测试边界；模块内的逻辑由各自的单元测试覆盖。逐文件 80% 的覆盖率门禁只统计单元测试，所以每个源文件仍要有同目录的单元测试：Docker 客户端接收一个可注入的传输函数，单元测试注入假的；`db` 模块的单元测试用内存 SQLite。对真实 Docker 的测试在 `platform/test/*.docker.test.ts`，由 `pnpm test:docker` 运行，不计入覆盖率。

## Not yet specified

- 镜像升级后，老用户状态卷里 `profiles/` 目录的同步（T5 后半）。现在只知道“重置实例配置”能强制恢复；升级时怎样既更新插件又不丢用户的个人设置，问题本身还说不清。
- Document Server 如何访问各实例网络里的 3080 端口（阶段 2）。决定 7 的网络模型要能容纳它，但接法未定。
- 审计日志的保留期限和清理。
- 平台进程重启时，员工已打开的长连接怎样恢复才算可接受。
- 同时运行上限 60 是否合适，要等阶段 3 的容量测量。

## Risks / Trade-offs

- [目标机上沙箱不可用] → 任务包 1.0 最先做；VPS 是 amd64 但系统是 Ubuntu 24.04，不能替代目标机的确认。退路按实施计划：默认档已是 Yolo，以容器为唯一边界，需项目方确认。
- [找不到可靠的“运行中任务”信号] → 退为只按连接和活动时间判定，并把默认空闲时间调长；浏览器关闭后仍在运行的任务可能被回收，F14 本就不承诺续跑。这是对 F13 的偏离，走退路前要项目方确认，并在同一次改动里改写 `instance-lifecycle` 规格。
- [预置工作区、中文界面、关闭公告在发行版上做不到] → 做不到的那一项如实记录现象，交项目方确认后改写 `instance-lifecycle` 规格的对应要求；不靠改 DSH 源码解决（D1）。
- [Auto review 在开发模型上不可用] → 记录现象，Auto 档暂时等同人工批准，生产联调时用 `qwen3.6` 重测。
- [better-sqlite3 是原生模块] → 平台镜像在 amd64 上构建并随镜像交付；pnpm 需要显式允许它的构建脚本。
- [实例能访问宿主机所在内网的其他地址] → 实例需要访问模型地址，不能断网；本阶段不做出站白名单，列入隔离测试的已知边界并在文档里写明。
- [模型密钥在数据库里是明文，在实例里可读] → D7 已接受；数据库文件权限收紧；日志和审计的细节字段经白名单过滤。
- [默认 Yolo 下 Agent 可能写坏实例配置] → “重置实例配置”在本阶段交付；受管覆盖层只读挂载，写不动。
- [平台是单点，持有 Docker socket] → 等同宿主机 root。平台接口全部要求平台会话，管理接口要求管理员角色；编排器是关键路径，改动需人工逐行审查。
- [依赖模型的验收测试需要密钥和公网] → 这类测试单独成组，在 VPS 和受信任的 CI 事件上运行（VPS 上密钥取自 `~/.config/dsh-team/env`）；密钥缺失时明确失败而不是全部跳过。CI 要用它，需要项目方在仓库里配置 `DMXAPI_KEY`。
- [单个 PR 不超过 400 行] → 任务按模块和验证路径切细；生成的锁文件和契约文件不计入。

## Migration Plan

没有存量数据和存量部署。合入顺序就是 `tasks.md` 的分组顺序；每组合入后 `main` 保持可运行。回滚 = 回退对应提交；数据库迁移只向前，开发期的回退方式是删除数据库文件重建。

## Open Questions

- **目标机 Ubuntu 22.04 上 shell 沙箱的最终确认。** VPS 已验证“钉定 Moby 默认 seccomp、零额外安全放宽”，配置和调用方式见 `images/seccomp/`；删除额外放宽项的集合为空，不虚构删除试验。移除 Landlock syscall allow 的临时更严策略使真实工具报告 `SANDBOX_UNAVAILABLE`，作为独立负对照。项目方仍须在 Ubuntu 22.04 执行同一探针并验证显式交付策略；若不可用，记录各级失败原因并交项目方确认，不能自动降为无 shell 沙箱。
- **DSH 接口和运行中任务信号已由任务包 1.1 确认。** 实际 UI 观察到 `/api/session/create`、`/api/session/prompt` 等 HTTP 路径及 WS `/api/remote.mux`；采用 `POST /api/session/list` 的 `result.value.items[].running`，三次真实任务均观察到 `true → false`。协议、未知状态处理和观测限制见决定 9；完整阶段路径清单由 `pnpm probe:dsh-api` 输出，不采用 F13 退路。
- **首次进入已由任务包 1.2 验证。** 工作区采用上述 `storages/workspace.json`；中文及无公告采用 `plugins/zh-locale/` 和其 canonical roster patch（见决定 10、12）。项目方授权扩大机制而非降低要求；非 loopback 首次进入、刷新、General 设置和两个配置模型的 UI 切换均通过，缺失/错误插件及恢复公告组件的反例被拒绝。`instance-lifecycle` 原验收要求保留；生产镜像预置和受管配置接线仍由 #27/#29 实现。
- **Auto review 在开发模型上是否可用。** 任务包 1.13 验证；不可用时 Auto 档暂时等同人工批准。
- **`qwen3.6` 上的工具调用、子 Agent 委派、Auto review。** 留到生产联调，本阶段不处理。

## Issue #4 implementation boundary

- Change surface: `images/dsh-user/Dockerfile`; task 1.1 only.
- Must preserve: platform `/healthz`, all existing checks, upstream DSH source, and unrelated VPS resources.
- Must add: the minimal Node 24 bookworm image, bubblewrap, pinned pnpm and DSH, uid 1001, writable `/data/home` and `/data/work`, and telemetry disabled.
- Governing invariant: a successful image build contains the exact pinned DSH release and runs commands as uid 1001 with separate writable state and work directories.
- Sibling surfaces: npm installation, build-time version assertion, runtime `dsh --version`, effective uid, filesystem ownership, environment, and later sandbox probe consumers.
- Seams under test: real Docker build/run on giap-vps; existing platform checks locally.
- Required evidence: pinned build exits 0; `dsh --version` identifies `0.2.0-rc.2`; `id -u` returns 1001; both directories are writable; `pwd` is `/data/work`; telemetry is `1`; pnpm and bubblewrap execute.
- Failure evidence: nonexistent DSH version causes a nonzero build exit; a deliberately incorrect expected-version assertion rejects an otherwise installed release.
- Non-goals: Python/DOCX, profile seeds, office agents, web readiness, seccomp selection, Docker test harness, or platform behavior. These have separate issues.
- Resource safety: use uniquely named `dsh-team` resources, remove only resources this verification creates, and leave no test containers or tagged images.
- Review focus: exact-version validation is not a substring match; non-root permissions; no secrets or privileged options; task 1.1 scope.
- Merge gate: changes under `images/dsh-user/` require human white-box review of every diff line.

## Issue #5 implementation boundary

- Change surface: `scripts/probe-sandbox.sh` and its smallest required release-tool driver; task 1.2 only.
- Governing invariant: a level is usable only when the pinned release's actual DSH `bash` tool in Workspace Write mode writes the workspace and rejects writes to DSH state; a raw bubblewrap check is insufficient.
- Must preserve: task 1.1 image contract, unrelated host resources, all platform behavior, and upstream DSH source.
- Must add: an executable probe that builds the image and tries Docker default, a narrowly relaxed custom seccomp policy, then that policy plus `systempaths=unconfined`; prints results/reasons and the first usable level, or exits nonzero if none works.
- Sibling surfaces: image builder, custom-policy producer, Docker launch arguments, release tool invocation, permission context, result parser, and cleanup on success/failure/interruption.
- Seams under test: real Docker on giap-vps and the installed npm release's tool boundary, without requiring a probabilistic model response.
- Required evidence: real `bash` write/read of a workspace marker succeeds, state marker is absent after the tool rejects its write; each attempted level reports its result. Unsupported levels fail closed rather than bypassing sandboxing.
- Failure evidence: an all-levels-fail run exits nonzero with reasons; interrupt a running probe and verify cleanup; clean exit leaves no resources created by the run.
- Resource safety: unique `dsh-team` names, targeted cleanup, no global prune, no secrets, no privileged mode or `seccomp=unconfined`; preserve probe exit status if cleanup fails and report cleanup failures.
- Non-goals: choosing/committing final `images/seccomp/dsh-user.json`, target Ubuntu 22.04 execution, and writing final minimum-policy conclusions into decision 12 (owned by #6).
- Review focus: real release/tool provenance, no success from shell text alone, denied state writes, smallest security relaxation, and exact cleanup ownership.

## Epic execution review timing

On 2026-10-03 the user confirmed PR #108 had received human review and explicitly moved subsequent human critical-path review to one batch after all Epic #3 issues and PR merges. Each affected PR records that decision and the deferred review list; runtime, agent-review, CI and fix-pass gates remain mandatory.

## Issue #6 implementation boundary

- Change surface: `images/seccomp/dsh-user.json`, its options/provenance note, and measured conclusions in decision 12 / Open Questions 1; tasks 1.3/1.4 only.
- Governing invariant: ship no unmeasured security relaxation; real DSH Workspace Write must permit the workspace and deny state writes using the exact delivered settings.
- Must preserve: pinned DSH, non-root uid 1001, platform behavior, upstream DSH source, and unrelated VPS resources.
- Measured input: #5 found Docker's embedded default usable on giap-vps via Landlock. This does not yet prove that a separately downloaded Moby profile is identical or usable.
- Candidate artifact: unmodified pinned Moby default seccomp JSON (`seccomp/v0.2.3`, SHA256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`), with no extra syscall allows, no capabilities, no systempaths relaxation.
- Required evidence: fresh probe chooses default; separately use the exact shipped JSON as `security-opt seccomp=<file>` with the existing real-tool driver and assert workspace exact bytes / state denial. Compare policy semantics with the pinned upstream source; formatting may change bytes but not policy.
- Minimality evidence: if both default and the pinned artifact work with zero added relaxations, there are no relaxation items to remove. Record that fact explicitly; do not call an unrelated syscall deletion the required relaxation-removal test or invent a non-minimal configuration to manufacture one.
- Sibling surfaces: upstream profile provenance, shipped JSON parser compatibility, Docker launch options, real release driver, docs consumed by #28/#36, and target-host verification.
- Failure evidence: a disposable deliberately restrictive policy must fail the real tool control; this demonstrates a negative control, not equivalence to the empty relaxation-removal set.
- Non-goals: Ubuntu 22.04 execution (project party), orchestrator behavior, modifying the probe, speculative attribution of native-Linux / Docker-Desktop differences.
- Review focus: distinguish embedded-default evidence from explicit-profile evidence; report partial Landlock ABI warning and unsupported-host limits; no extra privileges or silent fallback.
- Packaging: retain readable upstream policy rather than minify to evade the line limit; if it exceeds 400 lines, use the repository's `diff-limit-exempt` mechanism with vendored-policy provenance/atomicity justification in the PR.
- Human review: `images/seccomp/` is a critical path; the PR must declare human white-box review of every changed line and record the user's epic-end deferral plus an entry in the deferred-review ledger.

## Issue #7 implementation boundary

- Change surface: `scripts/probe-dsh-api.sh`, minimal probe driver/support under `scripts/`, root command entry, and measured decision 9 / Open Questions 2; no platform runtime or idle-reaper implementation.
- Governing invariant: the adopted signal must distinguish an actually running DSH task from idle in three observed cycles; unknown/error/disconnected cannot silently mean idle.
- Must preserve: DSH npm `0.2.0-rc.2`, source unchanged, explicit Host-based launch-token exchange, existing platform checks, and unrelated VPS services/resources.
- Must add: start a disposable instance, exchange launch token server-side, drive the actual Web UI through homepage/new Session/message/running/completed phases, and record observed HTTP paths and WS addresses (secrets removed).
- Required signal evidence: try HTTP responses, WS events and test-owned state-directory metadata; record running/idle values or explicit unavailability for each method in each of three cycles. Use real submitted/completed tasks, not a mocked status source or static code-derived endpoint list.
- Browser evidence: use an actual browser on giap-vps; capture request events and at least a screenshot of the exercised UI, with no new unhandled browser console errors. Source inspection may discover candidate routes but is not runtime proof.
- Model boundary: use the configured `DMXAPI_KEY` environment and baseline endpoint/model for real test messages when needed; missing credentials must fail explicitly. Never inspect/print the secret file or values; no model content in output artifacts.
- Secrets: strip token/query credentials, cookies, Authorization, model keys and message content from logs, screenshots and endpoint inventories; do not print raw container startup logs.
- Sibling surfaces: launch/Host exchange, browser HTTP+WS traffic, task lifecycle, all three signal channels, redaction, failure exits/timeouts, and container/browser/temp-resource cleanup.
- Required success: a named predicate with running/idle samples from three cycles, concrete observed paths per phase, clean shutdown, then write measured conclusions. Do not assume the running field or route from newer upstream source.
- Required failure: unsupported channels explicitly recorded; missing browser/model/API prerequisite fails rather than fabricating a signal; all probes bounded and owned resources cleaned on failure/interruption.
- Stop rule: if no reliable signal is observed, report “未找到可靠信号”, preserve findings and request project-party confirmation of the specific longer-idle fallback before changing the spec or task 2.3 completion.
- Non-goals: gateway, idle-reaper production code, real user data, Ubuntu 22.04 execution, guessing future signal behavior beyond measured release.

## Issue #8 implementation boundary

- Change surface: `scripts/probe-first-run.sh`, minimal first-run probe support, shared probe helpers refactored in place when needed, root command entry, a minimal production-usable client plugin under `plugins/`, its canonical roster patch and measured decisions 10/12/Open Questions 3. User-approved scope expansion is recorded in PR #114. No production image preseed or managed-config module implementation.
- Governing invariant: every successful first-run claim must be observed on fresh instance state and a fresh browser profile using only declared deployed artifacts. The acceptance driver must not dismiss UI, select the workspace or mutate locale/settings; only the deployed plugin may apply its intended locale default.
- Must preserve: pinned DSH npm `0.2.0-rc.2`, upstream source unchanged, #7's actual API probe behavior, explicit Host token exchange, existing security profile and unrelated VPS resources.
- Required baseline: an empty state volume and clean browser report workspace selection requirement, actual UI language and Preview Notice presence independently, including honest unknown/error states.
- Required method matrix: attempt managed overlay, preseeded configuration/state files and supported launch arguments in that order; report each method's result for all three goals with concrete reason/key/file/argument. Unsupported launch flags must be established from the actual release help/parser, never guessed from newer sources.
- Approved composition candidate: a dependency-free client plugin uses the released public locale service to set Chinese on each load; its canonical patch disables only the `ui-settings-models` roster row and inserts the plugin. Probe trial copies/mounts the deliverable plugin itself, not a probe-only duplicate; no package-manager/network install in the trial. Pinned version mismatch, failed registration, or unexpected roster must fail visibly.
- Freshness: separate disposable state/work volumes and browser profile per method trial; no baseline dismissals, browser storage or state modifications leak into candidates. If different methods satisfy different goals, verify their combined concrete recipe on another fresh instance before claiming success.
- Authority control: baseline and every accepted recipe must also run with a non-loopback browser hostname representative of the platform gateway, while the actual Docker port stays bound to 127.0.0.1. Use a per-browser resolver mapping and explicit trusted Host/token-cookie authority; no host-wide DNS edits or native privileged transport injection. A loopback-only success is not a production-ready method.
- Attribution: each trial reports/asserts its declared browser hostname/mode and English navigator language; Chinese must come from instance configuration, not the verifier's browser locale. Loopback-only discovery may reveal persisted keys, but the final fresh recipe must survive the non-loopback settings path.
- Discovery may use ordinary UI changes on a separate disposable instance plus a bounded before/after state/config diff to find persisted keys. Discovery results and source inspection are hypotheses until a fresh-state runtime test succeeds.
- Browser evidence: real Chrome on giap-vps; wait for the actual app/settings readiness rather than document.readyState alone. Observe a usable non-inert composer and Chinese visible controls; prove input accepts a non-secret marker without submitting a model message. Observe no Preview Notice after initialization, not merely before its async render. Capture pre-message screenshot and new console errors for every adopted recipe.
- Composition readiness: absence of WelcomeNoticeStore is not by itself a success. Independently observe the delivered boot roster excluding `ui-settings-models`, including the deployed plugin and existing model-selection plugin, plus actual ready/rendered settings/session UI, Chinese controls, no Notice and successful input marker type/clear. Retain the original store-readiness oracle for unmodified trials. Missing/misloaded plugin, delayed initialization and unknown roster remain harness-inconclusive, never a successful no-Notice verdict.
- Preservation evidence: reload the composition candidate without browser storage prepopulation or UI dismissal and repeat acceptance; verify composer model selection can list and select configured models without submitting a model message, and General settings remain reachable. Wrong/missing plugin or re-enabled settings-models must be rejected by the oracle. Keep all original method outcomes explicit.
- Canonicality: reuse/refactor #7's CDP, UI and lifecycle helpers in place; no copied token exchange, launch, cleanup or browser transport. Do not invoke #7's automatic notice/workspace setup as the acceptance oracle for a supposedly preconfigured trial.
- Secrets and resources: no model request or key is needed to verify first-entry UI; do not read secrets. Keep token/cookie internal, output only safe allowlisted observations. Use only uniquely owned `dsh-team` Docker resources, bounded operations, exact cleanup and retained non-secret evidence.
- Sibling surfaces: baseline versus method state/profile roots, server settings versus browser storage, overlay precedence and file ownership, launcher argument parsing, UI readiness and false-negative notice detection, shared #7 helper callers, success/failure/interruption cleanup.
- Required verification: baseline-to-candidate behavioral contrast; matrix and fresh combined recipe; missing prerequisites or malformed trial fail loudly; unsupported methods remain explicit; independent leftover query and `pnpm check`. If shared #7 runtime behavior changes, rerun its actual three-cycle probe.
- Stop rule: the initial three-method negative result triggered project-party confirmation; on 2026-10-04 the user authorized plugin/image customization, not a requirement waiver. Evaluate the scoped composition candidate against unchanged F15/F44. If it fails or requires upstream source/privilege changes, preserve evidence and return for a project decision rather than weakening the requirement or marking 3.3 done.
- Non-goals: editing upstream DSH, production image preseed/config generation (#27/#29), user data, model/tool requests in the first-run probe, Ubuntu 22.04 validation, accepting browser-storage prepopulation as server-side instance preseed. Rollback is removal/revert of the repo-owned plugin and its patch; preserve the measured baseline, never hide a failed candidate behind automatic fallback.

## Issue #9 implementation boundary

- Scope: `platform/src/db/` open/migrate API and sibling tests, a real temporary-file integration test, better-sqlite3 dependency and generated lockfile/build allowlist, `PlatformConfig.dataDir`, `.env.example`, and the in-memory SQLite exception in `platform/AGENTS.md`. Existing config literal callers may receive the required field mechanically; no HTTP behavior changes.
- Public seam: `db/index.ts` exports the database open function and migration runner; only `db` imports the driver. Open accepts a database filename (`:memory:` for unit tests); a successful file connection uses WAL, foreign keys enabled and file mode 0600. Caller owns close; initialization failure releases acquired handles and propagates the error.
- Config: `PLATFORM_DATA_DIR` defaults to `./data`, allows a nonempty directory path, rejects blank/NUL with the variable named, and is parsed only in `config.ts`. Parsing does not create directories or open databases. Startup connection/migration wiring remains #12.
- Governing invariant: the whole pending migration batch and its applied-number records commit together or leave database data/schema and prior migration records unchanged; never one transaction per file. Already applied migrations do not execute again.
- Migration input: trusted repository-authored numbered SQL files, numeric order (including 2 before 10), with applied numbers recorded in `schema_migrations`. Duplicate numbers or malformed SQL filenames fail before applying a partial batch. No production migration files exist until #10; an absent default migrations directory is an empty initial set, while an explicitly supplied nonexistent directory is an error.
- Sibling surfaces: memory versus file connection, new versus existing file permissions, WAL sidecars, parent-directory creation, handle lifetime on open failure, numeric discovery versus ledger identity, first application versus replay versus failed later migration, config parser and all typed config callers.
- Required evidence: real memory foreign-key rejection; file open under a permissive process umask still produces 0600 before application writes; file WAL and close/reopen retain a sentinel. Migrations run in numeric order, replay without duplicates, and a later failing SQL file rolls back earlier pending DDL/data and ledger additions while preserving already applied rows. Missing default directory is allowed; missing explicit input, duplicate numbers and invalid SQL filenames fail. Tests close handles and remove owned temporary resources.
- Test discipline: implementer authors focused tests first and returns for parent RED execution before completing the corresponding behavior; no mocks of SQLite. Parent independently smokes the exported API, not merely tests the tests. Native dependency versions are exact and satisfy the existing seven-day minimum age; only `pnpm install` updates the lockfile.
- Non-goals: account/settings/audit schema (#10), repositories/default settings (#11), application database startup and the deferred-control/matrix change (#12), deployment networking/config (#13), ORM, down migrations, live multi-process migration coordination, untrusted SQL/plugin discovery. Trusted data paths are administrator-controlled, not HTTP input.
- Rollback: revert this issue's code/dependency/config change; existing HTTP behavior is unchanged because no application database is opened yet. Failed migrations do not require a reverse script because the pending batch transaction is atomic.

## Issue #10 implementation boundary

- Deliver `platform/src/db/migrations/1-initial.sql`, consumed only by the existing `applyMigrations`. Root `pnpm build` copies the SQL directory beside `dist/db/migrate.js`, replacing only its generated destination to avoid stale migrations. This minimal packaging configuration is part of delivering task4.3, not a new loader.
- Persisted names use snake_case; timestamps are caller-supplied integer Unix epoch milliseconds. Text primary keys are explicitly NOT NULL. No SQL default clock, account generation, passwords, tokens or settings defaults are introduced.
- `users`: `id`, `email`, `password_hash`, `role`, `status`, `created_at`; all required. Email UNIQUE stores the application-normalized value (trim/lowercase belongs to registration #18); do not claim SQLite ASCII collation implements Unicode normalization. Role is `admin|employee`, status `active|disabled`. User-ID generation/validation stays at the account boundary.
- `platform_sessions`: `token_hash` primary key, `user_id` foreign key, `created_at`, `last_activity_at`; all required. Multiple sessions per user; index `user_id` for revocation. Deleting sessions never deletes users. Foreign keys use default restrictive deletion, not account-deletion support.
- `instances`: `user_id` primary key/foreign key, required `status` constrained to `stopped|starting|running|error`; nullable `container_id`, `upstream_host`, `upstream_port`, `dsh_cookie`, `image_tag`, `last_started_at`, `last_activity_at`, `last_error` accommodate pre-start state. Port, when present, is integer1–65535. Index status for running-capacity/reconciliation queries. Full/unconfigured are request outcomes, not persisted lifecycle states.
- `settings`: required `key` primary key and `value` text. Values/defaults/validation belong to #11.
- `audit_events`: integer `id` primary key, required `created_at`, `event_type`, `details` text; nullable `actor_email`, `target_email`, `target`, `source_address`. Email snapshots support unknown-email login failures, system events and stable history; they are not foreign keys and cannot cascade away. `target` also permits non-account objects. Event allowlist and detail filtering/JSON serialization belong to #14. Index `(created_at,id)`, `(event_type,created_at)`, `(actor_email,created_at)` and `(target_email,created_at)` for the specified chronological/filtered queries.
- Required proof: valid rows in all five tables; exact-email duplicate and invalid role/account/instance status rejected; orphan session/instance rejected; duplicate instance ownership rejected; deleting one user's sessions preserves both users and the other user's sessions; nullable pre-start instance and anonymous audit accepted; migration replay preserves inserted rows and one applied-version record.
- Runtime proof loads each source and compiled public API with no explicit migration directory, creates a fresh owned file DB, writes/reads representative rows, reopens and reapplies without loss. Built proof must not read source SQL. No DSH, network or user data touched; close handles and remove owned temporary resources.
- Rollback is revert before deployment; no down migration. Once deployed, later schema changes use another numbered migration. This issue does not wire startup, repositories, event redaction or routes.

## Issue #11 implementation boundary

- Add `readSettings(db)` and `writeSettings(db, patch)` plus the used `Settings` type via `db/index.ts`; nested model/tier types remain private until consumers need named exports. Use the existing `settings(key,value)` table, one JSON-encoded row per setting using its API field name as key. No migration, dependency, route, startup or caching layer.
- Owned fields: `idleMinutes` positive safe integer default30; `cpuCores` finite positive number default2 (fractional cores allowed); `memoryMiB` positive safe integer default4096 (4GiB, convert to Docker bytes at orchestration boundary); `maxRunningInstances` positive safe integer default60; `defaultPermissionTier` one of `approval|auto|yolo`, default`yolo`; `models` defaults to a fresh empty array, entries `{name: string, contextWindow?: number}` with nonblank name and optional positive safe-integer context window. Explicit null/undefined contextWindow is invalid; absence preserves DSH default.
- Scope is these task4.4 values. Model address/key/default-model fields and default-model membership belong to the model-configuration slice #77; that slice must extend this canonical repository rather than create a second settings implementation. Stable tier IDs are platform values, not guessed DSH preset IDs (#83).
- Read missing owned keys as defaults without inserting rows; validate present JSON/type/value and fail with the field name on corruption, never silently replace invalid stored data with defaults. Reads return independent values, so caller mutation cannot change defaults or persistence. Unowned stored keys remain untouched and are not returned.
- Write accepts a non-null object of owned fields, rejects unknown fields and invalid values before database mutation, preserves omitted fields, and commits all supplied rows in one transaction. Empty patch is a no-op. Error messages identify fields without echoing supplied/stored values. No URL probes, JSON schema library, secret handling or business authentication added.
- Evidence: parent-run staged RED/GREEN for defaults, overwrite/partial preservation, fractional CPU and all tiers, model context omission/positive boundaries, invalid numeric/type/tier/model cases, unknown fields, corrupt JSON/value and rollback after a later write fails. Actual file-backed source and compiled API smoke must close/reopen and retain settings; memory tests close handles and do not create file databases.
- Rollback is revert before consumers ship; schema and existing rows remain unchanged. Preserve previous DB/migration/build tests and HTTP behavior. Whole-slice `pnpm check` and same-head CI remain required.

## Issue #12 implementation boundary

- Compose existing `openDatabase(join(config.dataDir, 'platform.db'))`, `applyMigrations` and `buildApp` in `main.ts`, before listening. Do not add a file-opening wrapper solely to obtain a new test seam: the process entrypoint is already covered by built e2e, while database operations retain their unit/integration tests. No new coverage exemption or threshold change.
- `buildApp(config, database, logDestination?)` requires an existing handle; no implicit database/default overload. It does not open files or migrate. Caller owns the handle until construction succeeds; then app shutdown closes it through `onClose`. Startup catches migration/build/listen failures, closes the currently owned handle/app and exits nonzero before reporting healthy. SIGINT/SIGTERM use existing app shutdown.
- Update main, all five app tests, health TCP integration and OpenAPI generator atomically. Driver types outside db must be derived/imported through `db/index.ts`, never directly from better-sqlite3. The generator uses an isolated memory DB and closes it on success/failure, without touching PLATFORM_DATA_DIR. No new app-db decorator or route is needed before a real consumer exists.
- Permit the app's injected in-memory SQLite in unit tests in platform/AGENTS.md; retain the prohibition on file-backed unit databases. This is necessary to verify real app-owned handle lifetime rather than mock-forwarding assertions, not a coverage-gate relaxation.
- Extend the existing real-file integration surface to migrate, store settings, build/close the app, reopen the same file and retain data with one migration record. Add a meaningful close-lifetime assertion. Root e2e owns a fresh temporary PLATFORM_DATA_DIR, probes health, asserts platform.db and applied schema/ledger, then stops/reaps the process and removes only its own log/data directory on all exits.
- Remove only the `integration_tests_real_db` deferred-control block; add matching database verification rows in root AGENTS.md and constraints.yaml using `pnpm test:integration`, and record the built database assertion under e2e. Ignore root `/data/` now that normal dev startup creates it. No business routes, schema/default changes, model/auth logic, migrations framework or gate exclusions.
- Required evidence: parent-observed lifecycle RED/GREEN; root `pnpm check`, `pnpm e2e`, strict OpenSpec and guardrail self-test after the constraints change. Independently launch source and compiled entrypoints with owned data directories, observe health only after schema exists, persist/restart a sentinel and verify graceful close; invalid database input must fail without a listening healthy server. Contract generation remains unchanged and leaves no data directory.
- Rollback: revert startup/caller/config-doc cutover without deleting persistent data. This slice touches no listed critical path; helper-type exports must have actual callers and no compatibility shim.

## Issue #13 implementation boundary

- Extend `PlatformConfig` with required `publicUrl`, `authority`, `cookieSecure`, `trustedProxies` fields. Parse only in `config.ts`; no helper export without a consumer. Update all typed config literals mechanically (app tests, DB/TCP integration and OpenAPI generator), the e2e launch environment and the CI dev-server smoke step's explicit local origin. No new routes, cookies, Origin enforcement or proxy-header trust behavior yet.
- `PLATFORM_PUBLIC_URL` is required, with no localhost fallback. Accept an absolute HTTP(S) origin with hostname/IP and optional port, optionally one trailing `/`; reject credentials (including empty userinfo), non-root paths, query/fragment markers, whitespace/control characters, backslashes, malformed authority and port0/out-of-range. Parse with the platform URL implementation, not a custom hostname/IP parser; canonical `publicUrl = url.origin` and `authority = url.host` come from the same URL, preserving nondefault ports and bracketed IPv6 and normalizing default ports/case.
- `PLATFORM_COOKIE_SECURE` defaults to false for HTTP local deployment; when set accept exactly `true` or `false`, not other spellings or an empty value. It remains independent of public URL scheme because TLS termination is external (D17).
- `PLATFORM_TRUSTED_PROXIES` defaults to an empty array. Empty/whitespace-only means no trusted proxy; otherwise parse comma-separated, trimmed IPv4/IPv6 literals validated with `node:net.isIP`. Reject empty members, hostnames, CIDR ranges, wildcard or invalid addresses; no DNS lookup, trust-all, deduplication or implicit loopback trust. Address comparison/mapped-IPv6 handling belongs to #20, not this parser.
- `.env.example` documents the three exact names and syntax, including a local origin example; root environment notes list all actual variables. E2e supplies its dynamic local origin before starting the process; CI dev smoke supplies `http://127.0.0.1:8080` to match its default listener, without adding a production fallback. The generator uses explicit inert config values, never deployment env. Errors name the offending variable without echoing its supplied value.
- Required proof: staged RED/GREEN for missing/invalid URL, valid HTTP/HTTPS/port/IPv6 normalization, strict boolean and empty/valid/invalid proxy lists. Existing port/log/data-dir tests receive a valid required URL so their intended failures remain visible. Source and built startup with missing/invalid configuration must exit nonzero before data directory creation/listening; valid configuration retains e2e health/schema and unchanged OpenAPI.
- Rollback is revert config/caller/example changes; no persistent data conversion. No dependency, schema or gate change, and no DSH/public-url flag confusion: `authority` is a future fixed Host/trusted-host input, not a DSH launcher option.

## Issue #14 implementation boundary

- Add `recordAuditEvent(db, event)` through `audit/index.ts`, consuming `DatabaseHandle` only from `db/index.ts`. Insert parameterized values into the existing audit table; no driver import, migration, repository abstraction, route or business caller.
- Event envelope: `type`, caller-supplied `createdAt` (integer Unix epoch milliseconds), optional `actorEmail`, `targetEmail`, `target`, `sourceAddress`, and optional `details`. Missing metadata becomes SQL NULL. Metadata is trusted service-selected identity/object/source information, not a raw request payload; email normalization and proxy resolution belong to callers.
- Closed identifiers map to the spec in order: `account.registered`, `login.succeeded`, `login.failed`, `logout.succeeded`, `password.changed`; `account.disabled`, `account.enabled`, `password.reset`, `admin.created`, `admin.promoted`, `model-config.updated`, `runtime-config.updated`, `instance.restarted`, `instance.config-reset`; `instance.created`, `instance.started`, `instance.ready`, `instance.stopped`, `instance.start-failed`. Unknown identifiers, including prototype names, fail before insertion without echoing input. No `platform.started` event is inferred from schema fixtures.
- Every event has an explicit detail allowlist: empty except `instance.stopped`, which requires `reason` equal to `idle|admin|disabled|error`. Discard all other keys before serialization, without traversing their values. Missing/invalid/structured stop reason fails with a constant field-named error and no row; never pass arbitrary object/array/Error/toJSON values through a permitted key.
- Governing invariant: persisted details contain only event-specific safe fields, never arbitrary credentials or content. No freeform message/error/config payload. Caller-selected metadata cannot be classified for arbitrary secrets by this writer; failed login stores the attempted email in `actorEmail`, not credentials in details.
- Sibling surfaces: existing schema/DB exports, future auth/admin/instance producers and query consumer. Preserve column names, timestamp units, nullable snapshots, transaction ownership and DB error propagation. No catch-and-ignore, implicit transaction, clock, logging or delete/update API.
- Permit audit unit tests to use isolated in-memory SQLite through the public db module in platform/AGENTS.md, narrowly alongside existing db/app exceptions; file-backed DB tests remain integration-only. Flag this rule-file change for human review; no coverage/gate relaxation or fake production caller.
- Required proof: staged RED/GREEN for persisted metadata, closed event rejection, discarded credential/content details and required stop reasons. Test all four reasons, prototype names, structured allowed values and propagated DB write failures using real rows; close every handle. Source and compiled public-API smoke writes an owned temporary file, reopens it and proves persistence without losing existing migration/settings behavior.
- Non-goals: tasks5.2/5.3, caller integration, source-IP trust, arbitrary metadata-secret detection, audit retention and distributed ordering. Rollback is code revert before callers ship; existing rows/schema remain untouched. Review focuses on membership checks, projection before serialization, no partial writes and coverage of every event category.

## Issue #15 implementation boundary

- Add `queryAuditEvents(db, query)` through `audit/index.ts`, returning an array of rows with `id`, `createdAt`, `type`, nullable `actorEmail`, `targetEmail`, `target`, `sourceAddress`, and parsed `details` (`unknown`). Keep types private unless a real consumer needs their named exports. Consume only the existing public DatabaseHandle; no schema/index/driver changes.
- Query requires `page` (one-based) and `pageSize`, both positive safe integers; `(page - 1) * pageSize` must also be safe. Reject invalid pagination with a constant field-named error, without echoing input. No defaults, total count, hasMore or arbitrary new size cap; the future HTTP boundary owns request limits.
- Optional `eventType`, `email`, `from`, `to` filters: exact event type; exact email matches `(actor_email = email OR target_email = email)`, never generic `target`; inclusive epoch-millisecond time endpoints. All supplied filters combine with AND. Unknown event/email or reversed time range returns `[]`; no writer-enum coupling or email normalization in this reader.
- Governing invariant: on a fixed dataset, filtering precedes pagination and total order is `created_at DESC, id DESC`; equal timestamps cannot duplicate/omit rows across pages. Offset pagination does not promise a snapshot across concurrent writes. Values, including quoted strings and pagination, are SQL parameters; SQL fragments are only static owned clauses.
- Parse persisted JSON once per returned row; malformed JSON fails with a constant error, never a raw JSON.parse error echoing stored content. DB errors propagate. Writer remains the sole detail allowlist owner; query does not re-filter or mutate records, open/close handles, start transactions, or log payloads.
- Sibling surfaces: #14 writer/metadata and existing audit schema/indexes; future admin query endpoint #73 consumes this canonical reader. Tests seed via public writer except deliberate malformed-storage case, using the existing audit memory-DB permission. Preserve existing writer tests and rows.
- Evidence: staged RED/GREEN for mapped rows/order, each filter and their intersection, actor-or-target matching (including both roles once), inclusive/open-ended bounds and equal-timestamp page boundaries. Empty/out-of-range pages, SQL-like strings, invalid pagination, malformed JSON and DB errors get explicit oracles. Source and compiled file-backed write/reopen/query smoke plus `pnpm check` and strict OpenSpec.
- Non-goals: HTTP/page/auth enforcement, retention, count queries, concurrent snapshot cursors, schema migration and business callers. Rollback is code revert with no data deletion. Review focuses on OR parentheses, total order, LIMIT/OFFSET validation and storage-to-public mapping.

## Issue #16 implementation boundary

- Extend existing `LOG_REDACT_PATHS` in `app.ts`, not a new logger/sanitizer abstraction. Cover normalized lowercase `authorization`, `cookie`, `set-cookie` under both `req.headers` and `res.headers`, plus `req.body.password`; retain existing `*.password`, `*.token`, `*.apiKey` protection and `[redacted]` censor. No new production header/body logging hooks or serializer expansion.
- Governing invariant: supported structured credential fields do not reach the configured log destination in plaintext, while HTTP request values and response headers remain unchanged. Path redaction does not sanitize arbitrary interpolated messages; callers must never interpolate secrets/content.
- Installed Fastify5 defaults serialize request metadata and response status only, omitting headers/body. Test ordinary incoming/completion logs as omission protection, not as evidence redaction executed. Keep method/URL/request ID/status and configured logger level/destination; preserve app DB ownership, `/healthz` and production OpenAPI.
- Nonvacuous integration seam: actual `buildApp` on port0, captured destination, test-only schema-bearing route. Its request logger child uses supported serializer options exposing actual request `{headers,body}` and reply `{headers,statusCode}`; inherit the production redactor unchanged, with no mock/replacement logger or test redaction settings. This exercises redaction when a child serializer exposes sensitive fields without expanding production logging.
- Send distinct synthetic markers in all three request and response header names, a password body field and array-valued response Set-Cookie. Assert every secret absent from the full captured output, exact censor values at exposed fields, and harmless sibling headers/body fields retained. Assert original request/body values and actual HTTP response credentials remain intact after logging.
- Keep meaningful unit protection for structured user password/token/apiKey, but remove its misleading claim that default-serialized req headers exercised redaction. Real-TCP integration replaces that vacuous portion. Include a controlled error-log entry with a safe constant message to prove the same structured policy at error level; no credential-bearing error interpolation.
- Sibling surfaces: logger construction, Fastify request/response serializers, child logger inheritance, log destination, app lifetime and future auth routes. Tests close app/DB on failure and success. Required evidence is parent-observed leak RED then GREEN, root integration/full checks, unchanged contract and throwaway source/compiled real-server smoke emitting only safe pass summaries.
- Non-goals: recursive arbitrary-object scrubbing, password aliases not yet introduced, all-capital log-object keys (HTTP normalizes names), content logging, auth routes and audit persistence. Rollback is configuration/test revert, no persisted data conversion.

## Issue #17 implementation boundary

- Add `auth/password.ts`, `auth/session.ts`, sibling unit tests and public exports in `auth/index.ts`. No routes, cookie policy, account repository, migration, dependency or audit caller. Permit auth unit tests narrowly to use isolated memory SQLite through db/index in platform/AGENTS.md, retaining file-backed tests in integration; flag this rule change for human review.
- Password API: async `hashPassword(password): Promise<string>` and `verifyPassword(password, encoded): Promise<boolean>`. Length is 6–256 Unicode code points, no trim/normalization; invalid hash input throws a constant rule error, invalid verification input/record returns false. Future route validators must use the same character semantics.
- Use asynchronous Node scrypt with N16384/r8/p1/keylen64 and a fresh 16-byte random salt, encoded as `scrypt$16384$8$1$64$<32 lowercase hex salt>$<128 lowercase hex hash>`. Derive with decoded salt bytes. Verify only this exact bounded format and parameter set before derivation; malformed/unknown/cost-modified records return false, no caller-selected work factors. Compare equal-sized derived buffers with timingSafeEqual. Operational crypto errors propagate without credential logging.
- Reference resource/dsh-team-hub/src/passwords.mjs supplies algorithm/parameters, not synchronous scheduling or its permissive record parsing. Preserve `Copyright (c) 2026 dsh-team-hub contributors` and the full MIT permission/disclaimer from its LICENSE in the adapted source; no compatibility with the reference's separate salt/hash API is required.
- Session API: `createSession(db, userId, now)` returns a 32-random-byte lowercase hex token; store only its SHA-256 hex digest with user_id and created_at/last_activity_at equal to caller-supplied epoch-ms now. `validateSession(db, token, now)` returns userId or null; `deleteUserSessions(db, userId)` revokes all that user's sessions. All use the public DatabaseHandle; clock values are explicit trusted service inputs, not timers/global state.
- Governing invariant: no usable token is persisted, and expired/revoked sessions cannot be revived by validation. Hash presented tokens for lookup; unknown or malformed token returns null. Check expiry before renewal: elapsed >7 days is expired, exact7 days remains valid per normative spec. Update last_activity_at only when elapsed >=60,000ms; smaller or backward-clock deltas never rewrite it. Throttled persistence implies at most59,999ms renewal granularity; no hidden in-memory activity cache.
- Validation returns identity only, never password_hash; disabled-account login/request authorization belongs to subsequent auth callers and account-state checks, not this storage primitive. No single-token logout helper before #19 needs it. Expired rows need not be deleted here; no sweep/retention work. DB failures propagate and caller transaction ownership is preserved.
- Required proof: password5/6/256/257 boundaries including Unicode, independently salted hashes both verify, wrong password false, malformed/cost-changed record false; real crypto, no mocks. Session tests seed users with real password hashes and isolated memory DB; exact digest/no plaintext, distinct sessions, digest-as-token rejection, day6→day12 sliding validity, exact7day/+1ms expiry,59,999/60,000ms writes, backward-clock no rewrite and per-user revocation isolation.
- Sibling surfaces: users/password_hash and platform_sessions schema, public db ownership, future registration/login/change-password/admin callers. Source/compiled public-API file-backed smoke persists/reopens password and session, validates/renews/revokes with controlled time and scans stored values for token/password absence. Root checks and strict OpenSpec required; no timing benchmark masquerading as constant-time proof.
- Non-goals: HTTP authentication responses, cookie attributes, rate limits, disabled-account policy, single-session logout and automatic expired-row cleanup. Rollback is code revert before callers ship, preserving rows; no alternate hash implementation or shim.
