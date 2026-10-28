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
- 文档 key 由文件的 host、路径等输入算出，知道这些输入就能推算。
- Document Server 的 JWT 密钥经覆盖层下发，员工可以读到（`/managed/patch.yml` 的权限是 0444）。

**RAGFlow 接口的实测行为**（分析 3.4，实测于 v1.0.0-rc1；阶段 2 钉定 v1.0.0-rc2，下列行为由本机通道在 rc2 上复核，不符时停下来报告）

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
- 内网各知识库的嵌入模型是否一致、内网只读密钥：随阶段 3 的 3.7 确认。阶段 2 只在本机测试栈（单一嵌入模型）上验证多库检索。
- 逐库检索后合并结果（基线第 6 节列为范围外，作为可调项）。
- 员工能自己修改检索参数（B15）。
- 后台可修改「员工自选」项的默认值（Q25：覆盖层机制做不到，默认值随镜像）。
- 老员工卷 profile 的自动同步：仍属阶段 3 的 3.4，阶段 2 依靠「重置配置」（B19）。
- 平台模型代理、每用户独立的模型密钥（基线 T12）。
- DSH 0.2.1-rc.3 及更高版本：等满 7 天后另开升级 PR。
- 向 better-sidebar 上游提需求：不是交付物，补丁继续由镜像构建维护（T6）。
- 外部 Document Server 的网络接入自动化：后台可以切到外部地址，但它能否访问各实例 IP 由运营方负责，部署文档写明。
- 为已运行的实例热补接 Document Server：Document Server 重建后，已运行实例在下次启动时才重新接入。

## Decisions

### 1. 先迁移 DSH，再做功能（B1、B2、B9）

DSH 迁移是阶段 2 的第一批，其余功能组都依赖它。第一批由三个在 0.2.0-rc.2 上先合入的预备组和一个原子升级组组成，每个预备组单独保持阶段 1 的全部验收：

1. 固定地址布局：容器以 +2、平台以 +3 接入，+4 预留（决定 2）。0.2.0 的 webserver 只接受 `127.0.0.1` 和 `0.0.0.0` 两个字面值（`dsh-host-webserver/lib/index.js:142`），所以这一组不改监听地址。
2. 撤回 #375 的插件页补丁和 `plugin_manager` 去除（决定 12）。`registryProbeEnabled:false` 和联网工具的去除保留到插件目录组接上后台开关时再改。
3. 权限档覆盖 continuable 子会话（决定 10）。0.2.0 已支持 `backgroundMode: continuable`，用测试自有的组合产生这类子会话。
4. 原子升级：
   - DSH 钉定改为 0.2.1-rc.2；
   - 覆盖层监听地址改为 +2，启动令牌按新输出行解析；
   - 四个镜像插件改用 `engines.dsh`；
   - 办公委派改用原生 `agentPreset`（决定 9）；
   - DSH 发行包的 cookie 格式核对（`platform/src/orchestrator/credentials.ts:174` 写明了 0.2.0-rc.2 的格式）；
   - 受管模型密钥优先于员工凭据（决定 11）：先写用例，再加绑定；
   - 阶段 1 旧卷经「重置配置」得到 0.2.1 的 profile（B19）的 Docker 用例。

   前五项单独合入都会让 exact-head `test:docker` 变红；凭据绑定如果晚于升级合入，main 上会出现员工 `.credentials.yaml` 覆盖平台密钥的窗口，违反 F18。所以合成一个 PR，带 `diff-limit-exempt` 标签和理由。

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
- published-loopback 模式（只在开发时使用）也建一个自有 bridge 并固定 +2，再把端口发布到 127.0.0.1。这种模式下没有平台和 Document Server 接入，覆盖层不写 Office 配置和知识库平台地址，ONLYOFFICE 和知识库在该实例不可用，文档里写明。

**阶段 1 存量实例**：第 1 组上线时可能有按阶段 1 方式创建、地址不在布局上的运行中实例。

- 对账不主动停止它们，也不额外写审计。它们保持运行，直到空闲、管理员停止或账号禁用这些自然停止发生；下次启动按布局创建。
- 平台重建后为这类实例补接平台端点时，按阶段 1 方式不指定地址，接入后也不按布局核对平台地址。容器在 +2 的实例才请求 +3 并核对。固定布局的「请求并核实」规则只约束按布局创建的实例，这类实例是它唯一的例外。

**备选**：先创建容器、拿到 IP 再生成覆盖层。不采用：要把创建和启动拆开，生命周期 fence 全都要改。

### 3. RAGFlow 只读代理和实例令牌（B14、B15、B16）

**实例令牌**

- 编排器在每次启动时生成 32 字节随机值，作为 `DSH_TEAM_INSTANCE_TOKEN` 注入容器。
- 实例行只保存它的 SHA-256。每一种停止路径都清除它，重启时轮换。

**接口前缀**

- 实例专用前缀是 `/_platform/instance-api/ragflow/`，下面只有四个子路径：

  | 方法 | 子路径                    | 用途     |
  | ---- | ------------------------- | -------- |
  | GET  | `datasets`                | 库列表   |
  | GET  | `datasets/{id}/documents` | 库内文件 |
  | POST | `retrieval`               | 检索     |
  | GET  | `version`                 | 版本查询 |

- 它位于网关保留的 `/_platform` 路径下，网关不要求平台会话，也不转发给 DSH。
- 它不在 `/_platform/api/` 下，所以不受平台变更接口的 Origin/JSON 守卫约束，改由 Bearer 实例令牌鉴权。检索 POST 自己要求 `application/json`。没有令牌（也没有 Origin）的 POST 返回 401。AGENTS.md 记录这一例外。
- 只接受 `Authorization: Bearer <实例令牌>`，不接受平台会话。平台按令牌哈希找到对应的运行中实例行，并核对请求的来源 IP 等于该行的 +2 地址。

**检索的处理顺序**

1. 读取最新的连接设置和检索参数。
2. 请求体中带有检索参数字段的，拒绝为 `invalid-request`，不访问 RAGFlow。
3. 拉取知识库列表，剔除已经不存在的 ID，结果里返回被剔除的 ID。
4. 剩余为空就不请求 RAGFlow。
5. 用剩余的 ID 加管理员配置的检索参数做一次多库检索。
6. 校验每个返回片段的 `dataset_id` 属于请求集合，否则整体以 `upstream-error` 失败。
7. 按响应体 `code` 映射结果。

**结果取值**（封闭集合，代理、插件、后台和测试都只用这一套）

| 取值              | 含义                                                |
| ----------------- | --------------------------------------------------- |
| `no-results`      | 成功但没有片段，不算错误                            |
| `invalid-request` | 请求不合法（空范围、自带检索参数、字段错）          |
| `not-configured`  | RAGFlow 未配置，或地址、密钥被拒（配置错误）        |
| `timeout`         | 超时                                                |
| `unavailable`     | 连接失败（服务中断）                                |
| `upstream-error`  | 其他非零 `code`、越界片段、响应不可解析（服务异常） |

**后台接口与审计事件**（一一对应）

| 接口                                            | 审计事件                   |
| ----------------------------------------------- | -------------------------- |
| `GET/PUT /_platform/api/admin/ragflow-config`   | `ragflow-config.updated`   |
| `GET/PUT /_platform/api/admin/retrieval-config` | `retrieval-config.updated` |
| `POST /_platform/api/admin/ragflow-config/test` | 不写审计，同模型连接测试   |

**其他约定**

- 超时是一个固定常量。代理不做缓存，不做重试。
- RAGFlow 地址、密钥和检索参数存在既有的 settings 中，用一次新迁移。密钥只返回「已配置」。
- 保存即生效：代理每次请求都读设置。
- 「测试连接」只调用版本接口，结果为 `ok` 或上表的失败取值之一。

**备选**：浏览器经网关、凭平台会话直接调用代理。不采用：检索工具运行在容器的 Agent 侧，没有浏览器会话。只靠网络来源放行也不采用：审计和归属无法精确到用户。

### 4. 「知识库」插件（B17，F25、F27–F32、F34）

新增镜像插件 `plugins/knowledge-base/`，root 所有、只读，结构参照 `platform-nav`。

- **Host 半区**
  - 注册插件自己的 HTTP 路由（T11），供浏览器面板转发到代理。
  - 注册检索工具。
- **Client 半区**
  - 左侧栏「知识库」面板：库列表、展开文件、搜索、分页、刷新，区分五种状态：加载中、空库、无匹配、失败可重试、知识库未配置（由 `not-configured` 映射）。
  - 输入区的范围控件，显示当前范围。
- **范围选择**
  - 用一条 `ignorable: true` 的 Session 事件记录；新 Session 默认全选（D10）。
  - 提交时把选择快照进本轮，之后的修改只影响后续任务（F30）。
- **检索工具**
  - 沿 `parentSession` 回溯到根 Session，取本轮快照（F25，T10）。
  - 来源展示片段、文件名和所属库；页码和位置只在有值时显示（F32）。
  - `no-results` 和每个失败取值各有一条不同的中文提示。
- **启用和配置来源**
  - 插件的启用状态完全服从插件目录的三态（决定 12）。
  - 覆盖层只给插件平台地址（实例 bridge 上的 +3:平台端口）；published-loopback 下不给，插件在该实例不可用。
  - 令牌来自环境变量。
  - 插件不接触 RAGFlow 密钥和检索参数。

### 5. Document Server 交付（B12、B13）

- **compose 服务**
  - `deploy/compose.yml` 新增 `documentserver` 服务：`onlyoffice/documentserver:9.4.0`，固定容器名，开启 JWT。
  - 运营方字体目录只读挂载；不发布宿主端口；带 `ALLOW_PRIVATE_IP_ADDRESS=true`。
- **部署输入**（compose 与平台共用，列在 `.env.example`）
  - `DOCUMENT_SERVER_CONTAINER_NAME`：自带 Document Server 的容器名。平台不提供默认值。交付的 compose 与 `PLATFORM_CONTAINER_NAME`（`deploy/compose.yml` 中的字面量 `dsh-team-platform`）同样处理：Document Server 服务的 `container_name` 和传给平台的该变量都是字面量 `dsh-team-documentserver`，不从 `.env` 插值。
  - `DOCUMENT_SERVER_JWT_SECRET`：JWT 密钥。compose 以 `${DOCUMENT_SERVER_JWT_SECRET:?…}` 必填插值，同一个 `.env` 值同时传给 Document Server 和平台。
  - 自带模式没有「地址」变量：地址恒为每个实例子网的 +4。B13「地址和 JWT 以 `.env` 为准」落点为：JWT 以 `.env` 为准，容器名（决定接入谁）由 compose 固定，地址由布局推导。
  - 示例文件取值：`DOCUMENT_SERVER_CONTAINER_NAME=dsh-team-documentserver`（与 compose 字面量相同），`DOCUMENT_SERVER_JWT_SECRET=`（空值，示例不放任何密钥，也不放占位密钥）。两行都必须是有效赋值，`pnpm lint:config` 才把它们算作已列出。
  - 配置清单因此多出第三类：`DOCUMENT_SERVER_*` 是平台读取和 compose 插值共用的变量，不再只有「平台读取的 `PLATFORM_*`」和「只给 compose 用的插值」两类。AGENTS.md 中 `lint:config` 的说明同步改写。
- **compose 部署**：必须设置 JWT。未设置或为空时 compose 在创建任何容器前失败并指出该变量，不会出现「compose 部署但 Office 未配置」的状态。
- **平台侧三态校验**（适用于所有入口）
  - 两项都不存在：自带 Document Server 视为未配置，Office 不可用（ONLYOFFICE 不启用），平台照常启动。只有不经 compose 的入口会走到这一态。
  - 任一项显式为空，或只存在其中一项：监听前失败并指出配置项，不回显取值；空值不当作未配置。
- **不经 compose 的入口**
  - 测试、e2e、UI 入口自己构造环境，不读 `.env`，不需要新增变量，落在「两项都不存在」。
  - 读取 `.env` 的本地入口（`pnpm dev`、`pnpm dev:bg`、`pnpm start`）：照原样复制的示例文件含非空容器名和空 JWT，平台按设计在监听前失败并指出 `DOCUMENT_SERVER_JWT_SECRET`，不会静默进入「Office 不可用」。本地运行二选一：删去这两行（Office 不可用），或两项都填非空值。阶段 1 留下的旧 `.env` 没有这两行，行为不变。
  - 示例文件开头的复制说明、AGENTS.md 的本地运行说明和 DEPLOY 写明这一点。
- **外部 Document Server**
  - 后台可以改用外部 Document Server 的地址和 JWT，存在 settings 中。外部配置优先。
  - 接口 `GET/PUT /_platform/api/admin/document-server`，审计事件 `document-server-config.updated`。
  - 密钥只显示「已配置」。

### 6. Document Server 接入实例网络（B12，T9）

- **每次启动解析**：编排器每次启动实例时，把 `DOCUMENT_SERVER_CONTAINER_NAME` 重新解析为当前容器 ID，不像平台自身那样在 owner 生命周期内钉住。
- **接入**：解析成功且身份核验通过时，以 +4 接入该实例 bridge。身份核验和退役时的断开都复用平台接入的代码路径和 fence。
- **不可用不阻断启动**（与 RAGFlow 一致）：
  - 容器不存在或身份不符：不接入；该次启动的覆盖层不写 Office 配置；Office 在该实例不可用；实例照常就绪；实例行记录安全原因。聊天、文件等其他功能不受影响。
  - 接入调用本身失败或结果无法确认：按现有失败路径处理，不能留下未确认的端点。
- **记录与退役**：每个实例行记录本次启动的 Document Server 模式（自带、外部、未配置）和接入的容器身份。退役按记录断开，不看当前设置。
- **Document Server 被重建**：已运行实例的旧端点在实例退役时按记录处理；不为已运行实例热补接，它们下次启动时接入新容器。
- **对账**：已验证的运行实例网络上，记录中的 Document Server 端点存在或已消失都可接受，对账不补接。阶段 1 中只认「已验证的平台端点」的孤儿网络回收、就绪失败清理、补偿删除和停止规则，扩展为「已验证的平台端点和已记录的 Document Server 端点」。
- **外部和未配置**：选择外部 Document Server 或自带未配置时不做接入。
- **published-loopback**：不做接入，不写 Office 配置。
- **覆盖层**写入 ONLYOFFICE 插件的配置（只在本次启动 Office 可用时）：
  - `documentServerUrl`：自带为 `http://<+4>`，外部为后台地址；
  - `internalBaseUrl` 为 `http://<+2>:3080`；
  - `publicBaseUrl` 为平台对外地址；
  - `jwtSecret`。

### 7. ONLYOFFICE 文件令牌和文档 key 改为每实例密钥（B11）

- 构建期补丁做两件事：
  - 把 `FILE_TOKEN_SECRET` 常量改为读取 `DSH_TEAM_ONLYOFFICE_FILE_SECRET`；环境变量缺失或为空时，铸造和校验令牌都拒绝。
  - 文档 key 改为 `HMAC(文件令牌密钥, 原 key 输入)`。回调和编辑器打开都只接受本实例密钥派生的 key。
- 编排器每次启动生成这个随机值并注入，不持久化。
- 补丁的写法和 #375 一致：
  - 钉住版本、输入 SHA-256、输出 SHA-256；
  - 只认唯一一份真实副本；
  - 原子写入，root 所有。

B 能读到 Document Server 的 JWT，但不知道 A 的文件令牌密钥：

- 借 Document Server 拉 A 的 `file` 路由，会因签名不符被拒。
- 回调接口按 key 查注册表。B 的 key 不在 A 的注册表里；B 知道 A 的 host 和路径也推算不出 A 的 key，同样被拒。

攻击验证覆盖：伪造的 file 令牌、跨实例回调、已知 host 和路径时用猜测的 key 回调或打开编辑器、对 config 路由的访问。

**备选**：由平台代理 Document Server 与实例之间的全部流量。不采用：要实现文档归属判定，工作量远超收益。

### 8. better-sidebar、Office 提示与 LibreOffice（B26、B27）

- **better-sidebar 分两步**
  - 文件区组先装 `dsh-better-sidebar@0.28.0`，不打补丁。Office 文件仍由它的原生预览打开。
  - Office 编辑组在 ONLYOFFICE 及其覆盖层配置合入之后再加补丁（同一组）：移植阶段 0 的 `verify/phase0/patch-better-sidebar.py`，改为与 #375 同构的 Node 脚本，钉住 0.28.0 和两个文件的输入、输出哈希，只从 `HOST_OWNED_EXTS` 里去掉 docx、xlsx、pptx。
- **Office 提示**：新建镜像插件 `plugins/office-hints/`，承载三条界面提示：人机同写提示（F40）、无 Session 提示、满员提示和退回预览（F42）。不给第三方包加第二个补丁。它是受管必启项（决定 12），只在 ONLYOFFICE 生效时显示。员工文档放在新建的 `docs/EMPLOYEE_GUIDE.md`。
- **LibreOffice**：用户镜像装 LibreOffice，供 DSH 自带预览把旧格式、Office 不可用时以及 Document Server 满员时的 docx/xlsx/pptx 转成 PDF 只读显示。
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

本决定是原子升级（决定 1 第 4 项）的一部分。

覆盖层给受管 provider 显式绑定平台的环境变量来源，使员工 `.credentials.yaml` 中的同名凭据不生效。具体写法按 0.2.1 的凭据解析器核实后确定。

Docker 用例必须证明：员工在 `.credentials.yaml` 里写入别的密钥后，模型请求仍然使用平台密钥。用一个自有的确定性 provider 观察 Authorization 头的哈希。用例先于绑定写出，并在没有绑定的升级版本上记录它的结果。

做不到就停下来报告，不降级处理。

### 12. 安装入口与插件目录（B6、B7、B8、Q25）

**撤回 #375**

- 删除 `patch-plugin-manager.mjs` 及其 Dockerfile 步骤。
- `REMOVED_TOOLS` 只保留联网工具，并改由开关决定。
- 删除钉死的 `registryProbeEnabled:false` 行，以及相应的测试和文档。

**预装项**

- 定义：镜像构建在 DSH 发行包之外额外加入的仓库插件、第三方全局包和办公 Agent bundle。
- DSH 发行包自带的 bundle 不在目录内，它们由覆盖层的其他规则管理（如联网工具）。

**仓库目录文件**

- `images/dsh-user/catalog.json` 列出每个预装项的 id、包名、中文名、类别和镜像默认值。
- 它同时进入用户镜像和平台镜像，是两边的唯一来源。
- 构建时把镜像实际的预装项与它对比，两个方向有差异就失败。

**两类目录项**

- 受管必启项：`platform-nav`（平台入口）、`permission-tiers`（权限档）、`zh-locale`（中文界面）、`office-hints`（Office 提示，F40、F42 要求的界面提示）。
  - 在后台目录页和员工插件页显示，固定为 `forced-on` 并锁定。
  - 后台不可改：PUT 提交其他状态返回 400。
- 可管理项：知识库、办公 Agent bundle、better-sidebar、ONLYOFFICE，以及镜像额外预装的其他包，走三态。

**三态**

- 机器取值：`employee`（员工自选，默认）、`forced-on`（强制开）、`forced-off`（强制关），存在 settings 中。
- 后两种由覆盖层写入启用状态，员工侧显示为锁定。`employee` 不写启用状态，默认值随镜像。
- 知识库插件的启用状态完全服从三态，覆盖层只另给它平台地址。
- ONLYOFFICE：本次启动 Office 不可用（自带未配置、Document Server 容器缺失或身份不符、published-loopback）时，无论目录状态都写为停用，后台目录页显示原因；Office 可用时服从三态。

**安装源和仓库探测**

- 始终受管：覆盖层总是写出安装源列表（`pluginManager.registries`）和仓库探测开关。
- 设置的初始值等于 DSH 0.2.1 的默认值：默认公共源列表、探测开启（B7，联网部署用默认源）。内网部署由管理员改为内网镜像或关闭探测。
- 第 2 组过渡期仍写现有的 `registryProbeEnabled:false`；第 11 组切换为「始终写出管理员值，初始为 DSH 默认」。

**联网工具**：开关默认关，经覆盖层下发。

**后台接口与审计事件**（一一对应）

| 接口                                          | 审计事件                 |
| --------------------------------------------- | ------------------------ |
| `GET/PUT /_platform/api/admin/plugin-catalog` | `plugin-catalog.updated` |
| `GET/PUT /_platform/api/admin/plugin-sources` | `plugin-sources.updated` |
| `GET/PUT /_platform/api/admin/web-tools`      | `web-tools.updated`      |

安装源和仓库探测是一个保存单元，联网工具是另一个保存单元。

**员工插件页**

- 每个预装项都必须有开关卡片。
- 为此，镜像的 profile 初始副本里要把这些项登记成 DSH 视为「已安装」的形式。具体形式按 0.2.1 的 `listBundles` 核实。

**生效时机**：实例下次启动时（B20）。

### 13. 本机验证通道（B21、B22、B23）

- **`pnpm test:stack`**
  - 只在 macOS arm64 和本机 Docker 上运行，其他环境直接失败。
  - 内存前提：`docker info` 报告的 MemTotal ≥ 14 GiB，否则在创建资源前失败。
  - 在本机构建平台和员工镜像（arm64），用 compose 拉起平台和 Document Server。
  - 连接已运行的本机 RAGFlow 测试栈，地址和密钥只来自私有配置文件。
  - 跑知识库和 Office 的端到端浏览器与接口用例。
  - 资源命名和清理沿用 `dsh-team` 前缀和自有清单的约定。
- **浏览器**：用仓库已钉定的 Playwright Chromium 1.63（arm64 可用），经平台网关驱动真实 DSH。
  - 这是新的本机功能证据通道，不是 VPS 上的隔离 CfT 通道，不提供隔离证据。
  - 在 stack-verification spec 和 AGENTS.md 里写明。
- **对话模型**：用测试自有的确定性 provider 驱动工具调用、委派和写文件，复用第 3 组和 office-delegation 已有的确定性协议适配器。不调用外部模型。
- **种子脚本**
  - 只对本机测试栈建库、上传、解析。
  - 固定 3 个库、少量小文件，检测到已存在就不再重复解析，以控制嵌入调用量。
- **证据**：PR 贴 exact-head 证据评论，不新增 CI 必需检查，不改 workflow。

### 14. 阶段 1 技术债（B25）

- #374：按 issue 的分类，先清点调用点，再逐个调用点改为声明 `acceptedStatus` 加独立核验，或者让测试直接失败；不放宽判定。
- #352：调用标签已由 #373 交付。剩下的是：清理因未结 submission 判为 unconfirmed 时，私有终态 `cleanup` 附带有界的「标签→计数」投影（含 `unlabelled`），不含 ID、参数和路径，判定不变；终态解析器接受这个可选键。#352 以交付归因能力关闭，根因在复现前仍为 UNKNOWN。
- #348：在 worker 进程上禁止写字节码缓存，可以在 argv 加 `-B`，或设置 `sys.dont_write_bytecode`。
- fixture 竞态（`platform/test/e2e-engine-fixture.py:513`）：读取进程的网络命名空间时，把 `ENOENT`/`ESRCH` 当作该进程已退出，跳过这个候选，而不是让整次 capture 失败；身份核验本身不放宽。

### Sketch seams under test

| Seam                                                       | 理由                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 平台 HTTP 应用（`buildApp`）                               | 后台配置、代理接口、实例令牌鉴权都用真实 HTTP 和 SQLite 验证，这是阶段 1 已有的最高 seam |
| 覆盖层生成函数（`generateManagedOverlay` 的纯输入输出）    | 监听地址、目录状态、安装源、Office、联网工具开关都是可以穷举的纯数据                     |
| 编排器 owner 接口（start/stop/reconcile，配合真实 Docker） | 固定 IP、令牌注入、Document Server 的接入和断开只有真实 Engine 能证明                    |
| VPS 真实 DSH 浏览器（隔离的 CfT140 加网关）                | 插件页、子会话权限档等不依赖 RAGFlow 和 Document Server 的界面行为，并提供隔离证据       |
| 本机真实 DSH 浏览器（Playwright Chromium 加网关）          | 知识库面板、范围控件、Office 编辑器；只是功能证据，不是隔离证据                          |
| 构建期补丁脚本（只读的子进程调用）                         | 沿用 #375 的拒绝矩阵测试方法                                                             |
| `pnpm test:stack` 端到端                                   | 唯一连接真实 RAGFlow 和 Document Server 的 seam                                          |

## Not yet specified

- XLSX、PPTX 编辑中只有在实测后才会暴露的格式差异，以及对这些差异各自怎么处理（修补、写入员工文档还是另立需求）。

## Risks / Trade-offs

- [DSH 0.2.1 是预发行线，后续 rc 可能再次破坏] → 只钉 rc.2，后续 rc 另开 PR，全量重验。
- [arm64 本机结果不能代表 amd64] → VPS 门禁不变；Document Server 的 amd64 验证列入阶段 3 的 3.7。
- [内网各库的嵌入模型可能不一致] → 不一致时单次多库检索不可用。阶段 3 的 3.7 确认后，届时重新评估被排除的逐库合并。
- [放开安装入口后，员工可以装未审核的插件] → 项目方的决定（D9）。安全边界仍是实例隔离（#372），插件只在员工自己的实例内运行。
- [LibreOffice 让镜像变大、转换消耗实例 CPU] → 受实例 CPU 和内存上限约束；记录镜像大小的变化。
- [Document Server 接入所有实例网络，成为共享对端] → 每实例的文件令牌密钥和文档 key，加上回调查注册表，加上攻击验证。
- [Document Server 被重建后，已运行实例的 Office 不可用，直到实例下次启动] → 不热补接，部署文档写明；重启实例即恢复。
- [Document Server 满员时可观测的信号未知：F42 规定了提示和退路，但插件或 Document Server 会给出哪种错误还没有实测] → 先在本机通道制造满员、记录实际信号，再实现提示和退路；信号不可区分时停下来报告。
- [本机内存 15.6 GiB 刚到 RAGFlow 推荐值的下限] → 种子数据保持很少；MemTotal 低于 14 GiB 时 `test:stack` 明确失败，不降级。

## Migration Plan

- 第 1 组上线时，地址不在布局上的阶段 1 运行中实例保持运行，不被对账停止，也不额外写审计；它们自然停止后，下次启动按布局创建（决定 2）。
- DSH 迁移合入后，部署按普通的镜像和平台升级进行。已有员工卷依靠「重置配置」更新 profile（B19），第 4 组用 Docker 用例证明；Session 格式不变。
- Document Server 随 compose 首次启动。阶段 1 的 compose 部署升级时，运营方必须在 `.env` 新增 `DOCUMENT_SERVER_JWT_SECRET`，否则 compose 在启动前失败；容器名由 compose 固定，不需要填写。「两项都不填时平台照常启动、Office 不可用」只适用于不经 compose 的开发、测试入口；从新示例原样复制 `.env` 的本地运行会因空 JWT 在监听前失败，需删去两行或两项都填。`.env.example`、AGENTS.md 和 DEPLOY 同步更新。
- 回滚到阶段 1 镜像时，profile 需要再次「重置配置」。DSH 0.2.1 写入的 Session 能否被 0.2.0 读取没有验证，所以回滚前要备份卷。

## Grill ledger

压测分支 B1–B27 的结论都已落入上面的决定和 Non-Goals：

| 分支          | 落点                         |
| ------------- | ---------------------------- |
| B1、B2        | 决定 1                       |
| B3            | 决定 2                       |
| B4            | 决定 9                       |
| B5            | 决定 10                      |
| B6、B7、B8    | 决定 12                      |
| B9            | 决定 1、11                   |
| B10           | 决定 1                       |
| B11           | 决定 7                       |
| B12、B13      | 决定 5、6                    |
| B14、B15、B16 | 决定 3                       |
| B17           | 决定 4                       |
| B18           | 决定 12                      |
| B19           | 决定 1、Non-Goals、Migration |
| B20           | 决定 12                      |
| B21、B22、B23 | 决定 13                      |
| B24           | Non-Goals                    |
| B25           | 决定 14                      |
| B26、B27      | 决定 8                       |

三个开放项去向如下：

- amd64 Document Server：在 Non-Goals 中，挪到阶段 3 的 3.7。
- 内网嵌入模型一致性和只读密钥：在 Non-Goals 中，随阶段 3 的 3.7 确认；不一致时的影响和应对在 Risks 中。
- DSH 后续 rc：在 Non-Goals 中。
