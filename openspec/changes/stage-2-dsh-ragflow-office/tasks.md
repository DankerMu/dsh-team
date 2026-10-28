# Tasks

分组顺序就是合入顺序。每组开头写依赖哪些组；没有依赖关系的组可以并行。每个任务对应一个 PR 或一个 PR 里的一步。除非组内注明 `diff-limit-exempt` 并给出理由，单个 PR 不超过 400 行（锁文件和生成的契约不计）。原第 5 组（受管模型密钥优先于员工凭据）已并入第 4 组的原子升级，组号 5 空缺，其余组号不变。

各组共同遵守以下约定：

- **测试放置**沿用阶段 1：
  - `platform/src/` 每个源文件有同目录单元测试，逐文件覆盖率 80%；
  - 绑端口的测试放 `platform/test/*.integration.test.ts`；
  - 真实 Docker 的测试放 `platform/test/*.docker.test.ts`，只在 giap-vps 上跑；
  - 连接真实 RAGFlow 和 Document Server 的用例放本机通道 `pnpm test:stack`（第 10 组建立）。本机浏览器是经平台网关的 Playwright Chromium，模型是测试自有的确定性 provider；本机结果只是功能证据，不是隔离证据。
- **新增密钥字段**（RAGFlow 密钥、实例令牌、文件令牌密钥、Document Server JWT）在引入它的同一变更里加入日志脱敏路径。日志、响应、审计、报告中都不能出现明文。
- **新增 HTTP 路由**声明 schema，并在同一 PR 里运行 `pnpm contract:write`。
- **新增迁移**要同步更新集成测试里的迁移账本断言，以及 AGENTS.md 验证矩阵的版本列表。
- **新增后台页面**要同步更新三处：静态页面清单、`AdminNavigation`、AGENTS.md 的页面清单。还要在 `pnpm test:ui` 中保留桌面和窄屏截图，并做到零控制台错误。
- **RAGFlow 结果取值**只用 `no-results`、`invalid-request`、`not-configured`、`timeout`、`unavailable`、`upstream-error` 这一套（design 决定 3）。
- **插件目录三态**的机器取值只用 `employee`、`forced-on`、`forced-off`（design 决定 12）。
- **证据门禁**：
  - 每个 PR 在 VPS 上跑 exact-head 的 `test:docker` 和 `test:deploy`，与阶段 1 相同；
  - 涉及 RAGFlow 或 Office 的 PR，另外贴 exact-head 的 `pnpm test:stack` 证据评论；
  - 每次跑 `test:model` 都要单独、按 SHA 授权。

## 1. 实例固定地址布局（DSH 0.2.0 上的预备组）

依赖：无。关键路径 `platform/src/orchestrator/`，每行都要人工白盒评审。

- [x] 1.1 扩展 `platform/src/orchestrator/subnet.ts`：新增一个纯函数，由一个对齐的 /28 子网得出 +1 网关、+2 员工容器、+3 平台、+4 Document Server 四个地址；输入不是规范的 /28 时明确拒绝。验证：单元测试覆盖池首、池尾、非 /28 和非规范输入。
- [ ] 1.2a network 模式下，创建容器时用 `IPAMConfig` 把员工容器固定在 +2。创建后检查实际地址，与布局不符时按现有失配路径退役，数据卷保留。DSH 监听地址仍为 `0.0.0.0`。验证：单元测试覆盖创建请求体和地址不符的处理；`pnpm test:docker platform/test/container-network.docker.test.ts` 断言新建容器在 +2。
- [ ] 1.2b 平台接入实例 bridge 时请求 +3，接入后检查实际地址，不符时按现有失配路径处理。平台重建后的对账修复：容器在 +2 的实例以 +3 补接平台；容器不在 +2 的阶段 1 存量实例按阶段 1 方式补接，不指定地址、接入后不按布局核对，也不因此失败或停止。验证：单元测试覆盖两类补接的请求体；`pnpm test:docker platform/test/container-network.docker.test.ts` 断言平台在 +3；`pnpm test:docker platform/test/container-reconcile.docker.test.ts` 覆盖平台重建后两类实例的补接。
- [ ] 1.2c 阶段 1 存量实例的对账用例：用测试自有的方式造一个容器地址不在 +2 的运行中实例，运行新版对账。断言它保持运行、可经网关访问、没有新增审计；随后以空闲或管理员方式停止它，再次启动时容器在 +2，数据卷中的标记仍在。验证：`pnpm test:docker platform/test/container-reconcile.docker.test.ts` 中的新用例通过，自有资源已清理。
- [ ] 1.3 published-loopback 模式改为：建本实例自有的带标签 bridge，容器固定在 +2，再把 3080 发布到 127.0.0.1 的随机端口；不接入平台。退役时删除这个 bridge 的条件与 network 模式相同。验证：`pnpm test:docker platform/test/container-network-mode.docker.test.ts` 断言自有 bridge、+2 地址、仅回环发布，以及退役后网络不存在。
- [ ] 1.4 更新 AGENTS.md 的环境说明：`PLATFORM_UPSTREAM_MODE` 两种模式的地址布局，published-loopback 下 RAGFlow 和 Office 不可用，阶段 1 存量实例保持运行到自然停止。验证：`pnpm lint:agents` 通过；exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认。

Suggested fixture level: expanded - 关键路径，改变每个实例的网络创建和对账，失配处理涉及数据卷保留，还要兼容阶段 1 存量实例
Minimal mergeable slice: 1.1 地址布局纯函数和单元测试单独合入（没有调用方之前不改变任何运行行为）
Risk packs (1.1): selected - Public API（编排器新增导出的纯函数，经 `index.ts` 暴露）、Error handling（非 /28 与非规范输入显式抛错，不给部分结果）；not selected - Config、File IO、Schema、Auth、Concurrency、Resource limits、Legacy compatibility（无调用方；阶段 1 存量实例由 1.2b/1.2c 覆盖）、Release、Documentation（1.4 负责 AGENTS.md）。
Evidence (1.1): 返回形状 `{ gateway, container, platform, documentServer }`，四个点分 IPv4 字符串。`0.0.0.0/28` → `0.0.0.1`/`0.0.0.2`/`0.0.0.3`/`0.0.0.4`；`255.255.255.240/28` → `.241`/`.242`/`.243`/`.244`。拒绝输入至少含 `/27`、`/29`、`/32`、主机位非零的 `x.x.x.1/28`、前导零八位组、首尾空白、`::/28`（可复用 `subnet.test.ts` 的 `INVALID_POOLS`）；错误信息命名的是实例子网，不得出现 `PLATFORM_SUBNET_POOL`。等价规则：新函数接受字符串 s 当且仅当 `allocateSubnet(s, []) === s`，用测试固定；`networks.ts:42` 与 `creation-attempt.ts:52` 现用这一技巧判定规范 /28，迁到新函数属于 1.2a（这两个文件在 1.2a 本就要改），1.1 不动它们。Must preserve：`validateSubnetPool` 仍接受 `/0`–`/28` 并拒绝现有 `INVALID_POOLS`；`allocateSubnet` 结果不变；`subnet.test.ts` 现有用例不修改（禁止把共享的 `parseCidr` 收紧到只认 /28）。

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

依赖：1、2、3。关键路径 `images/dsh-user/`、`platform/src/orchestrator/`。PR 带 `diff-limit-exempt` 标签。理由：4.1–4.4 任何一项单独合入都会让 exact-head 的 `test:docker` 变红；4.6 的凭据绑定如果晚于升级合入，main 上会出现员工凭据覆盖平台密钥的窗口（F18）。PR 描述中要标明这是预发行版本线上的依赖升级。

- [ ] 4.1 用户镜像钉定 `@deepseek-ai/dsh@0.2.1-rc.2`，构建期版本校验随之更新；四个镜像插件用 `engines.dsh` 声明兼容范围，并删除对 0.2.0-rc.2 的精确 peer 断言；镜像内 DSH 版本不满足任一插件的 `engines.dsh` 时构建失败；profile 初始副本按新版本重新生成。验证：用户镜像 Docker 用例中 `dsh --version` 为 `0.2.1-rc.2`，四个插件都被加载，profile 与初始副本逐字节一致；拒绝用例把一个插件的 `engines.dsh` 改为不含 0.2.1-rc.2 的范围，构建以非零状态失败。
- [ ] 4.2 覆盖层的 webserver `host` 改为实例的 +2 地址；启动令牌只从 `dsh web: http://<+2>:3080/…` 这一行提取；对照 0.2.1 发行包核对 DSH 认证 cookie 的格式（`platform/src/orchestrator/credentials.ts:174`）。验证：解析器单元测试覆盖正确的行、旧格式的行、他人 IP 的行；`platform/test/container-readiness.docker.test.ts` 在 0.2.1 上就绪。
- [ ] 4.3 对照覆盖层逐项核对 0.2.1 新增的 preset 行和 bundle（schedule、harness-dev-context、ui-secret-mask、ui-schedule、web-deepseek-api），涉及联网的行纳入联网工具的去除。验证：生成器单元测试列出每个新增行的处理方式；`platform/test/managed-policy.docker.test.ts` 通过。
- [ ] 4.4 `plugins/office-agents` 删除自定义的选择逻辑，综合办公改用原生 `agentPreset`/`allowedAgentPresets` 把委派限定到 writer。Docker 和模型用例中写死 one-shot 的期望，改为不依赖子会话模式。验证：`pnpm test:docker platform/test/office-delegation.docker.test.ts`、`platform/test/office-agents.docker.test.ts` 通过。
- [ ] 4.5 先写凭据优先级的 Docker 用例：员工在 `.credentials.yaml` 中为受管 provider 写入另一个密钥后重启实例，由测试自有的确定性 provider 记录 Authorization 头的哈希，断言使用的是平台密钥。在加入 4.6 的绑定之前，先在本 PR 的升级提交上运行该用例并记录结果（预期失败）。验证：`pnpm test:docker` 跑这个单独用例，留下绑定前的输出。
- [ ] 4.6 覆盖层为受管 provider 显式绑定平台的环境变量来源，使员工凭据不生效。具体写法按 0.2.1 的凭据解析器核实后确定。验证：4.5 的用例通过；生成器单元测试覆盖这个绑定。若 0.2.1 的解析器无法做到，停止并报告，不降级。
- [ ] 4.7 旧卷重置用例：用 0.2.0-rc.2 镜像初始化一对自有命名卷，并写入 Session 和工作区文件标记；换用 0.2.1-rc.2 镜像后执行重置实例配置并启动。断言 `profiles/` 与新镜像种子逐文件一致、实例认证就绪、原有 Session 和文件都可读取。验证：`pnpm test:docker` 中该用例通过，自有卷、容器和镜像都已清理。
- [ ] 4.8 在升级后的镜像上重跑第 3 组的 continuable 用例和阶段 1 全部子会话用例。验证：exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认；另取得单独的 SHA 授权后，`pnpm ci:model` 中办公委派和真实模型用例通过。

Suggested fixture level: expanded - 跨镜像、编排器、覆盖层和三个插件的版本升级，加上平台密钥是否被员工绕过（F18）
Minimal mergeable slice: atomic: 0.2.1 拒绝 0.2.0 的监听值，又会跳过 peer 不匹配的插件，委派语义也随子会话模式改变；凭据绑定晚于升级会留下 F18 窗口；任何一项缺失，exact-head 全量 Docker 都无法保持绿或安全

## 6. 技术债 #374：显式化被容忍的变更型调用失败

依赖：无。由现有 issue #374 承载：Stage 5 不新建 issue，而是编辑 #374 的正文，补齐实现就绪字段并挂到 Epic 下。

- [ ] 6.0 清点 `platform/test/` 和 `scripts/` 中捕获失败后继续执行的变更型 Docker 调用，产出清单写入 #374 正文。每条记录文件和行号、调用、当前的容忍方式，以及选定的处理：声明精确的 `acceptedStatus` 并独立核验结果，或让测试直接失败。验证：#374 正文中有完整清单；对两个目录做一次捕获点检索，结果条数与清单一致，差异逐条说明。
- [ ] 6.1 按 6.0 的清单逐处转换：清单中的每个调用点（同一测试文件内的多个调用点可以合为一条）是 #374 下的一个独立子任务和 PR，各自先写回归测试、再改调用点。不放宽已有的 HTTP 拒绝矩阵和 `unconfirmed` 判定。验证：每个子任务的回归测试在改动前失败、改动后通过；清单逐条勾选，没有遗漏。
- [ ] 6.2 验证：清单全部完成后，exact-head 全量 `test:docker` 通过，清理为 `confirmed`。

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
  - `docker info` 报告的 MemTotal ≥ 14 GiB；
  - 私有配置文件存在，归当前用户所有且权限为 0600；
  - 本机 RAGFlow 测试栈的版本接口可达，且报告的版本为 `v1.0.0-rc2`。

  资源统一使用 `dsh-team` 前缀和本次运行的标签，成功、失败、中断时都只按精确所有权清理。

  验证：Docker-free 的集成测试覆盖每一种前提缺失时的拒绝（包括 MemTotal 为 13.9 GiB 时拒绝），且错误信息里没有配置内容；`pnpm lint:shell` 通过。

- [ ] 10.2 新增种子脚本，只对私有配置中的本机 RAGFlow 写入。它建立固定的 3 个库和少量小文件并解析；已经存在的不重复上传或解析；地址与配置不一致时拒绝执行。验证：对本机测试栈连续运行两次，第二次没有上传或解析请求；用一个与配置不一致的地址运行时被拒绝。
- [ ] 10.3 首个端到端用例：在本机构建平台和员工镜像，用交付的 compose 拉起平台（16.1 合入后，本机通道为 compose 注入本次运行自有、每次新生成的非机密 `DOCUMENT_SERVER_JWT_SECRET`，不进入日志和报告），检查 health，并确认种子数据可读。验证：`pnpm test:stack` 在干净检出上通过，事后没有自有资源残留，RAGFlow 测试栈不变。
- [ ] 10.4 建立本机浏览器和模型运行时：
  - 浏览器用仓库已钉定的 Playwright Chromium 1.63（arm64），经平台网关登录员工、打开真实 DSH 工作台，保留截图并收集控制台错误；
  - 对话模型用测试自有的确定性 provider，复用第 3 组和 `office-delegation` 已有的确定性协议适配器，由它驱动工具调用、子 Agent 委派和写文件；
  - 管理员模型配置在用例中指向这个 provider，不调用外部模型。

  验证：`pnpm test:stack` 中的用例让员工发一条消息，确定性 provider 收到请求、工作台显示回复、Agent 按脚本写出一个文件；截图留存，零意外控制台错误，没有发往外部模型的请求。

- [ ] 10.5 补充文档：
  - 本机 RAGFlow 测试栈（`infiniflow/ragflow:v1.0.0-rc2`）的部署步骤和私有配置文件格式；
  - AGENTS.md 验证矩阵新增 `test:stack` 一行，写明它用 Playwright Chromium 经网关驱动真实 DSH、模型是确定性 provider，是本机功能证据通道，不是隔离 CfT 通道，不提供隔离证据；`constraints.yaml` 的 `verification` 同步；
  - 证据评论的格式。

  验证：`pnpm lint:agents` 通过，文档中的命令照写可以运行。

Suggested fixture level: expanded - 新增验证入口，涉及私有凭据、本机浏览器运行时和本机资源清理
Minimal mergeable slice: 10.1 只有前提检查和所有权清理的骨架单独合入（还没有用例，不影响其他门禁）

## 11. 插件目录与部署形态

依赖：2、4。关键路径 `images/dsh-user/`（11.1 目录文件、11.2 profile 初始副本），以及 `platform/src/orchestrator/`（11.4 把目录、安装源和联网工具设置传入启动时的覆盖层输入）。

- [ ] 11.1 新增 `images/dsh-user/catalog.json`，列出每个预装项的标识、包名、中文名、类别和镜像默认值。当前的预装项是：受管必启项 `platform-nav`、`permission-tiers`、`zh-locale`；可管理项办公 Agent bundle。后续组加入的插件在各自的组里登记。
  - 预装项的定义：镜像构建在 DSH 发行包之外额外加入的仓库插件、第三方全局包和办公 Agent bundle。DSH 发行包自带的 bundle 不在目录内。
  - 枚举来源：镜像的全局 npm 顶层包，减去只装 DSH 的构建阶段记录下来的全局包集合；加上 `/opt/dsh-team/` 下的仓库插件；加上 profile 初始副本中登记的办公 bundle。
  - 对比方法：按包名集合比较目录和枚举结果，任一方向多出都让构建失败，并列出差异。
  - 平台 Dockerfile 的允许清单加入这个文件。

  验证：用户镜像 Docker 用例中，目录缺一项时构建失败、镜像多装一个全局包时构建失败，两者都列出差异；DSH 发行包自带的 bundle 不触发失败；平台镜像用例能读到与用户镜像逐字节相同的清单。

- [ ] 11.2 profile 初始副本把每个预装项登记成 DSH 0.2.1 视为「已安装」的形式（按 `listBundles` 核实），使员工插件页每项都有开关卡片，办公 Agent bundle 也在内。验证：首次使用的浏览器用例截图中，每个清单项都有卡片。
- [ ] 11.3 新增设置迁移：可管理项的三态（初始 `employee`）、安装源列表、仓库探测、联网工具开关。安装源和仓库探测的初始值取 DSH 0.2.1-rc.2 的默认值（默认公共源列表、探测开启），单元测试钉住这份值。新增三组后台接口，body 读完后重新核对当前管理员，保存和审计在同一事务里：
  - `GET/PUT /_platform/api/admin/plugin-catalog` → `plugin-catalog.updated`；受管必启项固定为 `forced-on`，提交其他状态返回 400；
  - `GET/PUT /_platform/api/admin/plugin-sources`（安装源和仓库探测一个保存单元）→ `plugin-sources.updated`；
  - `GET/PUT /_platform/api/admin/web-tools` → `web-tools.updated`。

  验证：集成测试覆盖权限、校验（包括必启项的 400）、回滚和审计，以及迁移账本断言；`pnpm contract:check` 通过。

- [ ] 11.4 覆盖层生成器按设置输出：
  - 受管必启项总是写为启用；
  - `forced-on`、`forced-off` 的项写入启用状态，`employee` 不写；
  - 总是写出安装源列表和仓库探测开关，替换第 2 组保留的钉死值；
  - 联网工具开关关闭时去除这两类工具，打开时不再去除。

  验证：生成器单元测试覆盖每种组合，包括初始设置下输出的安装源等于 DSH 默认值、探测开启；相同输入得到逐字节相同的输出。

- [ ] 11.5 后台「插件目录」页：必启项显示为锁定的强制开；可管理项的三态选择；安装源和仓库探测一个保存区；联网工具开关另一个保存区；提示「实例下次启动生效」。验证：`pnpm test:ui` 中真实接口的保存效果、权限拒绝和截图都通过。
- [ ] 11.6 Docker 浏览器用例：
  - 必启项锁定且开启；`forced-off` 的项锁定且关闭，`forced-on` 的项锁定且开启，`employee` 的项可以切换且不影响他人；
  - 打开联网工具并重启实例后，Agent 的工具中出现这两类工具；
  - 出口观测：用测试自有的 npm registry 替身作为安装源、关闭仓库探测并重启实例，观察到实例只向替身发请求，没有发往公共仓库的探测；
  - 用这个替身 registry 在插件页安装一个测试插件，安装成功并出现在插件页；
  - 员工在自己的 profile 中打开一个 `forced-off` 的预装插件、关闭一个受管必启项、把插件安装源改写成别的地址，然后重启实例：插件页中该 `forced-off` 项仍锁定且关闭、必启项仍锁定且开启，容器内实际生效的插件启用状态和安装源与覆盖层一致（ONLYOFFICE 配置的改写在 18.5，HTML 预览沙箱的改写在 17.3）。

  验证：`pnpm test:docker` 中的新用例通过，并有截图；替身 registry 和其他自有资源都已清理。

Suggested fixture level: expanded - 新的管理员配置面，经覆盖层改变每个实例的插件和工具
Minimal mergeable slice: 11.1 清单文件和构建一致性检查单独合入（不改变运行行为）

## 12. 每次启动的实例令牌和文件令牌密钥

依赖：无。关键路径 `platform/src/orchestrator/`。

- [ ] 12.1 每次启动生成 32 字节随机的 ONLYOFFICE 文件令牌密钥，作为 `DSH_TEAM_ONLYOFFICE_FILE_SECRET` 注入容器，不持久化，加入日志脱敏。验证：单元测试覆盖每次启动生成不同的值、值不进入实例行、日志、审计和错误信息；`pnpm test:docker` 断言容器环境里有该值、平台数据库里没有，再次启动后值改变。
- [ ] 12.2 每次启动生成 32 字节随机的实例令牌，作为 `DSH_TEAM_INSTANCE_TOKEN` 注入容器。新增迁移，实例行只保存令牌的 SHA-256；空闲、管理员、禁用、出错和对账这几种停止路径都清除哈希；重启时轮换。令牌和哈希都加入日志脱敏。验证：单元测试覆盖生成、轮换和每一种停止路径的清除；迁移账本断言更新；`pnpm test:docker` 断言容器环境里有令牌、数据库里只有哈希，停止后哈希为空，再次启动后哈希改变。

Suggested fixture level: expanded - 关键路径，新增注入容器的密钥
Minimal mergeable slice: 12.1 文件令牌密钥的生成和注入单独合入（没有持久化，插件补丁之前没有读取方，不改变行为）

## 13. RAGFlow 连接设置和检索参数

依赖：10（RAGFlow 相关 PR 的本机证据）。

- [ ] 13.1 新增设置迁移，保存 RAGFlow 地址、密钥和检索参数：top_k、相似度阈值、关键词权重、rerank。新增后台接口 `GET/PUT /_platform/api/admin/ragflow-config`（审计 `ragflow-config.updated`）和 `GET/PUT /_platform/api/admin/retrieval-config`（审计 `retrieval-config.updated`）：密钥只返回「已配置」，省略时保留原值，空值拒绝；保存与审计同在一个事务内。密钥加入日志脱敏。验证：集成测试覆盖校验、权限、回滚、审计和迁移账本；`pnpm contract:check` 通过。
- [ ] 13.2 「测试连接」接口 `POST /_platform/api/admin/ragflow-config/test` 只调用版本接口，按响应体 `code` 判断成败，不写审计。请求固定超时、不跟随重定向、限制响应体大小；结果为 `ok` 或 `not-configured`、`unavailable`、`timeout`、`upstream-error` 之一，不含上游内容和密钥。`ok` 时回应带版本字符串（不超过 64 个字符的可打印 ASCII），版本缺失、类型不对或超长时结果为 `upstream-error`，失败结果不带版本。验证：集成测试用自有的假 RAGFlow HTTP 服务覆盖成功（回应含版本）、版本缺失、版本非字符串、版本超长、HTTP 200 加非零 code、密钥被拒、超时、拒绝连接、重定向，并断言审计行数不变，回应中没有地址和密钥。
- [ ] 13.3 后台「知识库」页：连接配置、检索参数、测试连接（每个结果取值一条不同的中文说明，成功时显示 RAGFlow 版本），提示「保存即生效」。验证：`pnpm test:ui` 通过，断言成功结果显示版本，有截图。

Suggested fixture level: expanded - 新增外部凭据的保管和后台写入口
Minimal mergeable slice: 13.1 设置和接口单独合入（还没有消费者，不改变运行行为）

## 14. RAGFlow 只读代理

依赖：1（来源 IP 核对需要 +2 地址）、10（含 10.2 种子）、12、13。

- [ ] 14.1 新增 `platform/src/ragflow-proxy/` 模块和实例专用前缀 `/_platform/instance-api/ragflow/`，先只有鉴权和 `GET version` 路由及其 schema。
  - 该前缀在网关保留路径下，不要求平台会话，不转发给 DSH；它不在 `/_platform/api/` 下，不受 Origin/JSON 变更守卫约束，由 Bearer 鉴权代替。
  - 鉴权只认 Bearer 实例令牌，按令牌哈希找到运行中的实例行，并核对来源 IP 等于该实例的 +2 地址。
  - AGENTS.md 记录这个前缀是 Origin/JSON 守卫的例外及其理由。

  验证：集成测试覆盖有效令牌、平台会话被拒、旧令牌被拒、他人 IP 被拒、无令牌无 Origin 的 POST 被拒，所有拒绝都是不区分原因的 401；网关不把该前缀重定向到登录页或转发给 DSH；前缀下未声明的路径和方法返回 404 或 405；`pnpm contract:check`、`pnpm lint:agents` 通过。

- [ ] 14.2 `GET datasets` 库列表路由：schema、按每次请求读取的设置调用 RAGFlow、按 `code` 映射结果取值、未配置时返回 `not-configured` 且不发外部请求。验证：集成测试用自有的假 RAGFlow 服务覆盖成功、未配置、HTTP 200 加非零 code、超时、拒绝连接。
- [ ] 14.3 `GET datasets/{id}/documents` 库内文件路由：schema、分页参数校验、结果映射同 14.2。验证：集成测试覆盖成功、分页、非法 ID 和参数的 `invalid-request`、上游错误映射。
- [ ] 14.4 `POST retrieval` 检索路由：
  - 要求 JSON 请求体，否则 415；
  - 请求体带检索参数字段时拒绝为 `invalid-request`；
  - 每次请求读取最新设置；
  - 预检并剔除已不存在的库，剩余为空时不检索；
  - 校验返回片段是否越界，越界为 `upstream-error`；
  - 按 `code` 映射到封闭的结果取值；
  - 固定超时、不重定向、限制响应体、不重试；
  - 页码和位置只在有值时出现。

  验证：集成测试用自有的假 RAGFlow 服务逐条覆盖 `ragflow-proxy` spec 中检索相关的场景。

- [ ] 14.5 本机通道用例：用真实 RAGFlow 种子数据分别调用四个接口；管理员修改参数后立即生效；停掉 RAGFlow 后平台其他功能照常、代理返回 `unavailable`。验证：`pnpm test:stack` 通过，并贴出证据评论。

Suggested fixture level: expanded - 新的对外数据通道，包括鉴权、越界和错误映射
Minimal mergeable slice: 14.1 鉴权加版本查询路由单独合入（只读、无检索，可以独立验证）

## 15. 「知识库」插件

依赖：4、10（含 10.2 种子和 10.4 本机浏览器）、11、14。关键路径 `images/dsh-user/`（15.1 镜像交付）。

- [ ] 15.1 新建 `plugins/knowledge-base/`，包含 host 和 client 两半、`engines.dsh` 和成对单元测试。插件以 root 所有、只读的方式随用户镜像交付，并作为可管理项加入 `catalog.json`；三处探测构建和文档中的构建示例都加入 BuildKit 命名上下文。覆盖层在网络方式下给插件平台地址（+3 加平台端口），published-loopback 下不给；插件启用状态只服从目录三态。验证：用户镜像 Docker 用例断言插件只读、已加载，环境、覆盖层和插件目录中都没有 RAGFlow 密钥；生成器单元测试覆盖三种目录状态和两种上游方式。
- [ ] 15.2 左侧栏「知识库」面板：库列表、展开文件、搜索、筛选、分页、刷新，以及加载中、空库、无匹配、失败可重试、知识库未配置五种状态。浏览器请求经插件自己的路由转发到代理。验证：插件单元测试覆盖状态机和取值到状态的映射；本机通道 Playwright 用例在真实种子数据上通过，并有截图，包括未配置 RAGFlow 时的「知识库未配置」。
- [ ] 15.3 输入区范围控件：多选、全选、取消全选；选择存为 `ignorable: true` 的 Session 事件，新 Session 默认全选；提交时快照本轮范围。验证：单元测试覆盖快照语义；本机通道 Playwright 用例用确定性 provider 驱动任务，覆盖刷新和重开后恢复、两个 Session 互相独立、提交后修改不影响进行中的任务。
- [ ] 15.4 检索工具：沿父 Session 回溯到根 Session，取本轮快照；范围为空时不发请求；展示来源；对被剔除的库、`no-results` 和每个失败取值分别给出互不相同的中文提示。验证：单元测试覆盖回溯和六种取值的提示；本机通道用例由确定性 provider 驱动综合办公委派给子 Agent 并调用检索，断言范围不变，以及删除一个库后出现提示。

Suggested fixture level: expanded - 新插件，涉及 Session 状态、子 Agent 继承和外部数据展示
Minimal mergeable slice: 15.1 插件骨架和镜像交付单独合入（没有界面和工具，不影响现有行为）

## 16. Document Server 部署与实例网络接入

依赖：1、10（Office 相关 PR 的本机证据）。关键路径 `platform/src/orchestrator/`（16.3）。

- [ ] 16.1 `deploy/compose.yml` 新增 `documentserver` 服务：9.4.0、固定容器名 `dsh-team-documentserver`、开启 JWT、运营方字体只读挂载、不发布宿主端口、设置 `ALLOW_PRIVATE_IP_ADDRESS=true`。`.env.example` 新增有效赋值 `DOCUMENT_SERVER_JWT_SECRET=`（空值，不放任何密钥或占位密钥），注释写明 compose 部署必须填写、留空时 compose 启动前失败。compose 照 `PLATFORM_CONTAINER_NAME` 的先例把容器名写成字面量：`documentserver` 的 `container_name` 和传给平台的 `DOCUMENT_SERVER_CONTAINER_NAME` 都是 `dsh-team-documentserver`；JWT 以 `${DOCUMENT_SERVER_JWT_SECRET:?…}` 必填插值，同时传给 Document Server 和平台。`pnpm test:deploy` 在 VPS 上用自有的小替身镜像代替 Document Server：VPS 磁盘放不下 8.7 GB 的镜像，真实镜像只在本机通道上运行。`platform/test/deployment-fixture.ts` 把 `.env.example` 解析后写入 `--env-file`，示例中的空 JWT 会让 `:?` 插值失败，所以夹具在正常用例中注入本次调用自有、每次新生成的非机密 JWT（不来自任何真实密钥，不进入日志和报告）；只有下面的未设置或为空用例不注入。`scripts/check-config.mjs` 目前只核对 `PLATFORM_*` 读取和 `DEPLOY_*` 插值，本任务把 compose 中的 `DOCUMENT_SERVER_*` 插值纳入核对，`pnpm test:guardrails` 增加未列出和未消费两个拒绝用例。验证：`pnpm lint:config` 通过（`DOCUMENT_SERVER_JWT_SECRET` 计为 compose 插值；compose 中的容器名是字面量，不计入插值）；`pnpm test:guardrails` 通过；`pnpm test:deploy` 断言这个服务没有发布端口、平台收到的容器名是该字面量、Document Server 和平台收到的 JWT 都是夹具注入的值，并新增用例：`.env` 中 `DOCUMENT_SERVER_JWT_SECRET` 未设置或为空时，启动命令在创建任何容器前失败、错误指出该变量、不留下自有资源；自有资源都已清理。 「JWT 未设置」用例要从夹具的环境中删除该键，而不只是不注入（示例文件本身带有空值行）。
- [ ] 16.2a 平台启动时读取并校验两项 Document Server 输入，平台不为容器名提供默认值：两项都不存在为「自带未配置」，平台照常启动；只存在一项，或任一项显式为空时，在监听前失败并指出配置项，不回显取值，空值不当作未配置。现有 test、e2e、UI 入口自己构造环境、不读 `.env`，不新增变量。读取 `.env` 的本地入口（`pnpm dev`、`pnpm dev:bg`、`pnpm start`）照原样复制示例时，带非空容器名和空 JWT，按设计在监听前失败并指出 `DOCUMENT_SERVER_JWT_SECRET`；本地运行须删去两行（Office 不可用）或两项都填非空值。`.env.example` 在同一变更中新增有效赋值 `DOCUMENT_SERVER_CONTAINER_NAME=dsh-team-documentserver`（取值与 compose 字面量相同），注释写明容器名由 compose 固定；文件开头的复制说明写明：不经 compose 的本地运行要么删去两行 Document Server 配置，要么两项都填非空值，原样复制会因空 JWT 启动失败。JWT 加入日志脱敏。`scripts/check-config.mjs` 同时接受并核对配置模块中字面量的 `DOCUMENT_SERVER_*` 读取。同一变更更新 AGENTS.md：Environment 中 `lint:config` 的说明从「平台读取」和「只给 Compose 的插值」两类改为三类，新增平台读取与 compose 插值共用的 `DOCUMENT_SERVER_*`（`DOCUMENT_SERVER_CONTAINER_NAME` 只计平台读取，compose 中是字面量；`DOCUMENT_SERVER_JWT_SECRET` 两边都计）；「Copy it to `.env`」和本地运行说明写明不经 compose 时删去两行或两项都填，原样复制会在监听前失败。验证：配置单元测试和集成测试覆盖都不存在（照常启动、Office 不可用）、都给出非空值、只存在容器名、只存在 JWT、容器名为空、JWT 为空、两项都为空，失败用例断言错误指出对应变量且不含取值、监听前退出；配置测试读取仓库中真实的 `.env.example`：原样载入时平台在监听前失败、错误指出 `DOCUMENT_SERVER_JWT_SECRET` 且不含取值，删去两行后照常启动且 Office 不可用；`pnpm lint:config` 通过（`DOCUMENT_SERVER_CONTAINER_NAME` 计为平台读取，`DOCUMENT_SERVER_JWT_SECRET` 同时计为平台读取和 compose 插值）；`pnpm test:guardrails` 通过；`pnpm lint:agents` 通过。 同一变更同步 `constraints.yaml` 中 `lint:config` 的 description，写入第三类 `DOCUMENT_SERVER_*`。
- [ ] 16.2b 外部 Document Server 设置：新增迁移保存外部地址和 JWT；后台 `GET/PUT /_platform/api/admin/document-server`，返回当前模式和自带配置是否齐全，JWT 只显示「已配置」；切回自带时清除外部值；保存和审计 `document-server-config.updated` 同在一个事务内。验证：集成测试覆盖权限、校验、保存、切回、回滚、审计和迁移账本；`pnpm contract:write` 后 `pnpm contract:check` 通过。
- [ ] 16.2c 后台「Office」页：显示当前模式、自带配置是否齐全（未配置时显示 Office 不可用），可填写外部地址和 JWT 或切回自带，提示「实例下次启动生效」。验证：`pnpm test:ui` 通过，有截图。
- [ ] 16.3 编排器接入 Document Server：
  - 每次启动把配置的容器名重新解析为当前容器 ID，身份核验通过后以 +4 接入实例 bridge，复用平台接入的路径和 fence；
  - 容器不存在或身份不符：不接入、该次启动的覆盖层不写 Office 配置、实例照常就绪，实例行记录安全原因；
  - 接入调用失败或结果无法确认：按现有启动失败路径处理；
  - 实例行新增本次启动的 Document Server 模式和接入身份（迁移），退役按记录断开，不看当前设置；
  - 不为已运行实例热补接；对账接受记录中的端点存在或已消失；
  - 孤儿网络回收、就绪失败清理、补偿删除和停止规则把已记录的 Document Server 端点与已验证的平台端点同等处理；
  - 外部模式、自带未配置和 published-loopback 都不接入。

  验证：单元测试覆盖每个分支；`pnpm test:docker` 用自有的替身容器断言：+4 接入和停止时断开；替身不存在或身份不符时实例照常就绪且没有 Office 配置；接入失败时启动失败；以自带启动、切到外部后停止，按记录断开；替身重建后已运行实例不被补接、新启动接入新容器；带 Document Server 端点的孤儿网络被回收。`pnpm test:docker platform/test/container-reconcile.docker.test.ts` 新增平台重启和平台容器重建两个用例：各有两个以自带模式启动的运行中实例，一个记录的替身端点仍在，另一个的替身端点已消失（替身已删除）；断言对账后两者都仍为运行且可经网关访问、没有额外启动或停止审计、没有补接或新增任何 Document Server 端点、平台端点在 +3（重建用例中由对账以 +3 补接），仍在的替身端点保留不变。现有 Docker 用例不需要 Document Server 前提：未配置时 Office 不可用，其余断言不变。

- [ ] 16.4 `docs/DEPLOY.md` 补充：字体目录；compose 固定容器名、`.env` 必须填写 `DOCUMENT_SERVER_JWT_SECRET`（未填时 compose 启动前失败）；「两项都不填则 Office 不可用」只适用于不经 compose 的开发、测试入口，显式空值或只给一项会使平台启动失败，照原样复制示例的本地运行因此须删去两行或两项都填；Document Server 重建后已运行实例要重启才恢复 Office；外部 Document Server 的网络可达由运营方负责；阶段 1 的 compose 部署升级时要在 `.env` 新增 `DOCUMENT_SERVER_JWT_SECRET`。验证：文档中的命令照写可以运行。
- [ ] 16.5 隔离验证和文档：更新隔离 Docker 用例，接入 Document Server 替身后每个实例网络恰好有员工容器、平台和替身三个端点，从 B 的实例访问 A 的 +2 地址 3080 和其他常见端口全部失败；部署文档的隔离一节写明 Document Server 的 JWT 在实例内可读、Document Server 是共享对端、插件安装和联网工具不改变隔离边界。验证：`pnpm test:docker platform/test/container-network.docker.test.ts` 通过；隔离一节与测试断言逐条对应。

Suggested fixture level: expanded - 新的部署组件、启动配置契约和编排器接入路径
Minimal mergeable slice: 16.1 compose 服务和 JWT 变量单独合入（平台还不读取这两项，平台行为不变，原样复制示例的本地运行也照常启动；compose 部署从此必须在 `.env` 填写 `DOCUMENT_SERVER_JWT_SECRET`）

## 17. 文件区：better-sidebar、下载、HTML 沙箱与旧格式预览

依赖：4、10（本机通道用例）、11。关键路径 `images/dsh-user/`。

- [ ] 17.1 用户镜像安装 `dsh-better-sidebar@0.28.0`，不打补丁，并作为可管理项加入 `catalog.json`。版本不符时构建失败。验证：用户镜像 Docker 用例断言版本和目录一致；Docker 浏览器用例打开一个 docx，由 better-sidebar 的原生预览显示。
- [ ] 17.2 文件区的「打包下载」。验证：本机通道的浏览器用例选中两个文件下载，压缩包内容与工作目录一致。
- [ ] 17.3 覆盖层把 `htmlViewerNoSandbox` 钉为关闭。验证：生成器单元测试；`pnpm test:docker` 中的 Docker 浏览器用例证明员工设置中该项显示为受管锁定，HTML 预览中的脚本无法访问父页面；员工在自己的 profile 中把 `htmlViewerNoSandbox` 写为开启并重启实例后，结果不变。
- [ ] 17.4 用户镜像安装 LibreOffice，DOC、XLS、PPT 只读预览，在实例内转换。验证：Docker 用例在 `--network none` 下转换三种旧格式成功；记录镜像大小的变化；本机通道 Playwright 用例分别打开 DOC、XLS、PPT，显示只读预览、没有编辑和保存入口，原文件字节不变。

Suggested fixture level: expanded - 关键路径镜像变更
Minimal mergeable slice: 17.1 better-sidebar 单独合入（不打补丁，Office 文件仍由它的原生预览打开，其他功能不变）

## 18. Office 在线编辑

依赖：10（含 10.4 本机浏览器）、11、12、16、17。关键路径 `images/dsh-user/`。

- [ ] 18.1 用户镜像安装 `dsh-sidebar-onlyoffice@0.2.0`，作为可管理项加入 `catalog.json`，并用构建期补丁做两件事：文件令牌密钥改为读取 `DSH_TEAM_ONLYOFFICE_FILE_SECRET`，缺失或为空时拒绝签发和校验；文档 key 改为 `HMAC(文件令牌密钥, 原 key 输入)`，回调和编辑器打开只接受本实例密钥派生的 key。补丁钉住版本和输入、输出哈希，只认唯一一份真实副本，原子写入，归 root 所有。验证：集成测试覆盖版本不符、哈希不符、多个副本时的拒绝，以及拒绝时文件不变；用户镜像 Docker 用例断言补丁后的哈希；Docker 用例在不注入该环境变量时直接请求 `file` 路由，任何令牌（包括公开常量签的）都被拒绝；注入后公开常量签的令牌和按原算法算出的 key 都被拒绝。
- [ ] 18.2 覆盖层写入 ONLYOFFICE 配置，只在本次启动 Office 可用时写：Document Server 地址（+4 或外部地址）、`internalBaseUrl`（+2:3080）、`publicBaseUrl`、JWT。Office 不可用（自带未配置、本次未接入、published-loopback）时不写任何 Office 配置，并把 ONLYOFFICE 写为停用，不论目录状态；后台插件目录页显示原因。验证：生成器单元测试覆盖自带已接入、外部、自带未配置、本次未接入、published-loopback，以及三种目录状态下的 ONLYOFFICE 启用结果；`pnpm test:ui` 覆盖目录页的原因显示。
- [ ] 18.3 better-sidebar 构建期补丁：移植阶段 0 的 `verify/phase0/patch-better-sidebar.py` 为 Node 脚本，从 `HOST_OWNED_EXTS` 中只去掉 docx、xlsx、pptx。补丁钉住 0.28.0 和两个文件的输入、输出哈希，只认唯一一份真实副本，原子写入，归 root 所有。验证：集成测试覆盖版本不符、哈希不符、多个副本时的拒绝，以及拒绝时文件不变；用户镜像 Docker 用例断言补丁后的哈希；Office 不可用的实例打开 docx 得到只读预览。
- [ ] 18.4 新建镜像插件 `plugins/office-hints/`（host 和 client 两半、`engines.dsh`、成对单元测试），作为受管必启项加入 `catalog.json`，以 root 所有、只读的方式交付，所有用户镜像构建入口加入 `office-hints` 命名上下文。它只在 ONLYOFFICE 生效时显示：编辑器中的人机同写提示原文（F40），以及没有 Session 时的中文提示。新建 `docs/EMPLOYEE_GUIDE.md`（先检索 `docs/` 确认没有已有的员工文档），写入这两条提示的含义。验证：单元测试覆盖显示条件；用户镜像 Docker 用例断言插件只读、已加载、ONLYOFFICE 包没有第二个补丁；本机通道 Playwright 用例看到同写提示原文，无 Session 打开 DOCX 时看到中文提示。
- [ ] 18.5 本机通道端到端用例（Playwright Chromium，Agent 动作由确定性 provider 驱动）：
  - DOCX、XLSX、PPTX 编辑保存后写回原文件，Agent 读到最新内容；
  - 两个用户的同名文件互不串写；
  - 跨用户攻击被拒：伪造的文件令牌、跨实例回调、已知 A 的 host 和路径时用猜测的 key 回调或打开编辑器、对 config 路由的访问；
  - 员工在 profile 中改写 ONLYOFFICE 的 `documentServerUrl` 和 `jwtSecret` 后重启，实际值仍为覆盖层的值；做不到时停止并报告；
  - 运营方字体出现在编辑器中；
  - 把空闲分钟数调到 1，员工只保持 ONLYOFFICE 编辑器打开、不发消息、没有任务，超过空闲时间后实例仍为运行、没有空闲停止审计，编辑会话仍能保存并写回原文件。

  验证：`pnpm test:stack` 通过，并贴出证据评论。

- [ ] 18.6 先在本机通道制造 Document Server 满员，记录可观测的信号；再在 `office-hints` 中实现「编辑服务已满」提示，以及退回 17.4 的只读预览。验证：本机通道用例覆盖满员时的提示和预览；信号无法区分时停止并报告。
- [ ] 18.7 实测编辑器打开期间 Agent（由确定性 provider 驱动）改写同一文件时的表现，写进 `docs/EMPLOYEE_GUIDE.md`；员工保存时遵守后写覆盖。验证：本机通道用例与文档描述一致。

Suggested fixture level: expanded - 跨用户隔离和新的共享对端
Minimal mergeable slice: 18.1 插件和补丁单独合入（插件路由会注册，但补丁保证缺少或不匹配密钥时 `file` 路由拒绝一切令牌；用直接请求 `file` 路由的拒绝测试证明，端到端证明在 18.5）

## 19. 阶段 2 集成验收

依赖：1–4、6–18。

- [ ] 19.1 在最终提交上：exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认；`pnpm test:stack` 全量通过，并贴证据评论。另取得单独的 SHA 授权后，`pnpm ci:model` 通过。验证：PR 中有三份证据，和 `dsh-team/docker` 状态。
- [ ] 19.2 按 B10，人工重做受影响的阶段 1 验收项：插件页、办公预设与委派、三档权限；在本机通道上逐项人工验收基线第 7 节的验收 5–11。验证：项目方逐项确认，结果记录在阶段 2 的验收 issue 中。

Suggested fixture level: none - 只做集成验证，不改代码
Minimal mergeable slice: atomic: 只有验证和记录，没有可合并的代码
