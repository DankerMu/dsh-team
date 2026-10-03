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

“有没有运行中的任务”怎么从平台侧判断，取决于任务包 1.1 探针的结论，见 Open Questions。

### 10. 受管覆盖层

平台为每个实例生成一份覆盖层文件，整份写入临时文件后原子改名（不追加），以只读方式挂进容器，由 `--patch` 加载（T3）。本阶段的内容：

- `webserver` 监听 `0.0.0.0:3080`。
- 模型：一个 OpenAI 兼容的 provider（地址、密钥所在的环境变量名、模型清单，模型带上下文窗口时写出 `contextWindow`），以及默认模型（F17）。模型地址、密钥、清单、默认模型任一项未配置时不生成覆盖层，也不启动实例，状态接口返回“未配置模型”。
- 去掉每个预设的联网搜索和网页抓取工具（F24）。
- 默认权限档（D23）。
- 界面语言为中文、关闭首次公告（F44）——写法取决于任务包 1.2 探针。

本阶段各实例的覆盖层内容相同；按实例生成是因为阶段 2 的 Office 插件配置每个实例不同，现在就按最终形态建立路径。

文件怎么到容器里：覆盖层目录用“宿主机和平台容器内路径相同”的绑定挂载，平台写文件后把同一路径只读绑定进实例。备选是 Docker 卷的子路径挂载，否决：依赖较新的 Docker 版本，目标机的版本未知。

配置变更在实例下次启动时生效（F20）；后台提供“重启指定实例”和“重启全部运行中的实例”。

### 11. 重置实例配置

停止实例；用用户镜像起一个一次性容器，挂载该用户的状态卷，把 `$DSH_HOME/profiles/` 整个目录换成镜像里 `/opt/dsh-team/profile-seed/` 的内容（后者是 `profiles/` 的完整拷贝，层级相同）；`sessions/`、`storages/`、`attachments/`、`.credentials.yaml` 和整个工作目录卷不动（F7）。之后实例照常启动。

### 12. 用户镜像和容器安全设置

- 基础 `node:24-bookworm-slim`；装 bubblewrap、Python 3 和 `python-docx`（公文写作 Agent 生成 DOCX 用）、pnpm、`@deepseek-ai/dsh@0.2.0-rc.2`；非 root 用户 uid 1001；`DSH_HOME=/data/home`，工作目录 `/data/work`。
- 镜像里预置 `$DSH_HOME/profiles/web/`（含办公 Agent 的 bundle），并把整个 `$DSH_HOME/profiles/` 目录原样拷贝一份到 `/opt/dsh-team/profile-seed/`（即 `profile-seed/web/` 对应 `profiles/web/`）。新用户的状态卷第一次挂载时 Docker 会把镜像里的目录内容带进去（T5 前半，阶段 0 已实测）。
- 容器安全设置由任务包 1.0 的探针定：从 Docker 默认开始逐级放宽，取 DSH 自己的 `bash` 工具在“工作区内修改”模式下可用的最小组合，产出 `images/seccomp/` 下的配置文件。阶段 0 在 arm64 的 Docker Desktop 上需要同时放开 seccomp 和 `/proc` 屏蔽两项（T8）。
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

- **目标机 Ubuntu 22.04 上 shell 沙箱的最终确认。** 由项目方在目标机执行任务包 1.0 交付的探测脚本。在此之前用 VPS 上得到的配置开发。结论不改变规格；只可能改变 `images/seccomp/` 的内容和容器安全选项。
- **DSH 0.2.0-rc.2 的 HTTP 接口实际路径，以及“是否有运行中任务”的判断方式。** 任务包 1.1 的探针回答。已定退路见风险表：找不到可靠信号就只按连接和活动时间判定。结论写回决定 9。
- **预置工作区、中文界面、关闭公告的做法。** 任务包 1.2 的探针回答，结论写回决定 10 和 12。
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
