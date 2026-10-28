# Proposal

## Why

阶段 1 交付了账号、独立实例、网关和受管覆盖层，跑在 DSH 0.2.0-rc.2 上。阶段 2 要补上知识库检索和 Office 在线编辑这两条员工主链路，并把插件管理和部署形态交给管理员配置。

Office 编辑依赖 `dsh-better-sidebar`，而 0.28.x 的 peer 依赖要求 DSH ^0.2.1-rc.1。所以第一步是升级 DSH，并保持阶段 1 的行为不变。项目方 2026-10-28 的决定还放开了两件事：

- 插件安装入口；
- 联网部署形态。

依据：

- `docs/IMPLEMENTATION_PLAN.md` 阶段 2（任务包 2.0–2.12）；
- `docs/REQUIREMENTS_BASELINE.md`：D9、D16、D24、D25，5.5、5.6，F24、F46、F47；
- `docs/DSH_Enterprise_Architecture_Analysis.md` 2.4、3.4、3.5；
- 本 change 的 `design.md` 汇总的阶段 2 压测结论 B1–B27。

## What Changes

- **DSH 升级（第一批，其余都依赖它）**
  - DSH 升到 0.2.1-rc.2，`dsh-better-sidebar` 升到 0.28.0。
  - **BREAKING（部署内部）**：0.2.1 不允许绑定通配地址。每个实例改为在自己的 /28 子网内用固定 IP 监听，启动令牌按这个地址解析；开发用的 published-loopback 模式也改用自建桥接网络。
  - 镜像插件的兼容性声明改用 `engines.dsh`。
  - 办公委派改用 DSH 原生的 `agentPreset`/`allowedAgentPresets`。
  - 权限档覆盖 continuable 子会话。
  - 受管模型配置始终使用平台注入的密钥，员工的 `.credentials.yaml` 无法覆盖（与升级同一个 PR，F18）。
  - 阶段 1 的旧员工卷经「重置配置」获得 0.2.1 的 profile，有 Docker 用例证明。
  - 地址不在新布局上的阶段 1 运行中实例保持运行，自然停止后按新布局创建。
  - 升级后阶段 1 的自动验收全量重跑。
- **插件安装入口全部保留（撤回 #375）**
  - 删除插件页构建期补丁，覆盖层不再去除 `plugin_manager` 工具。
  - DSH 自带的添加、更新、卸载、on-demand 官方卡片、Discover/插件市场照常可用。
- **插件目录与部署形态**
  - 预装项指镜像在 DSH 发行包之外额外加入的仓库插件、第三方全局包和办公 Agent bundle。
  - 平台入口、权限档、中文界面、Office 提示是受管必启项，固定开启并锁定。
  - 其余预装项由管理员在后台设为三种状态之一：员工自选（`employee`，默认值随镜像）、强制开（`forced-on`）、强制关（`forced-off`）。员工插件页里每个预装项都有开关，强制的项锁定。
  - 管理员配置插件安装源和仓库探测；两项始终受管，初始值等于 DSH 默认（公共源、探测开启）。
  - 联网搜索和抓取工具默认关，管理员可以为联网部署打开。
  - 以上经覆盖层下发，在实例下次启动时生效。
- **RAGFlow**
  - 平台新增只读代理，在 `/_platform/instance-api/ragflow/` 下只有四个接口：知识库列表、库内文件列表、限定范围的检索、版本查询。
    - 编排器每次启动生成一个实例令牌并注入容器，代理凭它识别用户。
    - 代理按响应体的 `code` 判断业务错误，结果取值是唯一的封闭集合；检索前剔除已不存在的知识库；校验每个返回片段属于请求的库集合。
  - 后台新增 RAGFlow 地址、密钥、检索参数配置和连接测试；保存即生效，密钥只留在平台。
  - 新增镜像插件「知识库」，启用状态服从插件目录，包括：
    - 左侧栏面板；
    - 输入区的范围选择控件，选择记在 Session 事件里，提交时快照；
    - 检索工具，子 Agent 沿 `parentSession` 继承范围；
    - 来源展示。
- **Office**
  - Document Server 9.4.0 并入交付的 compose，开启 JWT，挂载运营方字体，平台在每次启动实例时把它接入该员工网络。
    - 容器名由 compose 固定，JWT 以部署 `.env` 为准且 compose 部署必须填写，地址由每个实例的布局决定；不经 compose 的开发、测试入口两项都不给时 Office 不可用，平台照常启动。
    - Document Server 不可用不阻断实例启动，只是该实例的 Office 不可用。
    - 后台可以切换到外部 Document Server。
  - 用户镜像预装 `dsh-better-sidebar@0.28.0` 和 `dsh-sidebar-onlyoffice@0.2.0`，并带两个构建期补丁：
    - better-sidebar 的 Office 扩展名表；
    - ONLYOFFICE 文件令牌和文档 key 改用每个实例单独的密钥，防止借 Document Server 跨用户取文件或推算 key。
  - 新增镜像插件「Office 提示」，显示人机同写、无 Session、满员三条提示；员工文档新建 `docs/EMPLOYEE_GUIDE.md`。
  - 用户镜像装 LibreOffice，供旧格式只读预览，以及 Document Server 满员时的退路。
  - 覆盖层下发 Office 配置，HTML 预览沙箱钉死为开启。
  - 文件区的下载由 better-sidebar 的「打包下载」提供。
- **本机验证通道**
  - 在开发机 arm64 上跑全栈：平台、员工镜像、Document Server、RAGFlow 测试栈。
  - 浏览器用 Playwright Chromium 经网关驱动真实 DSH，模型用测试自有的确定性 provider；只作功能证据，不作隔离证据。
  - 新增 `pnpm test:stack` 和 RAGFlow 测试数据的种子脚本。
  - 涉及 RAGFlow 或 Office 的 PR 要贴 exact-head 的本机证据。VPS 门禁不变。
- **阶段 1 技术债**
  - #374：被容忍的变更型调用失败要显式化。
  - #352：custody 孤立 submission 的归因。
  - #348：e2e fixture 以 root 身份写字节码缓存。
  - e2e-engine fixture 读取进程网络命名空间的竞态。

## Capabilities

### New Capabilities

- `ragflow-proxy`：平台的 RAGFlow 只读代理、实例令牌鉴权、连接与检索参数配置、错误映射和越界校验。
- `knowledge-base`：「知识库」DSH 插件，包括面板、Session 范围选择与快照、检索工具和范围继承、来源展示、错误提示。
- `office-editing`：Document Server 部署与网络接入、两个侧栏插件及补丁、Office 提示、编辑保存回读、跨用户隔离、Office 不可用时的退路、并发和满员提示、旧格式预览、文件下载、HTML 预览沙箱。
- `plugin-catalog`：预装项定义、受管必启项、可管理项的三态、员工开关、安装源与仓库探测配置、保留的安装入口。
- `stack-verification`：本机 arm64 全栈验证通道、本机浏览器与确定性模型、RAGFlow 测试栈种子、证据规则。

### Modified Capabilities

- `managed-config`：
  - 监听地址改为实例固定 IP；
  - 联网工具从绝对禁止改为默认关、管理员开关；
  - 删除 `plugin_manager` 去除和仓库探测钉死这两项要求；
  - 新增插件目录（必启项和三态）、安装源（始终写出）、Office（只在可用时写出）、HTML 沙箱的覆盖层内容；
  - 受管模型密钥优先于员工凭据。
- `user-image`：
  - DSH 版本钉定改为 0.2.1-rc.2；
  - 删除插件页补丁要求；
  - 新增 better-sidebar、ONLYOFFICE 插件及其补丁、知识库和 Office 提示插件、LibreOffice；
  - 镜像插件改用 `engines.dsh`。
- `instance-lifecycle`：
  - 固定 IP；
  - 每次启动生成实例令牌和文件令牌密钥并注入；
  - Document Server 的网络接入，不可用时不阻断启动，退役按启动时的记录断开；
  - 阶段 1 存量实例在对账中保持运行；
  - 重置配置在 0.2.1 下继续可用；
  - 空闲回收补上只打开 Office 编辑器时不回收的场景（F13，阶段 1 留给阶段 2）。
- `instance-isolation`：
  - Document Server 成为除平台外唯一能访问实例的对端；
  - 跨用户经 Document Server 取文件、推算文档 key 被阻止；
  - 更新已记录的隔离边界。
- `office-agents`：委派改用原生 `agentPreset`。
- `permission-tiers`：三档覆盖 continuable 子会话。
- `admin-console`：新增 RAGFlow 配置（测试连接成功时显示 RAGFlow 版本）、检索参数、插件目录、安装源、联网工具开关、外部 Document Server 等页面。
- `audit-log`：新增对应配置修改的事件标识。
- `deployment`：compose 新增 Document Server；`.env.example` 新增 `DOCUMENT_SERVER_CONTAINER_NAME` 和 `DOCUMENT_SERVER_JWT_SECRET`（compose 固定容器名、必填 JWT；示例中 JWT 为空值；平台侧两项都不存在为未配置，显式为空或只有一项时启动失败，因此原样复制示例的本地运行会失败，须删去两行或两项都填）；配置清单核对新增平台与 compose 共用的 `DOCUMENT_SERVER_*` 一类；更新部署文档和 AGENTS.md。
- `trusted-docker-verification`：#374 和 #352 的显式化与归因。
- `built-artifact-verification`：#348 和 fixture 竞态。

## Impact

- **代码**：
  - `platform/src/orchestrator/`（关键路径：固定 IP、令牌注入、Document Server 网络接入）；
  - `platform/src/managed-config/`；
  - 新模块 `platform/src/ragflow-proxy/`；
  - `platform/src/admin/`、`platform/web/src/`。
- **插件**：
  - 新增 `plugins/knowledge-base/`、`plugins/office-hints/`；
  - `plugins/office-agents/`、`plugins/permission-tiers/`、`plugins/zh-locale/`、`plugins/platform-nav/` 的兼容性和委派改动。
- **镜像**：`images/dsh-user/`（关键路径：DSH 版本、两个第三方侧栏插件和两个补丁、知识库和 Office 提示插件、插件目录文件、LibreOffice，删除插件页补丁）。
- **部署**：`deploy/compose.yml`、`.env.example`、`scripts/check-config.mjs`、`docs/DEPLOY.md`、AGENTS.md 的配置清单和本地运行说明；员工文档 `docs/EMPLOYEE_GUIDE.md`（新建）。
- **验证**：
  - 新增 `pnpm test:stack`；
  - VPS 上的 `test:docker`、`test:deploy`、`test:model` 全量重跑；
  - `scripts/` 和 `platform/test/` 的 custody 与 fixture 修复。
- **依赖**：DSH 和 better-sidebar 都升级（DSH 属于预发行版本线上的升级，要在 PR 里标出）；新增 `dsh-sidebar-onlyoffice`。
- **基线**：D9、D16、D24、D25、F24、F46、F47 已在本 change 之前修订。
