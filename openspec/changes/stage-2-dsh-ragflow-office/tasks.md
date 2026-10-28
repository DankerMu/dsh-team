# Tasks

分组顺序就是合入顺序。每组开头写依赖哪些组；没有依赖关系的组可以并行。每个任务对应一个 PR 或一个 PR 里的一步。除非组内注明 `diff-limit-exempt` 并给出理由，单个 PR 不超过 400 行（锁文件和生成的契约不计）。

各组共同遵守以下约定：

- **测试放置**沿用阶段 1：
  - `platform/src/` 每个源文件有同目录单元测试，逐文件覆盖率 80%；
  - 绑端口的测试放 `platform/test/*.integration.test.ts`；
  - 真实 Docker 的测试放 `platform/test/*.docker.test.ts`，只在 giap-vps 上跑；
  - 连接真实 RAGFlow 和 Document Server 的用例放本机通道 `pnpm test:stack`（第 10 组建立）。
- **新增密钥字段**（RAGFlow 密钥、实例令牌、文件令牌密钥、Document Server JWT）在引入它的同一变更里加入日志脱敏路径。日志、响应、审计、报告中都不能出现明文。
- **新增 HTTP 路由**声明 schema，并在同一 PR 里运行 `pnpm contract:write`。
- **新增迁移**要同步更新集成测试里的迁移账本断言，以及 AGENTS.md 验证矩阵的版本列表。
- **新增后台页面**要同步更新三处：静态页面清单、`AdminNavigation`、AGENTS.md 的页面清单。还要在 `pnpm test:ui` 中保留桌面和窄屏截图，并做到零控制台错误。
- **证据门禁**：
  - 每个 PR 在 VPS 上跑 exact-head 的 `test:docker` 和 `test:deploy`，与阶段 1 相同；
  - 涉及 RAGFlow 或 Office 的 PR，另外贴 exact-head 的 `pnpm test:stack` 证据评论；
  - 每次跑 `test:model` 都要单独、按 SHA 授权。

## 1. 实例固定地址布局（DSH 0.2.0 上的预备组）

依赖：无。关键路径 `platform/src/orchestrator/`，每行都要人工白盒评审。

- [ ] 1.1 扩展 `platform/src/orchestrator/subnet.ts`：新增一个纯函数，由一个对齐的 /28 子网得出 +1 网关、+2 员工容器、+3 平台、+4 Document Server 四个地址；输入不是规范的 /28 时明确拒绝。验证：单元测试覆盖池首、池尾、非 /28 和非规范输入。
- [ ] 1.2 network 模式下，创建容器时用 `IPAMConfig` 把员工容器固定在 +2，平台接入请求 +3。创建和接入后检查实际地址，与布局不符时按现有失配路径退役，数据卷保留。对账遇到地址不符的存量实例时，停止并保留数据，下次启动按布局重建。DSH 监听地址仍为 `0.0.0.0`。验证：单元测试覆盖请求体和地址不符的处理；`pnpm test:docker platform/test/container-network.docker.test.ts` 断言容器在 +2、平台在 +3。
- [ ] 1.3 published-loopback 模式改为：建本实例自有的带标签 bridge，容器固定在 +2，再把 3080 发布到 127.0.0.1 的随机端口；不接入平台。退役时删除这个 bridge 的条件与 network 模式相同。验证：`pnpm test:docker platform/test/container-network-mode.docker.test.ts` 断言自有 bridge、+2 地址、仅回环发布，以及退役后网络不存在。
- [ ] 1.4 更新 AGENTS.md 的环境说明（`PLATFORM_UPSTREAM_MODE` 两种模式的地址布局），并写明 published-loopback 下 RAGFlow 和 Office 不可用。验证：`pnpm lint:agents` 通过；exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认。

Suggested fixture level: expanded - 关键路径，改变每个实例的网络创建和对账，失配处理涉及数据卷保留
Minimal mergeable slice: 1.1 地址布局纯函数和单元测试单独合入（没有调用方之前不改变任何运行行为）

## 2. 撤回 #375 的插件页补丁（DSH 0.2.0 上的预备组）

依赖：无。关键路径 `images/dsh-user/`。

- [ ] 2.1 删除 `images/dsh-user/patch-plugin-manager.mjs`、Dockerfile 里对应的步骤，以及 `platform/test/plugin-manager-patch.integration.test.ts`。用户镜像的 Docker 用例改为断言：插件管理器的 `client.js` 是发行原样的哈希，插件页可以看到添加和卸载入口。验证：`pnpm test:docker` 中用户镜像用例和首次使用插件页的浏览器用例通过，并有截图。
- [ ] 2.2 覆盖层不再移除 `@deepseek-ai/dsh-plugin-manager/tools`。`registryProbeEnabled: false` 和联网工具的去除保持不变，等第 11 组接上后台开关时再改。验证：生成器单元测试断言输出中没有 `plugin_manager` 的移除项、仓库探测仍为 false；`platform/test/managed-policy.docker.test.ts` 中 Agent 可用的工具包含插件管理工具。
- [ ] 2.3 更新 AGENTS.md 中用户镜像补丁的段落和相关部署文档，删掉已撤回的说明。验证：`pnpm lint:agents` 通过；文档中搜不到 `patch-plugin-manager`。

Suggested fixture level: compact - 删除一个补丁、放开一项受管移除，不新增运行时组件
Minimal mergeable slice: 2.1 镜像侧删除补丁单独合入（覆盖层仍移除插件管理工具，插件页入口恢复，测试保持绿）

## 3. 权限档覆盖 continuable 子会话（DSH 0.2.0 上的预备组）

依赖：无。

- [ ] 3.1 `plugins/permission-tiers` 的 client 和 host 两半，对 continuable 子会话套用与根会话相同的档位判定。子会话继承父会话的档位；恢复时保留子会话自己的档位，不重新继承。验证：成对单元测试覆盖 one-shot 和 continuable 两种子会话在三个档位下的判定，以及恢复时的档位。
- [ ] 3.2 Docker 浏览器用例：用测试自有的 `backgroundMode: continuable` 组合产生 continuable 子会话，验证人工批准档下拒绝、允许、取消三条路径的文件效果和原生审计身份，以及 Auto、Yolo 档的行为；阶段 1 的 one-shot 用例保持不变。验证：`pnpm test:docker platform/test/permission-tiers.docker.test.ts` 通过，截图保存在 `.run/` 下。
- [ ] 3.3 更新 `plugins/permission-tiers/README.md` 中子会话的语义。验证：README 描述与 3.1 的测试一致。

Suggested fixture level: expanded - 权限边界，影响每个子 Agent 的批准行为
Minimal mergeable slice: 3.1 插件判定和成对单元测试单独合入（现有 Docker 用例保持绿，continuable 的浏览器证据随后补上）

## 4. DSH 0.2.1-rc.2 原子升级

依赖：1、2、3。关键路径 `images/dsh-user/`、`platform/src/orchestrator/`。PR 带 `diff-limit-exempt` 标签。理由：下面任何一项单独合入都会让 exact-head 的 `test:docker` 变红。PR 描述中要标明这是预发行版本线上的依赖升级。

- [ ] 4.1 用户镜像钉定 `@deepseek-ai/dsh@0.2.1-rc.2`，构建期版本校验随之更新；四个镜像插件用 `engines.dsh` 声明兼容范围，并删除对 0.2.0-rc.2 的精确 peer 断言；profile 初始副本按新版本重新生成。验证：用户镜像 Docker 用例中 `dsh --version` 为 `0.2.1-rc.2`，四个插件都被加载，profile 与初始副本逐字节一致。
- [ ] 4.2 覆盖层的 webserver `host` 改为实例的 +2 地址；启动令牌只从 `dsh web: http://<+2>:3080/…` 这一行提取；对照 0.2.1 发行包核对 DSH 认证 cookie 的格式（`platform/src/orchestrator/credentials.ts:174`）。验证：解析器单元测试覆盖正确的行、旧格式的行、他人 IP 的行；`platform/test/container-readiness.docker.test.ts` 在 0.2.1 上就绪。
- [ ] 4.3 对照覆盖层逐项核对 0.2.1 新增的 preset 行和 bundle（schedule、harness-dev-context、ui-secret-mask、ui-schedule、web-deepseek-api），涉及联网的行纳入联网工具的去除。验证：生成器单元测试列出每个新增行的处理方式；`platform/test/managed-policy.docker.test.ts` 通过。
- [ ] 4.4 `plugins/office-agents` 删除自定义的选择逻辑，综合办公改用原生 `agentPreset`/`allowedAgentPresets` 把委派限定到 writer。Docker 和模型用例中写死 one-shot 的期望，改为不依赖子会话模式。验证：`pnpm test:docker platform/test/office-delegation.docker.test.ts`、`platform/test/office-agents.docker.test.ts` 通过。
- [ ] 4.5 在升级后的镜像上重跑第 3 组的 continuable 用例和阶段 1 全部子会话用例。验证：exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认；另取得单独的 SHA 授权后，`pnpm ci:model` 中办公委派和真实模型用例通过。

Suggested fixture level: expanded - 跨镜像、编排器、覆盖层和三个插件的版本升级
Minimal mergeable slice: atomic: 0.2.1 拒绝 0.2.0 的监听值，又会跳过 peer 不匹配的插件，委派语义也随子会话模式改变；任何一项缺失，exact-head 全量 Docker 都无法保持绿

## 5. 受管模型密钥优先于员工凭据

依赖：4。

- [ ] 5.1 先写 Docker 用例：员工在 `.credentials.yaml` 中为受管 provider 写入另一个密钥后重启实例，由测试自有的确定性 provider 记录 Authorization 头的哈希，断言使用的是平台密钥。在 4 合入后的 main 上先观察该用例失败或通过，并记录结果。验证：`pnpm test:docker` 跑这个单独用例，留下失败或通过的输出。
- [ ] 5.2 覆盖层为受管 provider 显式绑定平台的环境变量来源，使员工凭据不生效。具体写法按 0.2.1 的凭据解析器核实后确定。验证：5.1 的用例通过；生成器单元测试覆盖这个绑定。若 0.2.1 的解析器无法做到，停止并报告，不降级。

Suggested fixture level: expanded - 平台密钥是否被员工绕过（F18）
Minimal mergeable slice: atomic: 未修复时用例是红的，不能单独合入；修复必须和证明它的用例一起合入

## 6. 技术债 #374：显式化被容忍的变更型调用失败

依赖：无。由现有 issue #374 承载：Stage 5 不新建 issue，而是编辑 #374 的正文，补齐实现就绪字段并挂到 Epic 下。

- [ ] 6.1 列出 `platform/test/` 和 `scripts/` 中捕获失败后继续执行的变更型 Docker 调用。每处二选一：声明精确的 `acceptedStatus` 并独立核验结果，或让测试直接失败。不放宽已有的 HTTP 拒绝矩阵和 `unconfirmed` 判定。验证：每个改动的调用点都有一个回归测试，改动前失败、改动后通过。
- [ ] 6.2 验证：exact-head 全量 `test:docker` 通过，清理为 `confirmed`。

Suggested fixture level: compact - 只改测试和验证脚本，不改产品行为
Minimal mergeable slice: 6.1 中单个调用点的转换和它的回归测试可以单独合入（每处相互独立）

## 7. 技术债 #352：未结 submission 的归因投影

依赖：无。由现有 issue #352 承载，处理方式同第 6 组。#352 以交付归因能力关闭，根因在复现之前仍为 UNKNOWN。

- [ ] 7.1 清理因为有未结 submission 而判为 unconfirmed 时，私有终态的 `cleanup` 附带有界投影：每个调用标签及其计数，未带标签的计入 `unlabelled`。投影不含 ID、参数和路径；判定本身不变；清理已确认时不出现投影。验证：用 Docker-free 的 fixture 覆盖有投影、无投影和超过上限三种情况。
- [ ] 7.2 `scripts/trusted-docker-record.mjs:214` 的终态解析接受这个可选键，旧终态和清理已确认的终态照常解析。验证：解析器的集成测试覆盖新、旧两种形状，以及非法形状的拒绝。

Suggested fixture level: compact - 私有证据格式扩展，不影响判定
Minimal mergeable slice: 7.2 解析器先接受可选键单独合入（还没有写入方之前行为不变）

## 8. 技术债 #348：e2e fixture 不在检出中写字节码缓存

依赖：无。由现有 issue #348 承载，处理方式同第 6 组。

- [ ] 8.1 `platform/test/e2e-engine-fixture.py` 的 worker 在自己的进程内禁止写字节码：在 `worker_args` 里加 `-B`，或设置 `sys.dont_write_bytecode`。验证：Docker-free 的回归测试证明 `scripts/__pycache__` 从未被创建，且在修复前失败。
- [ ] 8.2 验证：在 VPS 上跑完一次后，检出中没有未跟踪的文件；在同一检出上再执行一次 `verify:docker start <同一 SHA>`，可以被接受。

Suggested fixture level: compact - 单个 fixture 进程的参数
Minimal mergeable slice: atomic: 只有一处改动加一个回归测试

## 9. 技术债：e2e-engine fixture 读取网络命名空间的竞态

依赖：无。Stage 5 新建 issue。

- [ ] 9.1 `platform/test/e2e-engine-fixture.py:513` 的 `capture()` 中，读 `/proc/<pid>/ns/net` 遇到 `ENOENT`/`ESRCH` 时，先重新核对出生身份，确认进程已经退出，才在本次观察中跳过这个候选。只有它的所有检查都完成后，才记录它的根目录和命名空间结论。仍存在的进程照常检查，权限错误仍然失败。验证：Docker-free 的 fixture 测试注入两次读取之间进程退出的情形，断言跳过；注入权限错误时断言失败。
- [ ] 9.2 验证：exact-head 全量 `test:docker` 中 `e2e-engine.docker.test.ts` 通过，清理已确认。

Suggested fixture level: compact - 验证 fixture 的观察逻辑，身份核验不放宽
Minimal mergeable slice: atomic: 只改一个函数，加它的回归测试

## 10. 本机全栈验证通道

依赖：4。

- [ ] 10.1 新增根脚本 `pnpm test:stack`，先做前提检查，任何一项不满足就在创建资源前失败：
  - 主机是 macOS arm64，本机 Docker 可用；
  - Docker 可用内存足够；
  - 私有配置文件存在，归当前用户所有且权限为 0600；
  - 本机 RAGFlow 测试栈的版本接口可达。

  资源统一使用 `dsh-team` 前缀和本次运行的标签，成功、失败、中断时都只按精确所有权清理。

  验证：Docker-free 的集成测试覆盖每一种前提缺失时的拒绝，且错误信息里没有配置内容；`pnpm lint:shell` 通过。

- [ ] 10.2 新增种子脚本，只对私有配置中的本机 RAGFlow 写入。它建立固定的 3 个库和少量小文件并解析；已经存在的不重复上传或解析；地址与配置不一致时拒绝执行。验证：对本机测试栈连续运行两次，第二次没有上传或解析请求；用一个与配置不一致的地址运行时被拒绝。
- [ ] 10.3 首个端到端用例：在本机构建平台和员工镜像，用交付的 compose 拉起平台，检查 health，并确认种子数据可读。验证：`pnpm test:stack` 在干净检出上通过，事后没有自有资源残留，RAGFlow 测试栈不变。
- [ ] 10.4 补充文档：
  - 本机 RAGFlow 测试栈的部署步骤和私有配置文件格式；
  - AGENTS.md 验证矩阵新增 `test:stack` 一行，`constraints.yaml` 的 `verification` 同步；
  - 证据评论的格式。

  验证：`pnpm lint:agents` 通过，文档中的命令照写可以运行。

Suggested fixture level: expanded - 新增验证入口，涉及私有凭据和本机资源清理
Minimal mergeable slice: 10.1 只有前提检查和所有权清理的骨架单独合入（还没有用例，不影响其他门禁）

## 11. 插件目录与部署形态

依赖：2、4。

- [ ] 11.1 新增 `images/dsh-user/catalog.json`，列出每个预装插件和 bundle 的标识、包名、中文名和镜像默认值。用户镜像构建时，实际预装内容与清单不一致就失败。平台 Dockerfile 的允许清单要加入这个文件。验证：用户镜像 Docker 用例在缺一项时构建失败；平台镜像用例能读到清单。
- [ ] 11.2 profile 初始副本把每个预装项登记成 DSH 0.2.1 视为「已安装」的形式（按 `listBundles` 核实），使员工插件页每项都有开关卡片，办公 Agent bundle 也在内。验证：首次使用的浏览器用例截图中，每个清单项都有卡片。
- [ ] 11.3 新增设置迁移：每项的三态、安装源列表、仓库探测、联网工具开关。新增后台 GET/PUT，body 读完后重新核对当前管理员；保存和审计在同一事务里，事件为 `plugin-catalog.updated`、`plugin-sources.updated`、`web-tools.updated`。验证：集成测试覆盖权限、校验、回滚和审计，以及迁移账本断言；`pnpm contract:check` 通过。
- [ ] 11.4 覆盖层生成器按设置输出：
  - 强制开、强制关的项写入启用状态；
  - 写入安装源列表和仓库探测开关，替换第 2 组保留的钉死值；
  - 联网工具开关关闭时去除这两类工具，打开时不再去除。

  验证：生成器单元测试覆盖每种组合，相同输入得到逐字节相同的输出。

- [ ] 11.5 后台「插件目录」页：三态选择、安装源、仓库探测、联网工具开关，并提示「实例下次启动生效」。验证：`pnpm test:ui` 中真实接口的保存效果、权限拒绝和截图都通过。
- [ ] 11.6 Docker 浏览器用例：强制关的项锁定且关闭，强制开的项锁定且开启，员工自选的项可以切换且不影响他人；打开联网工具并重启实例后，Agent 的工具中出现这两类工具。验证：`pnpm test:docker` 中的新用例通过，并有截图。

Suggested fixture level: expanded - 新的管理员配置面，经覆盖层改变每个实例的插件和工具
Minimal mergeable slice: 11.1 清单文件和构建一致性检查单独合入（不改变运行行为）

## 12. 每次启动的实例令牌和文件令牌密钥

依赖：无。关键路径 `platform/src/orchestrator/`。

- [ ] 12.1 每次启动生成 32 字节随机的实例令牌和 ONLYOFFICE 文件令牌密钥，分别作为 `DSH_TEAM_INSTANCE_TOKEN`、`DSH_TEAM_ONLYOFFICE_FILE_SECRET` 注入容器。实例行只保存令牌的 SHA-256，停止时清除，重启时轮换。新增迁移，两个字段都加入日志脱敏。验证：单元测试覆盖生成、轮换和清除；迁移账本断言更新；`pnpm test:docker` 断言容器环境里有这两个值、数据库里只有哈希，再次启动后哈希改变。

Suggested fixture level: expanded - 关键路径，新增注入容器的密钥
Minimal mergeable slice: atomic: 一个迁移加一处注入，拆开后其中一半没有调用方

## 13. RAGFlow 连接设置和检索参数

依赖：无。

- [ ] 13.1 新增设置迁移，保存 RAGFlow 地址、密钥和检索参数：top_k、相似度阈值、关键词权重、rerank。新增后台 GET/PUT：密钥只返回「已配置」，省略时保留原值，空值拒绝；保存与审计同在一个事务内，事件为 `ragflow-config.updated`、`retrieval-config.updated`。密钥加入日志脱敏。验证：集成测试覆盖校验、权限、回滚、审计和迁移账本；`pnpm contract:check` 通过。
- [ ] 13.2 「测试连接」接口只调用版本接口，按响应体 `code` 判断成败。请求固定超时、不跟随重定向、限制响应体大小；返回封闭的结果集合，不含上游内容和密钥。验证：集成测试用自有的假 RAGFlow HTTP 服务覆盖成功、HTTP 200 加非零 code、超时、拒绝连接、重定向。
- [ ] 13.3 后台「知识库」页：连接配置、检索参数、测试连接，提示「保存即生效」。验证：`pnpm test:ui` 通过，有截图。

Suggested fixture level: expanded - 新增外部凭据的保管和后台写入口
Minimal mergeable slice: 13.1 设置和接口单独合入（还没有消费者，不改变运行行为）

## 14. RAGFlow 只读代理

依赖：1（来源 IP 核对需要 +2 地址）、12、13。

- [ ] 14.1 新增 `platform/src/ragflow-proxy/` 模块和实例专用的路由前缀。鉴权只认 Bearer 实例令牌，按令牌哈希找到运行中的实例行，并核对来源 IP 等于该实例的 +2 地址。四个只读路由都声明 schema。验证：集成测试覆盖有效令牌、平台会话被拒、旧令牌被拒、他人 IP 被拒，所有拒绝都是不区分原因的 401；未声明的路径和方法返回 404 或 405。
- [ ] 14.2 检索的处理：
  - 每次请求读取最新设置；
  - 预检并剔除已不存在的库，剩余为空时不检索；
  - 拒绝请求中自带的检索参数；
  - 校验返回片段是否越界；
  - 按 `code` 映射到封闭错误集合；
  - 固定超时、不重定向、限制响应体、不重试；
  - 页码和位置只在有值时出现。

  验证：集成测试用自有的假 RAGFlow 服务逐条覆盖 `ragflow-proxy` spec 的场景。

- [ ] 14.3 本机通道用例：用真实 RAGFlow 种子数据分别调用四个接口；管理员修改参数后立即生效；停掉 RAGFlow 后平台其他功能照常。验证：`pnpm test:stack` 通过，并贴出证据评论。

Suggested fixture level: expanded - 新的对外数据通道，包括鉴权、越界和错误映射
Minimal mergeable slice: 14.1 鉴权加版本查询路由单独合入（只读、无检索，可以独立验证）

## 15. 「知识库」插件

依赖：4、11、14。

- [ ] 15.1 新建 `plugins/knowledge-base/`，包含 host 和 client 两半、`engines.dsh` 和成对单元测试。插件以 root 所有、只读的方式随用户镜像交付，并加入 `catalog.json`；三处探测构建和文档中的构建示例都加入 BuildKit 命名上下文。覆盖层给插件平台地址（+3 加平台端口）。验证：用户镜像 Docker 用例断言插件只读、已加载，环境、覆盖层和插件目录中都没有 RAGFlow 密钥。
- [ ] 15.2 左侧栏「知识库」面板：库列表、展开文件、搜索、筛选、分页、刷新，以及加载中、空库、无匹配、失败可重试四种状态。浏览器请求经插件自己的路由转发到代理。验证：插件单元测试覆盖状态机；本机通道浏览器用例在真实种子数据上通过，并有截图。
- [ ] 15.3 输入区范围控件：多选、全选、取消全选；选择存为 `ignorable: true` 的 Session 事件，新 Session 默认全选；提交时快照本轮范围。验证：单元测试覆盖快照语义；本机通道浏览器用例覆盖刷新和重开后恢复、两个 Session 互相独立、提交后修改不影响进行中的任务。
- [ ] 15.4 检索工具：沿父 Session 回溯到根 Session，取本轮快照；范围为空时不发请求；展示来源；对被剔除的库和四类错误分别给出中文提示。验证：单元测试覆盖回溯和错误映射；本机通道用例覆盖综合办公委派给子 Agent 后检索范围不变，以及删除一个库后出现提示。

Suggested fixture level: expanded - 新插件，涉及 Session 状态、子 Agent 继承和外部数据展示
Minimal mergeable slice: 15.1 插件骨架和镜像交付单独合入（没有界面和工具，不影响现有行为）

## 16. Document Server 部署与实例网络接入

依赖：1。关键路径 `platform/src/orchestrator/`（16.3）。

- [ ] 16.1 `deploy/compose.yml` 新增 `documentserver` 服务：9.4.0、固定容器名、开启 JWT、运营方字体只读挂载、不发布宿主端口、设置 `ALLOW_PRIVATE_IP_ADDRESS=true`。`.env.example` 新增 Document Server 地址和 JWT，由 compose 和平台共同使用。`pnpm test:deploy` 在 VPS 上用自有的小替身镜像代替 Document Server：VPS 磁盘放不下 8.7 GB 的镜像，真实镜像只在本机通道上运行。验证：`pnpm lint:config` 通过；`pnpm test:deploy` 断言这个服务没有发布端口，自有资源都已清理。
- [ ] 16.2 平台读取自带 Document Server 的配置，缺失或为空时启动失败。后台可以改用外部 Document Server 的地址和 JWT：外部配置优先；JWT 只显示「已配置」；审计事件为 `document-server-config.updated`；JWT 加入日志脱敏。后台增加「Office」页。验证：集成测试覆盖启动失败、保存、回滚和审计；`pnpm test:ui` 通过，有截图。
- [ ] 16.3 编排器把配置名指定的 Document Server 容器以 +4 接入每个实例 bridge，身份核验、退役时的断开和对账修复都复用平台接入的路径；选择外部 Document Server 时不做接入。验证：`pnpm test:docker` 用自有的替身容器断言 +4 接入、退役时断开、平台重建后对账修复；选择外部 Document Server 时没有接入。
- [ ] 16.4 `docs/DEPLOY.md` 补充：字体目录、Document Server 的两个变量、外部 Document Server 的网络可达由运营方负责、阶段 1 部署升级时要新增这两个变量。验证：文档中的命令照写可以运行。

Suggested fixture level: expanded - 新的部署组件和编排器接入路径
Minimal mergeable slice: 16.1 compose 服务和变量单独合入（还没有接入实例，平台行为不变）

## 17. 文件区：better-sidebar、下载、HTML 沙箱与旧格式预览

依赖：4、11。关键路径 `images/dsh-user/`。

- [ ] 17.1 用户镜像安装 `dsh-better-sidebar@0.28.0` 并加入 `catalog.json`，并用 Node 构建期补丁从 `HOST_OWNED_EXTS` 中只去掉 docx、xlsx、pptx。补丁钉住版本和两个文件的输入、输出哈希，只认唯一一份真实副本，原子写入，归 root 所有。验证：集成测试覆盖版本不符、哈希不符、多个副本时的拒绝，以及拒绝时文件不变；用户镜像 Docker 用例断言补丁后的哈希。
- [ ] 17.2 文件区的「打包下载」。验证：本机通道的浏览器用例选中两个文件下载，压缩包内容与工作目录一致。
- [ ] 17.3 覆盖层把 `htmlViewerNoSandbox` 钉为关闭。验证：生成器单元测试；浏览器用例证明员工设置中该项显示为受管锁定，HTML 预览中的脚本无法访问父页面。
- [ ] 17.4 用户镜像安装 LibreOffice，DOC、XLS、PPT 只读预览，在实例内转换。验证：Docker 用例在 `--network none` 下转换三种旧格式成功；记录镜像大小的变化。

Suggested fixture level: expanded - 关键路径镜像变更和构建期补丁
Minimal mergeable slice: 17.1 better-sidebar 和补丁单独合入（Office 扩展名暂时回落到原生处理，其他功能不变）

## 18. Office 在线编辑

依赖：11、12、16、17。关键路径 `images/dsh-user/`。

- [ ] 18.1 用户镜像安装 `dsh-sidebar-onlyoffice@0.2.0` 并加入 `catalog.json`，并用构建期补丁把文件令牌密钥改为读取 `DSH_TEAM_ONLYOFFICE_FILE_SECRET`，缺失或为空时拒绝签发和校验。补丁的钉定方式与 17.1 相同。验证：集成测试覆盖拒绝矩阵；用户镜像 Docker 用例断言补丁后的哈希，并证明缺少该环境变量时打开文件会失败。
- [ ] 18.2 覆盖层写入 ONLYOFFICE 配置：Document Server 地址（+4 或外部地址）、`internalBaseUrl`（+2:3080）、`publicBaseUrl`、JWT。验证：生成器单元测试覆盖自带和外部两种情况。
- [ ] 18.3 本机通道用例：
  - DOCX、XLSX、PPTX 编辑保存后写回原文件，Agent 读到最新内容；
  - 两个用户的同名文件互不串写；
  - 跨用户攻击被拒：伪造的文件令牌、跨实例回调、对 config 路由的访问；
  - 没有 Session 时有提示；
  - 编辑器中可见人机同写的提示原文；
  - 运营方字体出现在编辑器中。

  验证：`pnpm test:stack` 通过，并贴出证据评论。

- [ ] 18.4 先在本机通道制造 Document Server 满员，记录可观测的信号；再实现「编辑服务已满」提示，以及退回 17.4 的只读预览。验证：本机通道用例覆盖满员时的提示和预览；信号无法区分时停止并报告。
- [ ] 18.5 实测编辑器打开期间 Agent 改写同一文件时的表现，写进员工文档；员工保存时遵守后写覆盖。验证：本机通道用例与文档描述一致。

Suggested fixture level: expanded - 跨用户隔离和新的共享对端
Minimal mergeable slice: 18.1 插件和补丁单独合入（还没有 Office 配置时插件不注册路由，现有行为不变）

## 19. 阶段 2 集成验收

依赖：1–18。

- [ ] 19.1 在最终提交上：exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认；`pnpm test:stack` 全量通过，并贴证据评论。另取得单独的 SHA 授权后，`pnpm ci:model` 通过。验证：PR 中有三份证据，和 `dsh-team/docker` 状态。
- [ ] 19.2 按 B10，人工重做受影响的阶段 1 验收项：插件页、办公预设与委派、三档权限；在本机通道上逐项人工验收基线第 7 节的验收 5–11。验证：项目方逐项确认，结果记录在阶段 2 的验收 issue 中。

Suggested fixture level: none - 只做集成验证，不改代码
Minimal mergeable slice: atomic: 只有验证和记录，没有可合并的代码
