# Design

## Context

动机见 proposal.md 的 Why。下面只列决定做法的现状和约束。

**现状**

- 阶段 1 已交付（`openspec/specs/` 下各能力）。
- 每个实例有自己的带标签 bridge 和一个 /28 子网，平台容器经已验证身份接入每个实例 bridge，网关经实例 IPv4:3080 访问 DSH。
- 受管覆盖层整份替换、只读挂载。
- 模型和运行配置存在私有 SQLite 的 settings 中。
- 用户镜像在 root 段做构建期补丁，版本或哈希不符时构建失败（#375 先例）。

**DSH 0.2.1-rc.2 与 0.2.0-rc.2 的差异**（事实核查，压测分支 B2，逐项证据见核查报告）

- webserver 配置拒绝通配监听地址（`dsh-host-webserver/lib/index.js:252-256`）。
- 启动 URL 行改为 `dsh web: <绑定地址或 publicUrl>`。
- 所有 subagent 子会话都是 `continuable`，`backgroundMode` 被删除；新增原生 `agentPreset`/`allowedAgentPresets`。
- 插件兼容性以 `engines.dsh` 为准，不满足的 bundle 会被跳过。
- `.credentials.yaml` 的优先级高于环境变量（`dsh-base/cordis.patch.yml:113`）。
- 插件页新增 `AddPluginMenu`、Update、on-demand 官方卡片、Discover 标签页和插件市场工具。
- Session 格式 v4 和工作区存储格式没有变化。

**ONLYOFFICE 插件**（`resource/dsh-sidebar-onlyoffice`）

- `GET /sidebar/onlyoffice/file` 不经过 DSH 鉴权，只凭 HMAC 令牌放行，而签令牌的密钥是公开常量（`src/index.ts:70`）。
- 回调接口在配置了 JWT 时会验签。
- Document Server 的 JWT 密钥经覆盖层下发，员工可以读到（`/managed/patch.yml` 的权限是 0444）。

**RAGFlow v1.0.0-rc1 接口的实测行为**（分析 3.4）

- 业务错误多数是 HTTP 200 加非零 `code`。
- 检索列表里只要有一个无效库 ID，整次检索就失败（`code:102`）。
- 空 `dataset_ids` 返回 `code:101`。
- 返回的片段带 `dataset_id`。

**本机与 VPS**

- 开发机是 macOS arm64，Docker Desktop 分配约 15.6 GiB。
- VPS 是 7 GiB 内存、可用磁盘约 9 GiB，放不下 Document Server（约 8.7 GB 镜像）和 RAGFlow。

## Goals / Non-Goals

**Goals:**

- DSH 0.2.1-rc.2 上保持阶段 1 的全部已规定行为。只有项目方明确撤回的 #375 行为例外。
- 知识库检索和 Office 编辑在本机全栈上端到端可用，跨用户隔离有攻击验证。
- 新增的管理员配置复用现有后台、设置存储和审计约定，不另起一套。

**Non-Goals:**

- 内网 `192.168.2.98` 联调，以及 amd64 上的 Document Server 验证。移到阶段 3 的 3.7（B24）。
- 逐库检索后合并结果（基线第 6 节列为范围外，作为可调项）。
- 员工能自己修改检索参数（B15）。
- 后台可修改「员工自选」项的默认值（Q25：覆盖层机制做不到，默认值随镜像）。
- 老员工卷 profile 的自动同步：仍属阶段 3 的 3.4，阶段 2 依靠「重置配置」（B19）。
- 平台模型代理、每用户独立的模型密钥（基线 T12）。
- DSH 0.2.1-rc.3 及更高版本：等满 7 天后另开升级 PR。
- 向 better-sidebar 上游提需求：不是交付物，补丁继续由镜像构建维护（T6）。
- 外部 Document Server 的网络接入自动化：后台可以切到外部地址，但它能否访问各实例 IP 由运营方负责，部署文档写明。

## Decisions

### 1. 先迁移 DSH，再做功能（B1、B2）

DSH 迁移是阶段 2 的第一批，其余功能组都依赖它。第一批由三个在 0.2.0-rc.2 上先合入的预备组和一个原子升级组组成，每个预备组单独保持阶段 1 的全部验收：

1. 固定地址布局：容器以 +2、平台以 +3 接入，+4 预留（决定 2）。0.2.0 的 webserver 只接受 `127.0.0.1` 和 `0.0.0.0` 两个字面值（`dsh-host-webserver/lib/index.js:142`），所以这一组不改监听地址。
2. 撤回 #375 的插件页补丁和 `plugin_manager` 去除（决定 12）。`registryProbeEnabled:false` 和联网工具的去除保留到插件目录组接上后台开关时再改。
3. 权限档覆盖 continuable 子会话（决定 10）。0.2.0 已支持 `backgroundMode: continuable`，用测试自有的组合产生这类子会话。
4. 原子升级：
   - DSH 钉定改为 0.2.1-rc.2；
   - 覆盖层监听地址改为 +2，启动令牌按新输出行解析；
   - 四个镜像插件改用 `engines.dsh`；
   - 办公委派改用原生 `agentPreset`（决定 9）；
   - DSH 发行包的 cookie 格式核对（`platform/src/orchestrator/credentials.ts:174` 写明了 0.2.0-rc.2 的格式）。

   这些项单独合入都会让 exact-head `test:docker` 变红，所以合成一个 PR，带 `diff-limit-exempt` 标签和理由。

凭据优先级（决定 11）紧接升级之后：0.2.0 上环境变量优先，风险只在 0.2.1 上存在。

迁移只算完成于以下都通过之后：

- VPS 上 exact-head 的 `test:docker`、`test:deploy` 全量通过；
- 办公委派的 `test:model` 通过（每次单独授权）。

**备选**：边升级边做功能。不采用：任何一处回归都会和新功能的失败混在一起，没法归因。

### 2. 实例固定 IP（B3）

在分配给实例的 /28 里，地址按下面的规则固定：

| 偏移 | 用途                |
| ---- | ------------------- |
| +1   | 网关（Docker 默认） |
| +2   | 员工容器            |
| +3   | 平台                |
| +4   | Document Server     |

- 创建容器时用 `IPAMConfig` 指定 +2。
- 平台接入 bridge 时请求 +3；Document Server 接入时请求 +4（决定 6）。
- 覆盖层的 webserver `host` 写 +2（升级到 0.2.1 后；0.2.0 上仍为 `0.0.0.0`）。
- 启动令牌按 `dsh web: http://<+2>:3080/…` 匹配。
- 接入的身份核验、退役时的断开顺序、只删除已验证为空的网络，都保持阶段 1 的语义。
- published-loopback 模式（只在开发时使用）也建一个自有 bridge 并固定 +2，再把端口发布到 127.0.0.1。这种模式下没有平台和 Document Server 接入，RAGFlow 和 Office 功能不可用，文档里写明。

**备选**：先创建容器、拿到 IP 再生成覆盖层。不采用：要把创建和启动拆开，生命周期 fence 全都要改。

### 3. RAGFlow 只读代理和实例令牌（B14、B15、B16）

**实例令牌**

- 编排器在每次启动时生成 32 字节随机值，作为 `DSH_TEAM_INSTANCE_TOKEN` 注入容器。
- 实例行只保存它的 SHA-256。停止时清除，重启时轮换。

**接口**

- 新增 `platform/src/ragflow-proxy/` 模块和实例专用的接口前缀，只接受 `Authorization: Bearer <实例令牌>`，不接受平台会话。
- 四个接口：库列表、库内文件、检索、版本，参数严格校验。
- 平台按令牌哈希找到对应的运行中实例行，并核对请求的来源 IP 等于该行的 +2 地址。

**检索的处理顺序**

1. 读取最新的连接设置和检索参数。
2. 拉取知识库列表，剔除已经不存在的 ID，结果里返回被剔除的 ID。
3. 剩余为空就不请求 RAGFlow。
4. 用剩余的 ID 加管理员配置的检索参数做一次多库检索。
5. 校验每个返回片段的 `dataset_id` 属于请求集合，否则整体报错。
6. 按响应体 `code` 映射为封闭的错误集合：无结果、超时、配置错误、服务中断、无效请求。

**其他约定**

- 超时是一个固定常量。代理不做缓存，不做重试。
- RAGFlow 地址、密钥和检索参数存在既有的 settings 中，用一次新迁移。密钥只返回「已配置」。
- 保存即生效：代理每次请求都读设置。
- 「测试连接」只调用版本接口。

**备选**：浏览器经网关、凭平台会话直接调用代理。不采用：检索工具运行在容器的 Agent 侧，没有浏览器会话。只靠网络来源放行也不采用：审计和归属无法精确到用户。

### 4. 「知识库」插件（B17，F25、F27–F32、F34）

新增镜像插件 `plugins/knowledge-base/`，root 所有、只读，结构参照 `platform-nav`。

- **Host 半区**
  - 注册插件自己的 HTTP 路由（T11），供浏览器面板转发到代理。
  - 注册检索工具。
- **Client 半区**
  - 左侧栏「知识库」面板：库列表、展开文件、搜索、分页、刷新，区分加载中、空库、无匹配、失败四种状态。
  - 输入区的范围控件，显示当前范围。
- **范围选择**
  - 用一条 `ignorable: true` 的 Session 事件记录；新 Session 默认全选（D10）。
  - 提交时把选择快照进本轮，之后的修改只影响后续任务（F30）。
- **检索工具**
  - 沿 `parentSession` 回溯到根 Session，取本轮快照（F25，T10）。
  - 来源展示片段、文件名和所属库；页码和位置只在有值时显示（F32）。
- **配置来源**
  - 覆盖层只给插件平台地址（实例 bridge 上的 +3:平台端口）。
  - 令牌来自环境变量。
  - 插件不接触 RAGFlow 密钥和检索参数。

### 5. Document Server 交付（B12、B13）

- **compose 服务**
  - `deploy/compose.yml` 新增 `documentserver` 服务：`onlyoffice/documentserver:9.4.0`，固定容器名，开启 JWT。
  - 运营方字体目录只读挂载；不发布宿主端口；带 `ALLOW_PRIVATE_IP_ADDRESS=true`。
- **地址和 JWT 的来源**
  - 自带 Document Server 的地址和 JWT 以 `.env` 中的 Compose 变量为准，同时传给平台。
  - 后台可以改用外部 Document Server 的地址和 JWT，存在 settings 中。外部配置优先。
  - 密钥只显示「已配置」。

### 6. Document Server 接入实例网络（B12，T9）

- 编排器像接入平台那样，把配置名指定的 Document Server 容器以 +4 接入每个实例 bridge。
- 身份核验和退役时的断开都复用平台接入的代码路径和 fence。
- 选择外部 Document Server 时不做接入。
- 覆盖层写入 ONLYOFFICE 插件的配置：
  - `documentServerUrl` 为 `http://<+4>`；
  - `internalBaseUrl` 为 `http://<+2>:3080`；
  - `publicBaseUrl` 为平台对外地址；
  - `jwtSecret`。

### 7. ONLYOFFICE 文件令牌改为每实例密钥（B11）

- 构建期补丁：把 `FILE_TOKEN_SECRET` 常量改为读取 `DSH_TEAM_ONLYOFFICE_FILE_SECRET`；环境变量缺失或为空时，铸造和校验令牌都拒绝。
- 编排器每次启动生成这个随机值并注入。
- 补丁的写法和 #375 一致：
  - 钉住版本、输入 SHA-256、输出 SHA-256；
  - 只认唯一一份真实副本；
  - 原子写入，root 所有。

B 能读到 Document Server 的 JWT，但不知道 A 的文件令牌密钥，所以借 Document Server 拉 A 的 `file` 路由会因签名不符被拒。回调接口按 key 查注册表，B 的 key 不在 A 的注册表里，同样被拒。攻击验证覆盖：伪造的 file 令牌、跨实例回调、对 config 路由的访问。

**备选**：由平台代理 Document Server 与实例之间的全部流量。不采用：要实现文档归属判定，工作量远超收益。

### 8. better-sidebar 补丁与 LibreOffice（B26、B27）

- 移植阶段 0 的 `verify/phase0/patch-better-sidebar.py`：
  - 改为与 #375 同构的 Node 脚本，钉住 0.28.0 和两个文件的输入、输出哈希；
  - 只从 `HOST_OWNED_EXTS` 里去掉 docx、xlsx、pptx。
- 用户镜像装 LibreOffice，供 DSH 自带预览把旧格式和 Document Server 满员时的 docx/xlsx/pptx 转成 PDF 只读显示。
- `htmlViewerNoSandbox` 由覆盖层钉为关闭，即沙箱开启（F36）。
- 下载使用 better-sidebar 文件菜单里的「打包下载」。

### 9. 办公委派改用原生 agentPreset（B4）

- 删除 `plugins/office-agents` 里的选择逻辑。
- 综合办公的子 Agent 委派改用原生的 `agentPreset`/`allowedAgentPresets`，限定 writer。
- 阶段 1 `office-agents` spec 的委派语义保持不变：writer 实际生效、构造回执、权限档、冷读恢复。
- 只修改那些写死了 one-shot 机制的验收表述，改为不依赖子会话模式。

### 10. 权限档覆盖 continuable 子会话（B5）

`permission-tiers` 的 client 半区和 host 半区，对 continuable 子会话应用和根会话同样的档位门禁。阶段 1 的拒绝、允许、取消三条路径和浏览器用例语义保持不变，并对 continuable 子会话补测同样三条路径。

### 11. 模型凭据优先级（B9）

覆盖层给受管 provider 显式绑定平台的环境变量来源，使员工 `.credentials.yaml` 中的同名凭据不生效。具体写法按 0.2.1 的凭据解析器核实后确定。

Docker 用例必须证明：员工在 `.credentials.yaml` 里写入别的密钥后，模型请求仍然使用平台密钥。用一个自有的确定性 provider 观察 Authorization 头的哈希。

做不到就停下来报告，不降级处理。

### 12. 安装入口与插件目录（B6、B7、B8、Q25）

**撤回 #375**

- 删除 `patch-plugin-manager.mjs` 及其 Dockerfile 步骤。
- `REMOVED_TOOLS` 只保留联网工具，并改由开关决定。
- 删除钉死的 `registryProbeEnabled:false` 行，以及相应的测试和文档。

**仓库目录文件**

- `images/dsh-user/catalog.json` 列出每个预装插件和 bundle 的 id、包名、中文名、镜像默认值。
- 它同时进入用户镜像和平台镜像，是两边的唯一来源。

**后台**

- 每一项可以设为「员工自选」「强制开」或「强制关」，存在 settings 中。
- 后两种由覆盖层写入启用状态，员工侧显示为锁定。
- 安装源列表（`pluginManager.registries`）、仓库探测开关、联网工具开关，同样经覆盖层下发。

**员工插件页**

- 每个预装项都必须有开关卡片。
- 为此，镜像的 profile 初始副本里要把这些项登记成 DSH 视为「已安装」的形式。具体形式按 0.2.1 的 `listBundles` 核实。

**生效时机**：实例下次启动时（B20）。

### 13. 本机验证通道（B21、B22、B23）

- **`pnpm test:stack`**
  - 只在 macOS arm64 和本机 Docker 上运行，其他环境直接失败。
  - 在本机构建平台和员工镜像（arm64），用 compose 拉起平台和 Document Server。
  - 连接已运行的本机 RAGFlow 测试栈，地址和密钥只来自私有配置文件。
  - 跑知识库和 Office 的端到端浏览器与接口用例。
  - 资源命名和清理沿用 `dsh-team` 前缀和自有清单的约定。
- **种子脚本**
  - 只对本机测试栈建库、上传、解析。
  - 固定 3 个库、少量小文件，检测到已存在就不再重复解析，以控制嵌入调用量。
- **证据**：PR 贴 exact-head 证据评论，不新增 CI 必需检查，不改 workflow。

### 14. 阶段 1 技术债（B25）

- #374：按 issue 的分类，逐个调用点改为声明 `acceptedStatus` 加独立核验，或者让测试直接失败；不放宽判定。
- #352：调用标签已由 #373 交付。剩下的是：清理因未结 submission 判为 unconfirmed 时，私有终态 `cleanup` 附带有界的「标签→计数」投影（含 `unlabelled`），不含 ID、参数和路径，判定不变；终态解析器接受这个可选键。#352 以交付归因能力关闭，根因在复现前仍为 UNKNOWN。
- #348：在 worker 进程上禁止写字节码缓存，可以在 argv 加 `-B`，或设置 `sys.dont_write_bytecode`。
- fixture 竞态（`platform/test/e2e-engine-fixture.py:513`）：读取进程的网络命名空间时，把 `ENOENT`/`ESRCH` 当作该进程已退出，跳过这个候选，而不是让整次 capture 失败；身份核验本身不放宽。

### Sketch seams under test

| Seam                                                       | 理由                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 平台 HTTP 应用（`buildApp`）                               | 后台配置、代理接口、实例令牌鉴权都用真实 HTTP 和 SQLite 验证，这是阶段 1 已有的最高 seam |
| 覆盖层生成函数（`generateManagedOverlay` 的纯输入输出）    | 监听地址、目录状态、安装源、Office、联网工具开关都是可以穷举的纯数据                     |
| 编排器 owner 接口（start/stop/reconcile，配合真实 Docker） | 固定 IP、令牌注入、Document Server 的接入和断开只有真实 Engine 能证明                    |
| 真实 DSH 浏览器（隔离的 CfT140 加网关）                    | 插件页、知识库面板、Office 编辑器、子会话权限档都属于界面行为                            |
| 构建期补丁脚本（只读的子进程调用）                         | 沿用 #375 的拒绝矩阵测试方法                                                             |
| `pnpm test:stack` 端到端                                   | 唯一连接真实 RAGFlow 和 Document Server 的 seam                                          |

## Not yet specified

- XLSX、PPTX 编辑中只有在实测后才会暴露的格式差异，以及对这些差异各自怎么处理（修补、写入员工文档还是另立需求）。

## Risks / Trade-offs

- [DSH 0.2.1 是预发行线，后续 rc 可能再次破坏] → 只钉 rc.2，后续 rc 另开 PR，全量重验。
- [arm64 本机结果不能代表 amd64] → VPS 门禁不变；Document Server 的 amd64 验证列入阶段 3 的 3.7。
- [放开安装入口后，员工可以装未审核的插件] → 项目方的决定（D9）。安全边界仍是实例隔离（#372），插件只在员工自己的实例内运行。
- [LibreOffice 让镜像变大、转换消耗实例 CPU] → 受实例 CPU 和内存上限约束；记录镜像大小的变化。
- [Document Server 接入所有实例网络，成为共享对端] → 每实例的文件令牌密钥，加上回调查注册表，加上攻击验证。
- [Document Server 满员时可观测的信号未知：F42 规定了提示和退路，但插件或 Document Server 会给出哪种错误还没有实测] → 先在本机通道制造满员、记录实际信号，再实现提示和退路；信号不可区分时停下来报告。
- [本机内存 15.6 GiB 刚到 RAGFlow 推荐值的下限] → 种子数据保持很少；资源不足时 `test:stack` 明确失败，不降级。

## Migration Plan

- DSH 迁移合入后，部署按普通的镜像和平台升级进行。已有员工卷依靠「重置配置」更新 profile（B19）；Session 格式不变。
- Document Server 随 compose 首次启动；`.env` 需要新增地址和 JWT 两个变量。`.env.example` 和 DEPLOY 同步更新。
- 回滚到阶段 1 镜像时，profile 需要再次「重置配置」。DSH 0.2.1 写入的 Session 能否被 0.2.0 读取没有验证，所以回滚前要备份卷。

## Grill ledger

压测分支 B1–B27 的结论都已落入上面的决定和 Non-Goals：

| 分支          | 落点                 |
| ------------- | -------------------- |
| B1、B2        | 决定 1               |
| B3            | 决定 2               |
| B4            | 决定 9               |
| B5            | 决定 10              |
| B6、B7、B8    | 决定 12              |
| B9            | 决定 11              |
| B10           | 决定 1               |
| B11           | 决定 7               |
| B12、B13      | 决定 5、6            |
| B14、B15、B16 | 决定 3               |
| B17           | 决定 4               |
| B18           | 决定 12              |
| B19           | Non-Goals、Migration |
| B20           | 决定 12              |
| B21、B22、B23 | 决定 13              |
| B24           | Non-Goals            |
| B25           | 决定 14              |
| B26、B27      | 决定 8               |

三个开放项去向如下：

- amd64 Document Server：在 Non-Goals 中，挪到阶段 3 的 3.7。
- 内网嵌入模型：在 Non-Goals 中，挪到阶段 3 的 3.7。
- DSH 后续 rc：在 Non-Goals 中。
