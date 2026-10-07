# 企业内网 DSH 多用户办公平台：阶段 0 架构分析

日期：2026-10-03。依据：`docs/DSH_Enterprise_Requirements_Standalone.md`（下称“需求”）、四个本地仓库源码、本机 Docker 实测。

证据标注：**【实测】** 本机 Docker 跑过；**【源码】** 读过实现代码；**【文档】** 只读了 README 或类型声明；**【推断】** 由前几类推出，未单独验证；**【未验证】** 需要后续联调。

## 0. 结论

1. **主底座：新建薄管理层，功能以 DSH 插件实现，DSH 源码不改。** TeamHub 和 Hub 都不能作主底座。
2. **主链路已实测跑通**：网关登录态 → 每用户独立容器 → OpenAI 兼容模型 → 工具调用 → 子 Agent → 文件落盘，两个用户互不可见。
3. **实测发现四个会直接影响实施的事实**（详见第 3.6 节）：
   - 默认 Docker 安全策略下 DSH 的 shell 沙箱不可用，`bash` 工具直接拒绝执行；需要同时放宽 seccomp 和 `/proc` 屏蔽两项才能用。
   - 本地 DSH 源码领先于 npm 发行版 `0.2.0-rc.2`，源码里有的参数发行版里没有。
   - TeamHub 所用的 DSH 接口调用方式在 0.2.0-rc.2 上返回 404，TeamHub 无法直接代理这个版本。
   - ONLYOFFICE 插件的文档 key 含容器主机名，编排器必须给每个用户容器设唯一主机名。
   - ONLYOFFICE 插件与当前 `better-sidebar` 0.24.1 不能直接配合，需要在镜像构建时给 `better-sidebar` 打一个小补丁；打完后编辑保存全流程实测通过。
4. **两处经项目方决定的需求偏离**：自助开放注册（偏离需求第六节）；全员共用模型密钥并直接注入容器（偏离需求第七节“受限、可撤销”）。

## 1. 仓库基线

| 仓库 | 版本 | 分支 | 提交 | 未提交修改 | 许可证 |
|---|---|---|---|---|---|
| `resource/deepseek-harness` | 0.2.0-rc.2 | master | `da00f7f535` | 无 | MIT |
| `resource/dsh-team-hub` | 0.2.7 | main | `24eb47e` | 无 | MIT |
| `resource/dsh-hub` | 1.0.4 | master | `e0e06afa0b` | 无 | MIT |
| `resource/dsh-sidebar-onlyoffice` | 0.2.0 | main | `ad2b929` | 无 | MIT |

- `dsh-sidebar-onlyoffice` 于本次分析中克隆到 `resource/`。
- 另参考了两个仓库外项目：`/Users/danker/Documents/31308/open-webui-ocu`（ONLYOFFICE 设计文档）和 `/Users/danker/Desktop/AI-vault/xagent`（RAGFlow 接入代码，分支 `dagent`，`214ff6c`）。
- **DSH 本地检出不等于发行版**【实测】：npm 上的 `@deepseek-ai/dsh@0.2.0-rc.2` 发布于 2026-09-29，本地 master 是 2026-10-03 的提交。发行版没有 `--public-url` 参数，本地源码有（`packages/bundle/web-app/src/startup.ts:60-66`）。平台必须钉住一个发行版并以该发行版的行为为准。

## 2. 三仓库能力对照

### 2.1 dsh-team-hub：不能作主底座，可捡零件

| 项 | 结论 | 依据 |
|---|---|---|
| 每用户独立实例 | 不存在。只有一个标量 `upstream` | `src/config.mjs:6,17`；`src/server.mjs:75,340-343`【源码】 |
| 隔离方式 | 路径前缀归属 + WebSocket 逐帧过滤，全员共用一个 DSH 进程 | `src/policy.mjs:37-47`；`src/ws-filter.mjs`【源码】 |
| 实例生命周期、容器 | 不存在 | 全 `src/` 无相关代码【源码】 |
| 路线图 | 无每用户实例；只在 “Later” 提多主机注册 | `docs/roadmap.md`【文档】 |
| 邮箱登录 | 不支持，用户名正则不含 `@` | `src/config.mjs:49-52`【源码】 |
| 禁用账号 | 只撤销登录 token，已建立的 WebSocket 不断开 | `src/admin-api.mjs:362`；`src/server.mjs:329-335`【源码】 |
| DSH 0.2.0 兼容 | 带有效 cookie 按 TeamHub 的方式 `POST /api/session.list`、`/api/host.describe`、`/api/llm.providers`，0.2.0-rc.2 均返回 404。当前的实际路径未核实 | 【实测】 |
| 会改写 DSH 安装文件 | 是，改 `dsh-client-ui-settings/lib/client.js` | `src/patch.mjs:21-27,111-123`【源码】 |

- **可直接复用**：`passwords.mjs`（scrypt + 随机盐）、`users.mjs`、`auth.mjs`（会话 token）、`audit.mjs`（脱敏、滚动）、`admin-ui/` 的壳和用户/审计页。合计约 1,300 行，唯一运行时依赖 `ws`。
- **仅作参考**：`server.mjs` 的登录与反向代理骨架、`spa-shim.mjs`。
- **新架构下无用**：`ws-filter.mjs`、`policy.mjs` 的归属判断、workspaces 归属视图。

### 2.2 dsh-hub：不复用代码

| 项 | 结论 | 依据 |
|---|---|---|
| 用户模型 | 不存在。库表无 user、role、owner 列 | `hub-storage/.../schema.ts:69-155`【源码】 |
| 登录 | 硬依赖 Cloudflare Access，内网无法启动 | `auth.ts:91-99`；`bin.ts:191,206-212`【源码】 |
| 路由授权 | 路由键由浏览器提供，缺省落到第一个 Runtime，未指定目标时向全部 Runtime 聚合 | `server.ts:734,951,1523`【源码】 |
| 实例生命周期 | 不存在，只连接已运行的节点 | 【源码，未穷尽搜索】 |
| DSH 版本 | 依赖 0.1.0-rc.7，白名单到 `<0.1.8` | `dsh-compatibility.ts:3-8`【源码】 |
| 对官方 Web 的补丁 | 1810 行、53 个文件 | `hub-compat.patch`【源码】 |
| 连接器可移植性 | 不成立。它依赖的 `ctx.apiProxy` 在本地 DSH 0.2.0 源码里搜不到 | 【源码】 |

节点与实例的区别：Node 是一台机器上的代理进程，Runtime 是该机器上的一个 DSH 进程。多节点连接能力不等于多用户隔离，Hub 里任何登录者对所有节点等同于 root。

### 2.3 deepseek-harness

| 能力 | 结论 | 依据 |
|---|---|---|
| 启动 | `dsh --profile web [--patch <file>] --no-open --trusted-host <authority>`；`--patch` 是启动器参数，必须在 `--profile web` 之后、应用参数之前 | 【实测】 |
| 监听地址 | 默认 `127.0.0.1:3080`。命令行拒绝 `--host 0.0.0.0`，但覆盖层整行替换 `webserver` 配置可绑 `0.0.0.0` | `startup.ts:88-90`；【实测】 |
| 鉴权 | 进程随机启动令牌换 HMAC 签名 cookie，cookie 绑定请求的 Host。令牌只打印在 stdout | `browser-auth.ts:197-260`；【实测】 |
| 多用户 | 不存在，单一操作者 | `packages/identity` 仅匿名 UUID【源码】 |
| 状态目录 | 全部在 `$DSH_HOME` 下：`sessions/`、`storages/`、`attachments/`、`.credentials.yaml`、`profiles/web/` | `packages/util/home-paths/src/index.ts:17,70-75`；【实测】 |
| 模型协议 | 原生适配器固定 Anthropic Messages；`llm-pi-ai` 支持 `openai-completions`、`openai-responses`、`anthropic-messages` | `llm-deepseek/src/config.ts:206-208`；`llm-pi-ai/src/provider.ts:42-46`【源码】 |
| OpenAI 兼容接入 | `llm-pi-ai.providers` 和 `agent-default-model` 可接入兼容服务；仅配置这两行不足以限制模型清单，还需受管禁用原生 `llm-deepseek` / `llm-deepseek-account` 注册入口 | 【#32 实测纠正】真实选择器仍显示两个内置 DeepSeek 模型；修正后的完整验收见 PR #139 |
| 工具调用、子 Agent | 可用。子 Agent 运行在独立 Session，头部含 `parentSession`、`origin: subagent`、`delegationDepth` | 【实测】 |
| 子 Agent 权限继承 | 不继承父级工具限制，拿到全新作用域 | `subagent-spawn-in-process/README.md:82`【文档】 |
| shell 沙箱 | Linux 用 bubblewrap 再退 Landlock，无后端则拒绝执行。读不受限（`--ro-bind / /`） | `sandbox-local/src/profiles.ts:17`；【实测】 |
| Web UI 扩展 | 插槽机制，插件可加左栏页面、右侧 tab、输入区控件、工具结果卡片，不改 `apps/web` | `docs/subsystems/slots.md:13-46`【文档】 |
| Agent 定义 | `preset` 挂人设、Skills、工具；新会话有 preset 选择器。preset 无模型字段 | `packages/preset/agent-preset/README.md`【文档】 |
| Skills | `<name>/SKILL.md`，可配系统级只读目录，用户用 `/name` 调用 | `packages/skill/skill-filesystem/README.md`【文档】 |
| 插件管理 | Plugins 页可启停和安装；安装源含 npm、npmmirror、GitHub；装入的代码在沙箱外执行 | `plugin-manager/README.md:31,46-50`【文档】 |
| 权限模式 | Read Only / Workspace Write / Full access，另有实验性 Auto review；预设表可配置 | `permission-presets/README.md:30-49`【文档】 |
| HTML 预览 | 已有，iframe 带 `sandbox="allow-scripts"` 或 `sandbox=""` | `ui-sidebar-documentpreview/.../HtmlBody.tsx:68,102`【源码】 |
| Office 预览 | 已有只读预览（转 PDF）；无编辑 | `packages/document/office-to-pdf`【文档】 |
| Office 生成 | 靠 `skill-office` 的三个 Skill，由模型跑脚本生成 | `packages/skill/skill-office`【文档】 |
| 遥测 | `DSH_TELEMETRY_DISABLED` 非空即关闭 | `apps/cli/src/profile-boot.ts:294`【源码】 |
| 公网依赖 | `web_search`/`web_fetch` 每个 preset 都挂载；插件管理器访问 npm；前端无外链 CDN | `base/cordis.patch.yml:463-490`【源码】 |

升级成本：DSH 的公开接口声明为未稳定（`AGENTS.md`）。本方案只依赖覆盖层配置、插件扩展点和 Web 鉴权流程，升级时重跑第 6 节的验证即可判断是否破坏。

### 2.4 dsh-sidebar-onlyoffice

| 项 | 结论 | 依据 |
|---|---|---|
| 依赖 | 需要 `dsh-better-sidebar >=0.6.0` | `package.json`【源码】 |
| 与 DSH 0.2.0-rc.2 兼容 | 两个插件从 npm 安装成功，通过 DSH 的 peer 版本预检，启动无报错，插件行出现在合成配置中。未接 Document Server，编辑功能未测 | 【实测】 |
| 安装前提 | 镜像里必须有 `pnpm`，否则 `dsh plugin add` 失败 | 【实测】 |
| 架构 | 纯反代：浏览器只访问 DSH，Document Server 的界面经 `/sidebar/onlyoffice/ds` 回流 | `README.zh-CN.md:119`【文档】 |
| 文档 key | `sha256(主机名 + 路径 + 大小 + mtime)`，主机名取 `os.hostname()` | `src/onlyoffice.ts:36-38`；`src/index.ts:196,261`【源码】 |
| 保存回调 | JWT 校验，status 2/6 时原子写回，key→文件注册表存在 `<DSH_HOME>/plugins/dsh-sidebar-onlyoffice/registry.json` | `README.zh-CN.md:38,154`【文档】 |
| Agent 改文件后编辑器感知 | inotify → SSE → 重取配置，约 1 秒 | `README.zh-CN.md:43`【文档】 |
| Document Server 要求 | 需 `ALLOW_PRIVATE_IP_ADDRESS=true`；9.4 社区版作者自述实测可用 | `README.zh-CN.md:55,152`【文档】 |
| 支持格式 | docx、xlsx、pptx | `src/onlyoffice.ts:21-25`【源码】 |

## 3. 推荐架构

```
浏览器
  │  只访问平台入口
  ▼
┌──────────────── 平台（薄管理层，Node/TypeScript + SQLite）────────────────┐
│ 登录/注册  管理后台  网关（HTTP+WS 反代）  编排器  RAGFlow 只读代理  审计  │
└───┬──────────────┬──────────────────────────────┬─────────────────────────┘
    │ Docker socket│ 仅平台持有                    │ 仅三类只读接口
    ▼              ▼                              ▼
 用户 A 容器     用户 B 容器                     RAGFlow（现有，不改）
 DSH + 插件      DSH + 插件
 卷: home-A      卷: home-B        ← 私有数据
 卷: work-A      卷: work-B
    │              │
    ├──────────────┴──► sub2api（内网模型，OpenAI 兼容）   ← 共享服务
    └──────────────┬──► ONLYOFFICE Document Server（新部署）
                   ◄── 保存回调直达所属用户容器
只读共享：DSH 镜像、批准插件、受管覆盖层、Skills、字体
```

### 3.1 分工

| 需求 | 归属 | 实现 |
|---|---|---|
| 邮箱注册、登录、禁用 | 平台 | 复用 TeamHub 的密码、会话、审计模块；补“禁用即断开长连接” |
| 实例创建、启停、恢复 | 平台 | 编排器经 Docker socket 管理容器，三个仓库都无现成代码 |
| 身份到实例的路由 | 平台 | 网关按登录会话查表，不接受客户端提交的任何实例标识 |
| 模型统一配置 | 平台生成覆盖层 | 只读挂载 `--patch` 文件 |
| RAGFlow 工具、页面、选择器 | DSH 插件 + 平台只读代理 | 见 3.4 |
| ONLYOFFICE 编辑 | 现有插件 + 新部署 Document Server | 见 3.5 |
| 办公 Agent | DSH bundle（preset + Skills） | 见第 4 节 |
| 批准插件目录 | 平台管目录，DSH Plugins 页管开关 | 预装进镜像，关闭安装入口 |

### 3.2 实例管理与数据归属

- **每用户一个容器**，两个卷：`$DSH_HOME`（Session、设置、插件状态、Office 注册表）和工作目录。【实测】重启和重建容器后文件、Session 均保留。
- **按需启动、空闲停止**：登录时启动；无浏览器连接、无运行中任务、无 Office 编辑会话持续 30 分钟（后台可调）后停止。
- **网关鉴权流程**【实测】：
  1. 编排器从容器 stdout 读出启动令牌。
  2. 网关以平台对外的 Host 向容器请求 `/?token=...`，拿到 cookie 存在服务端，不下发浏览器。
  3. 之后每个请求和 WebSocket 升级由网关注入该 cookie，并剥掉上游的 `Set-Cookie`。
  4. 容器重启后令牌变化、旧令牌失效，但签名密钥在 `$DSH_HOME` 里，旧 cookie 仍有效。
  - 注意：Node 的 `fetch` 不能覆盖 Host 头，令牌交换必须用 `http.request`，否则 cookie 绑到错误的 authority。
- **跨实例隔离**【实测】：A 的令牌和 cookie 访问 B 均返回 401；B 的界面和容器里看不到 A 的 Session 和文件。
- **容器网络**：用户容器不发布宿主端口，只有平台网关可达。用户容器之间不互通；Document Server 需要能访问各用户容器的 3080 端口（回调），这一条网络策略尚未设计验证【未验证】。
- **单实例空闲内存**【实测，仅两个样本】：约 130 MiB（未用过）到 220 MiB（跑过一次任务）。不能据此推算容量，见第 6 节。
- **故障影响**：单容器崩溃只影响该用户；宿主机内存、磁盘、Docker 守护进程和平台进程是全员共享的单点。

### 3.3 统一模型配置

- 管理员在后台填 sub2api 地址、密钥、可用模型和默认模型，平台生成覆盖层，只读挂载进所有容器。`verify/phase0/managed.patch.yml` 是实测用的样例。
- 员工只看到管理员配置的模型是验收要求，不可由 pi-ai 配置文本推断：#32 真实浏览器发现原生 DeepSeek 注册项仍可见，需要同一受管覆盖层禁用原生入口并在员工改配置、重启后重验【实测纠正；完整修复验收见 PR #139】。
- **密钥落点**（项目方决定）：全员共用一把，以环境变量注入。【实测】容器内同 uid 可从 `/proc/1/environ` 读到。换密钥需要重启全部实例。
- 覆盖层优先级高于用户设置，UI 写不进被覆盖的行（`config-editor/README.md:67`【文档】）。员工能否通过设置页另加 provider 尚未实测【未验证】。
- 内网模型不可用时 DSH 直接报错，不存在回退公网的配置。
- 配置变更对运行中任务的作用【推断】：`llm-pi-ai` 按请求解析配置，但覆盖层文件变更需要重启实例才生效；正在执行的任务会被重启打断。发布策略建议为“下次启动生效，管理员可手动重启指定实例”。

### 3.4 RAGFlow 集成

- **平台只读代理**：只开放三个接口，密钥留在平台。不做通用转发。
- **接口实测**：本机用官方 compose 起了 `infiniflow/ragflow:v1.0.0-rc1`（`/api/v1/system/version` 返回 `v1.0.0-rc1`），建了 3 个测试库、28 个文件。认证为 `Authorization: Bearer <key>`。

| 能力 | 调用 | 实测结果 |
|---|---|---|
| 知识库列表 | `GET /api/v1/datasets?page=&page_size=&name=` | 【实测】返回 `data[]` 和顶层 `total_datasets`。每项有 `id`、`name`、`description`（未填时为 null）、`document_count`、`chunk_count`。超出末页返回空数组 |
| 库内文件列表 | `GET /api/v1/datasets/{id}/documents?page=&page_size=&keywords=` | 【实测】返回 `data.total` 和 `data.docs[]`。每项有 `id`、`name`、`size`、`suffix`、`ingestion_status`、`chunk_count`、`create_date`、`update_date`。25 个文件按每页 10 条取到 10/10/5/0。`keywords` 按文件名筛选；无匹配返回 `total: 0` |
| 检索 | `POST /api/v1/retrieval`，`question`、`dataset_ids[]`、`page`、`page_size`、`highlight` | 【实测】一次传多个库 ID 可用，结果按相似度混排，每个片段带 `dataset_id`。只选 A、B 时查不到仅存在于 C 的内容；加上 C 后查到 |
| 版本 | `GET /api/v1/system/version` | 【实测】可用于后台显示和核对精确版本 |

- **错误形态**【实测】：

| 情况 | HTTP | 响应体 |
|---|---|---|
| 密钥错误 | 401 | `code: 401`，“Invalid access token” |
| 库 ID 不存在或无权 | 200 | `code: 102` |
| 检索时 `dataset_ids` 为空数组 | 200 | `code: 101`，“kb_id array cannot be empty” |
| 检索时不传 `dataset_ids` | 200 | `code: 101` |

  业务错误多数是 HTTP 200 加非零 `code`，代理必须检查 `code`，否则会把失败显示成“没有文件”。RAGFlow 自身不会因空列表退回全库检索；平台代理在空选择时应直接不发请求。
- **片段字段**【实测】：`id`、`content`、`document_id`、`document_keyword`（文件名）、`dataset_id`、`similarity`、`term_similarity`、`vector_similarity`、`highlight`、`positions`；另有 `data.doc_aggs[]`（`doc_id`、`doc_name`、`count`）和 `data.total`。纯文本文件的 `positions` 是空数组，所以页码和位置只能在有值时展示。
- **列表里有一个无效库 ID 时整个检索失败**【实测】：返回 `code: 102`，不会只查有效的那些。代理必须先用知识库列表剔除已删除或不可用的 ID，并把“已选知识库不可用”提示给员工，再用剩下的 ID 检索；剩下为空则不检索。
- **多库混排会被大库挤占**【实测】：问题同时涉及 A 库（25 条）和 B 库（2 条）时，前 6 条全部来自 A。若要保证每个所选库都有机会出现，改为逐库检索后合并，代价是每库一次请求。首期建议先用单次多库请求，把这一点列为可调项。
- **嵌入模型**：本机三个测试库用的是同一个嵌入模型（`text-embedding-3-small`）。库之间嵌入模型不同时多库检索的行为未测，需在内网确认各库是否一致。
- 本机测试栈为了能检索，对测试库做了设置嵌入模型和触发解析的写操作；这些只发生在本机测试实例上，平台代理不提供这些接口。
- **检索越界校验**：照搬 `xagent` 的做法，校验每个返回片段的 `dataset_id` 属于请求的库集合，否则报错。
- **按 Session 的选择**：插件用一条 Session 事件记录所选知识库 ID（需标 `ignorable: true`），刷新后可恢复。提交任务时把当前选择快照进该轮。
- **子 Agent 继承**：子 Agent 不继承父级限制，但其 Session 头部有 `parentSession`【实测】。检索工具沿父链回溯到根 Session 取选择。这一步的插件代码尚未编写【未验证】。
- **不构成访问权限**：员工的 Agent 有 shell，可绕过工具直接调用代理查任意库。需求 9.3 已明确这是检索设置而非权限，全员本就共享全部知识库，所以不额外防护。
- 多库检索若有约束（例如各库嵌入模型须一致），退路是逐库检索后合并。

### 3.5 ONLYOFFICE 集成

- **Document Server**：内网没有，随项目部署。社区版 9.4.0，AGPL v3，20 个并发连接上限（项目方已接受，满员时界面提示）。
- **插件配置**由平台覆盖层下发：`documentServerUrl`、`jwtSecret`、`internalBaseUrl`（该用户容器在 Docker 网络上的地址）、`publicBaseUrl`（平台对外地址）。
- **跨用户不串写的保证**：
  - 文档 key 含主机名，**编排器必须给每个容器设唯一 `--hostname`**。否则两个用户同路径、同大小、同 mtime 的文件会得到同一个 key，被 Document Server 当成同一份文档协同编辑。
  - 保存回调直达所属用户容器，由该容器内的注册表映射回文件。
- **人工保存后 Agent 读到新内容**：插件原子写回磁盘，Agent 读的就是磁盘文件，不存在缓存层【推断，未测】。
- **并发策略**：后写覆盖，界面加一句提示，不做锁。
- **编辑流程实测：打一个小补丁后全流程通过。** 本机起了 Document Server 9.4.0 和两个预装插件的用户容器，经网关访问。
  - **不打补丁时进不了编辑器**：`better-sidebar` 0.24.1 在源码里写死了一张交还给 DSH 内置预览的扩展名表 `HOST_OWNED_EXTS`（`src/client/native/index.ts`），其中有 docx、xlsx、pptx，所以第三方预览器拿不到这些文件。ONLYOFFICE 插件是针对 `better-sidebar` 0.15.x 开发的。
  - **最小适配**：构建镜像时从该表里去掉 docx、xlsx、pptx 三项（`verify/phase0/patch-better-sidebar.py`，只对 0.24.1 验证过，版本变了脚本会报错退出）。这是对第三方插件构建产物的补丁，不动 DSH 源码。正式做法应向 `better-sidebar` 上游提需求（已注册第三方预览器时不交还），在上游合入前由镜像构建维护这个补丁。

  | 验证项 | 结果 |
  |---|---|
  | 经网关打开 DOCX 进入 ONLYOFFICE 编辑器（编辑模式） | 通过 |
  | 人工输入并保存，关闭页签后文件写回磁盘 | 通过，约 6 秒内落盘 |
  | Agent 随后读取并追加内容 | 通过，结果文件同时保留人工修改和 Agent 追加 |
  | 用户 A、B 各有同名 `通知.docx`，分别编辑保存 | 通过，互不影响；两边文档 key 不同 |
  | 未登录访问插件路由 | 401 |
  | B 容器直连 A 容器的 3080 端口 | 401（网络可达，但被 DSH 鉴权挡住） |
  | B 容器向 A 的保存回调接口发伪造请求（无 JWT） | 403 |
  | Document Server 识别项目字体 | 通过，仿宋_GB2312、楷体_GB2312、方正小标宋、黑体、思源黑体都在字体表里 |

- **未测**：XLSX 和 PPTX 的编辑、编辑器开着时 Agent 改文件后的自动刷新、人机同时写的覆盖表现、网关断开重连、20 连接上限的实际表现、amd64 上的 Document Server。
- **使用上的约束**：编辑器要求当前有 Session，没有 Session 时打不开 Office 文件。
- **附带发现**：
  - DSH 自带的 Office 只读预览需要镜像里有 LibreOffice，否则报不可用。打了上面的补丁后 docx/xlsx/pptx 不再走它，但旧 DOC/XLS/PPT 仍走它。
  - `better-sidebar` 的版本与 DSH 版本线强绑定（其 README 有对应表），升级 DSH 时两个插件和补丁要一起验证。
  - `better-sidebar` 有“关闭 HTML 预览沙箱”的设置项（`htmlViewerNoSandbox`，默认关），受管配置应把它钉死为关闭。
  - `better-sidebar` 的右侧栏带终端入口。项目方决定不隐藏，保持可展开折叠。
  - 两个用户容器在同一个 Docker 网络上互相可达，靠 DSH 鉴权和回调 JWT 挡住。正式部署仍应按用户隔离网络，只让网关和 Document Server 能到各容器。
- `open-webui-ocu` 只有设计文档，无实现代码，其结论不能当验证过的经验引用。可借用的是字体方案：发行包带 Noto CJK，版权字体由运营方另放目录。

### 3.6 实测发现的硬约束

1. **shell 沙箱需要放宽两项容器安全设置**。用 DSH 自己的 `bash` 工具实测（`dsh --profile headless`，“工作区内修改”模式）：

   | 容器安全设置 | `bash` 工具 |
   |---|---|
   | Docker 默认 | 拒绝执行，报“no sandbox backend is usable” |
   | 仅 `seccomp=unconfined` | 仍然拒绝。能建命名空间，但 DSH 的沙箱参数含 `--unshare-pid --proc /proc`（`sandbox-local/src/profiles.ts`），Docker 屏蔽了 `/proc` 的部分路径，挂载被拒 |
   | `seccomp=unconfined` + `systempaths=unconfined` | 可用。工作区内写入成功；写 `$DSH_HOME` 被拒（Read-only file system） |

   正式方案应写一份只放开所需系统调用的 seccomp 配置，而不是整体关闭；`systempaths=unconfined` 会让容器看到未屏蔽的 `/proc`，其影响要在目标机评估。本机是 Docker Desktop 的 linuxkit 内核且未启用 Landlock，目标 Linux 宿主上结果可能不同，必须重测。
2. **钉住发行版**。见第 1 节。
3. **镜像必须带 `pnpm`**，否则无法在构建期安装插件。
4. **唯一主机名**。见 3.5。
5. **插件装在用户数据目录里**。`dsh plugin add` 写的是 `$DSH_HOME/profiles/web/`，不是程序目录。做法是在镜像里预置好该目录，新用户的数据卷首次挂载时自动带上（`verify/phase0/Dockerfile.office`）。升级插件时已有用户卷里的旧配置目录不会自动更新，需要平台迁移。
6. **受管覆盖层锁得住**。在用户配置里改默认模型、另加模型地址，带覆盖层启动后合成结果仍是管理员的值；覆盖层文件只读，写不动。
7. **用户配置写坏会导致 DSH 起不来**。配置文件语法错误时启动直接报错退出。Yolo 档下 Agent 能写这个文件，平台需要“重置实例配置”的后台操作。
8. **首次进入要选工作目录**。新实例没有工作区，输入框禁用。平台应在建实例时预置一个指向工作目录卷的工作区（`storages/workspace.json`），做法未验证。
9. **界面默认英文**，且首次有预览版公告弹窗。中文化和关闭公告需要通过设置覆盖，未验证。

### 3.7 必须修改 DSH 核心的地方

目前为零。所有定制都通过覆盖层、插件和环境变量完成。

## 4. 内置办公 Agent 清单

- **参考来源**：未对 Workbody / WorkBuddy 做任何公开资料调研，以下拆分全部由本项目提出。
- **实现机制**：每个 Agent 是一个 `preset`（人设 + Skills + 工具集）。默认 preset 是综合办公，员工可在新会话的选择器里手动指定专业 preset。综合办公需要委派时走子 Agent 工具。
- **模型策略**：preset 没有模型字段。统一用平台默认模型；子 Agent 可通过 `agentOptions` 指定模型。首期全部用默认模型。
- **未验证**：自定义 preset 的 bundle 写法、每个 preset 的工具白名单、Session 建立后能否切换 preset。

| 标识 | 名称 | 职责 | Skills | 工具 | 验收任务 |
|---|---|---|---|---|---|
| `office-general` | 综合办公 | 理解任务、选择能力、汇总结果 | 全部可见 | 全部批准工具 + 子 Agent | 一句话任务触发正确的专业能力并产出文件 |
| `office-writer` | 公文与材料写作 | 通知、请示、说明，套单位模板 | 公文格式、`office-docx` | 文件读写、shell、知识检索 | 按模板生成一份可打开的 DOCX 通知 |
| `office-proofreader` | 材料校对 | 用词、结构、格式、内部数据一致性 | 校对规范 | 文件读、`office-docx` | 指出给定文稿中预埋的 5 处错误，不声称做了外部核验 |
| `office-minutes` | 会议纪要 | 从文字记录提炼议题、结论、责任人、待办 | 纪要模板 | 文件读写 | 由一份文字记录生成纪要 DOCX，待办含责任人 |
| `office-report` | 工作总结与报告 | 整合材料成总结、汇报 | 报告结构、`office-docx` | 文件读写、知识检索 | 由三份材料生成一份总结 |
| `office-knowledge` | 制度与知识检索 | 在选定知识库检索并给出带来源的解释 | 引用规范 | 知识检索（只读） | 回答含真实来源；未选库时明确说明不检索 |
| `office-data` | 表格与数据分析 | 整理、合并、核对、统计、出图 | `office-xlsx` | 文件读写、shell | 合并两张表并输出带图表的 XLSX |
| `office-slides` | 演示文稿 | 材料整理成汇报结构和 PPTX | `office-pptx` | 文件读写、shell | 生成可打开的 PPTX |
| `office-event` | 会务与活动方案 | 议程、分工、执行清单 | 方案模板 | 文件读写 | 生成一份含议程和分工表的方案 |
| `office-files` | 文件整理 | 在指定范围内分类、重命名、汇总 | 整理规范 | 文件读写、shell | 破坏性动作前请求确认 |

- 所有 Agent 去掉 `web_search`、`web_fetch`。
- Office 生成依赖模型跑 Python 脚本，镜像需要预装 Python 和相关库；`office-docx/xlsx/pptx` 三个 Skill 在内网模型上的实际成功率未测。
- PPTX 的格式能力需通过测试确认后再承诺。

## 5. 分阶段开发计划

| 阶段 | 内容 | 涉及模块 | 完成条件 |
|---|---|---|---|
| 1 | 邮箱注册登录、管理后台骨架、编排器、网关、受管覆盖层、三档权限、2–3 个办公 Agent | 平台（新建）、DSH 镜像、TeamHub 账号模块 | 验收 1、2、3、12、13 的自动化测试通过；两个账号端到端跑通真实任务 |
| 2 | RAGFlow 只读代理和插件、ONLYOFFICE 部署和接入、插件目录与开关 | RAGFlow 插件（新建）、`dsh-sidebar-onlyoffice`、Document Server | 验收 5–11 通过；内网 RAGFlow 三类接口实测记录 |
| 3 | 全部办公 Agent、后台配置体验、离线包、容量与故障测试 | 办公 Agent bundle、离线交付脚本 | 验收 4、14 通过；容量报告 |

阶段 1 开始前需要先解决的风险：

| 风险 | 影响 | 处理 |
|---|---|---|
| 目标 Linux 宿主上 shell 沙箱是否可用 | Agent 无法跑脚本，Office 生成全部失效 | 阶段 1 第一周在目标机重测，定稿 seccomp 和 `/proc` 屏蔽配置 |
| Auto review 在内网模型上是否可用 | 三档权限缺一档 | 阶段 1 实测；不可用则 Auto 暂以“工作区内修改”代替并告知 |
| Yolo 档下受管配置能否被 Agent 改写 | 员工可绕过模型和插件限制 | 覆盖层只读挂载；实测 Agent 写 `$DSH_HOME/profiles` 是否能覆盖受管行 |
| 开放注册无资源闸门 | 宿主机被占满 | 后台显示实例数和磁盘占用；管理员可禁用账号并回收卷 |
| 禁用账号的即时性 | 被禁用者继续使用 | 网关持有全部长连接，禁用时主动断开并停止容器 |
| DSH 接口未稳定 | 升级破坏网关或插件 | 钉版本；升级前跑第 6 节的回归 |

## 6. 测试与离线交付

### 6.1 已完成的验证（本机 Docker，arm64，DSH 0.2.0-rc.2）

脚本在 `verify/phase0/`。

| 验证项 | 结果 |
|---|---|
| 覆盖层绑 `0.0.0.0` | 通过 |
| 无 cookie 访问首页和 `/api` | 401 |
| 启动令牌换 cookie（经代理 Host） | 303 + cookie |
| A 的令牌、cookie 访问 B | 401 |
| 经网关加载界面、WebSocket | 通过 |
| OpenAI 兼容模型 + 文件工具 + 子 Agent | 通过，文件真实落盘 |
| B 看不到 A 的 Session 和文件 | 通过 |
| 重启后数据保留，旧 cookie 有效，旧令牌失效 | 通过 |
| 重建容器后数据保留 | 通过 |
| 默认 Docker 下 `bash` 工具 | **失败**，沙箱不可用 |
| 仅 `seccomp=unconfined` 下 `bash` 工具 | **失败**，`/proc` 挂载被拒 |
| `seccomp=unconfined` + `systempaths=unconfined` 下 `bash` 工具 | 通过；工作区可写，`$DSH_HOME` 不可写 |
| ONLYOFFICE 插件安装和启动、经网关访问 Document Server 反代 | 通过 |
| 在界面打开 DOCX 进入 ONLYOFFICE 编辑器 | 不打补丁失败；给 `better-sidebar` 打补丁后通过 |
| DOCX 人工编辑保存落盘、Agent 回读并追加、两用户同名文件隔离、字体识别 | 通过 |
| 用户配置能否覆盖受管覆盖层 | 不能（通过） |
| RAGFlow v1.0.0-rc1 知识库列表、文件列表、分页、筛选、错误码 | 通过（本机测试栈） |
| RAGFlow 多库检索：范围限制、混排、片段字段、无效 ID | 通过（本机测试栈，`text-embedding-3-small`） |

未做：HTML 预览的独立验证（只读了源码）、Shell 和网络层面的跨用户攻击测试、Auto review、Yolo、禁用账号、空闲回收、RAGFlow 插件本身、XLSX/PPTX 编辑、编辑器打开时 Agent 改文件的刷新、`qwen3.6` 上的一切（本机没有该模型）、容量。

### 6.2 后续验证分层

| 层 | 内容 |
|---|---|
| 源码检查 | 每次升级 DSH 或插件后核对覆盖层目标行是否还存在 |
| 模拟验证 | RAGFlow 用模拟服务验证分页、错误码、越界校验、空选择不查全库 |
| 真实联调 | 内网 RAGFlow 三类接口；Document Server 编辑保存回读；sub2api 上每个 Agent 的工具调用 |
| 容量测试 | 分别测账号数、在线数、活跃实例数、并发模型任务数、同时编辑文档数；记录单实例内存和磁盘增长 |

### 6.3 离线交付

- **交付物**：平台镜像、DSH 用户镜像（含 pnpm、Python、bubblewrap、全部批准插件和 Skills）、Document Server 镜像、字体包、seccomp 配置、编排文件。全部以镜像归档导入，运行时不访问任何公网地址。
- **构建在外部准备环境完成**：插件和依赖在构建期装进镜像，内网不执行 `npm`/`pnpm` 安装。
- **必须关闭的公网路径**：遥测（`DSH_TELEMETRY_DISABLED`）、`web_search`/`web_fetch`、插件安装入口和 npm 源。
- **目标架构**：本次验证在 arm64 上做，目标宿主若为 amd64 需要重新构建和重测。
- **升级与回滚**：按镜像标签切换；用户数据在卷里，不随镜像变化。DSH 的 Session 格式不支持降级（`AGENTS.md`），回滚 DSH 版本前必须有卷备份。
- **备份**：平台 SQLite 文件和全部用户卷。

## 7. 需求映射

### 7.1 固定要求

| 要求 | 模块 | 验收 |
|---|---|---|
| 统一 Web 入口、邮箱账号 | 平台登录 | 1 |
| 每用户独立实例和私有存储 | 编排器、卷 | 1、2、12 |
| 自由对话为主入口 | DSH Web | 4 |
| 内置办公 Agent | Agent bundle | 4 |
| 统一内网模型，员工不填密钥 | 受管覆盖层 | 3、13 |
| 批准插件目录 | 平台目录 + Plugins 页 | 5 |
| 无公网 | 离线镜像 | 3、14 |
| RAGFlow 只读浏览和按 Session 选择 | RAGFlow 插件 + 代理 | 6–9 |
| 文件预览、ONLYOFFICE 编辑、后写覆盖 | DSH 预览、Office 插件 | 10、11 |

### 7.2 已决事项

| 事项 | 决定 |
|---|---|
| 管理层技术栈 | Node/TypeScript + SQLite，放本仓库 |
| 部署 | 单台 Linux + Docker |
| 模型 | sub2api，OpenAI 兼容；全员共用密钥，直接注入 |
| 权限模式 | 人工批准 / Auto（DSH Auto review）/ Yolo，员工自由切换 |
| 插件 | 预装，员工只开关 |
| 新 Session 知识库 | 默认全选 |
| 账号 | 自助注册，无审批，无域名限制 |
| 实例 | 按需启动，空闲停止 |
| ONLYOFFICE | 随项目部署社区版，接受 20 连接上限 |

### 7.3 与需求的偏离（项目方决定）

- 需求第六节“管理员创建、不需要公众注册” → 自助开放注册。
- 需求第七节“实例凭据受限、可撤销” → 共用密钥直接注入，员工可读出。
- 需求第 10.3 节未提权限模式；Yolo 档下 Agent 可写容器内任意位置。

### 7.4 范围外

同需求第十三节，不重复。

### 7.5 项目方已提供的环境信息（2026-10-03）

| 事项 | 内容 | 对方案的影响 |
|---|---|---|
| 目标服务器 | 浪潮 5486M6，amd64，56 核，500G 内存，32T 磁盘，Ubuntu 22.04 | 阶段 0 的验证在 arm64 的 Docker Desktop 上做，镜像构建和 shell 沙箱都要在目标机重做 |
| RAGFlow | `192.168.2.98:80`，v1.0.0-rc1 | 与 `xagent` 部署文档一致，`example.env` 里的 v0.27.2 作废。从开发机（`192.168.1.33`）直连超时，未做任何接口实测 |
| 内网模型 | sub2api 提供 `qwen3.6`，500k 上下文 | 阶段 0 用的是 `deepseek-v4.1-flash`；`qwen3.6` 的工具调用、子 Agent 委派和 Auto review 都要重测。覆盖层里需显式写 `contextWindow`，否则按默认 262,144 处理（`llm-pi-ai/README.md`） |
| 公文模板 | 暂不提供 | 公文写作 Agent 先按通用格式验收 |
| 字体 | 已全部放入 `assets/fonts/`，项目方确认均已授权：仿宋_GB2312、楷体_GB2312、方正小标宋简体、黑体（SimHei），以及思源黑体 SC 七个字重（OFL） | 公文四种字体齐全。作为运营方字体目录挂进 Document Server 和用户镜像 |

### 7.6 仍需提供或确认

| 事项 | 影响 |
|---|---|
| 内网 RAGFlow 各知识库用的嵌入模型是否一致；一把只读用途的密钥 | 多库检索能否一次请求完成；阶段 2 在内网复核 |
| Workbody / WorkBuddy 的可用资料 | 没有则按第 4 节的清单定稿 |
