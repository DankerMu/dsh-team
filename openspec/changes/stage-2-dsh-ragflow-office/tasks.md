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
- [ ] 1.2c 阶段 1 存量实例的对账用例：用测试自有的方式造一个容器地址不在 +2 的运行中实例，在删除并重建 stand-in 平台后（或所造实例尚未接入平台时）运行新版对账，使对账走到 `restorePlatform` 的 connect。断言它保持运行、可经网关访问、没有新增审计，connect 请求体不带 `EndpointConfig`，补接后的平台端点没有 `IPAMConfig` 且地址在 (基址, 基址+15) 内；随后以空闲或管理员方式停止它，再次启动时容器在 +2，数据卷中的标记仍在。验证：`pnpm test:docker platform/test/container-reconcile.docker.test.ts` 中的新用例通过，自有资源已清理。
- [ ] 1.3 published-loopback 模式改为：建本实例自有的带标签 bridge，容器固定在 +2，再把 3080 发布到 127.0.0.1 的随机端口；不接入平台。退役时删除这个 bridge 的条件与 network 模式相同。验证：`pnpm test:docker platform/test/container-network.docker.test.ts`（published-loopback 用例所在文件）断言自有 bridge、+2 地址、仅回环发布，以及退役后网络不存在。
- [ ] 1.4 更新 AGENTS.md 的环境说明：`PLATFORM_UPSTREAM_MODE` 两种模式的地址布局，published-loopback 下 RAGFlow 和 Office 不可用，阶段 1 存量实例保持运行到自然停止。验证：`pnpm lint:agents` 通过；exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认。

Suggested fixture level: expanded - 关键路径，改变每个实例的网络创建和对账，失配处理涉及数据卷保留，还要兼容阶段 1 存量实例
Minimal mergeable slice: 1.1 地址布局纯函数和单元测试单独合入（没有调用方之前不改变任何运行行为）
Risk packs (1.1): selected - Public API（编排器新增导出的纯函数，经 `index.ts` 暴露）、Error handling（非 /28 与非规范输入显式抛错，不给部分结果）；not selected - Config、File IO、Schema、Auth、Concurrency、Resource limits、Legacy compatibility（无调用方；阶段 1 存量实例由 1.2b/1.2c 覆盖）、Release、Documentation（1.4 负责 AGENTS.md）。
Evidence (1.1): 返回形状 `{ gateway, container, platform, documentServer }`，四个点分 IPv4 字符串。`0.0.0.0/28` → `0.0.0.1`/`0.0.0.2`/`0.0.0.3`/`0.0.0.4`；`255.255.255.240/28` → `.241`/`.242`/`.243`/`.244`。拒绝输入至少含 `/27`、`/29`、`/32`、主机位非零的 `x.x.x.1/28`、前导零八位组、首尾空白、`::/28`（可复用 `subnet.test.ts` 的 `INVALID_POOLS`）；错误信息命名的是实例子网，不得出现 `PLATFORM_SUBNET_POOL`。等价规则：新函数接受字符串 s 当且仅当 `allocateSubnet(s, []) === s`，用测试固定；`networks.ts:42` 与 `creation-attempt.ts:52` 现用这一技巧判定规范 /28，迁到新函数属于 1.2a（这两个文件在 1.2a 本就要改），1.1 不动它们。Must preserve：`validateSubnetPool` 仍接受 `/0`–`/28` 并拒绝现有 `INVALID_POOLS`；`allocateSubnet` 结果不变；`subnet.test.ts` 现有用例不修改（禁止把共享的 `parseCidr` 收紧到只认 /28）。
Risk packs (1.2a): selected - Concurrency / shared state（容器创建请求与创建后核对共用同一捕获网络与子网）、Error handling / rollback（地址不符走现有启动失败补偿：退役容器与自有网络、保留两个数据卷、行置 `error` 并写 `instance.start-failed` 审计）、Legacy compatibility（阶段 1 存量容器无 `IPAMConfig` 声明，宽松的范围核对必须保留给对账/就绪路径，1.2b/1.2c 依赖这一点）、Public API（创建请求体形状）；not selected - Config（无新配置）、File IO、Schema、Auth、Resource limits、Release、Documentation（1.4）。
Evidence (1.2a): 仅 `network` 模式的创建请求体在 `NetworkingConfig.EndpointsConfig[<network.id>]` 增加 `IPAMConfig: { IPv4Address: <基址+2> }`，+2 由 `instanceAddressLayout(network.subnet).container` 得出；published-loopback 的请求体不变（固定 +2 属于 1.3）。核对时机是启动后、接入平台前：创建后 Docker 的 `IPAddress` 为空且 `validateUserNetwork(created=true)` 对未运行容器提前返回，所以布局核对钉在 `startedUpstream` 的第一次 `validateUserNetwork`（`start.ts` 第 217 行），失败则不接入平台、不记录就绪，走现有启动失败补偿（退役容器与自有网络、保留 `dsh-team-home-*`/`dsh-team-work-*` 两卷、行置 `error`、写 `instance.start-failed` 审计）；`compensateStarted` 内对同一容器的身份校验（`start.ts` 第 167 行，处于 try/catch 内，现已传 `created=true` 但容器在运行且端点在 `Containers` 里，不会提前返回）看到的是运行中、端点已在 `network.Containers` 的容器，不会走 `created=true` 的提前返回，所以 `validateUserNetwork` 要加一个显式参数（不是隐藏默认值），由这一处调用传入以跳过整个声明分支（声明等于实际、以及 +2 布局两项），只保留阶段 1 的 (基址, 基址+15) 范围核对；否则失配容器会被吞掉的异常留下不退役。其余所有 `validateUserNetwork` 调用点都套用声明分支，声明失配的文档在这些地方一律失败：`start.ts` 第 217/240/402 行、`readiness.ts` 第 120 行、`reconcile.ts` 第 134/202 行、`creation-attempt.ts` 第 287/300 行、`start-identity.ts` 第 153 行、`credentials.ts` 第 305 行。假 daemon 在创建与启动两处都调用 `attach`（`container-start-fixture.ts` 第 347/381 行，`attach` 本身在第 233 行；`seedRunning` 第 450 行也调用它）：创建时就把端点写进 `row.Containers`，这是与真实 Docker 的已知差异（真实 Docker 在启动前没有端点，`start.ts` 第 402 行的 `validateUserNetwork(created=true)` 对未运行容器提前返回），现有二十余个测试文件依赖这一登记，1.2a 保留它；因此在假 daemon 下第 402 行的声明分支在创建时就会先跑一次，创建时的 `attach` 必须回显匹配的 `IPAMConfig: { IPv4Address: +2 }` 并以 +2 作为地址，不拒绝已被持有的地址；测试自有的“声明 +2、实际 +5”覆盖点只对启动时的 `attach`（第 381 行）生效：把 `row.Containers[<id>].IPv4Address` 换成 `<+5>/28`、attachment 的 `IPAddress` 换成 +5，回显的 `IPAMConfig` 仍为 +2；启动时所请求地址已被该网络其他端点持有则启动返回 500 `Address already in use`（与真实 Docker 一致，拒绝只发生在启动时）；这一占用检查不能放在 `fixtureAddress`（第 139 行对已登记容器提前返回自己创建时的地址），要放在 `attach` 或启动处理器里，只与其他端点 ID 的地址比较（排除容器自己创建时的登记），并在置 `State.Running` 之前拒绝。共享校验器 `validateEndpointAddress` 的“声明分支”对任何端点角色相同：attachment 带 `IPAMConfig.IPv4Address` 时，实际 `IPAddress` 必须等于声明，端点 `IPv4Address` 必须等于 `<声明>/28`；只有 `validateUserNetwork` 的员工容器调用点额外要求声明等于 `instanceAddressLayout(subnet).container`（平台 +3 由 1.2b 加在其调用点，这里不得硬编码）。声明边界：`IPAMConfig` 缺失、null 或空对象 `{}` 视为无声明，保持阶段 1 的 (基址, 基址+15) 范围核对（真实 Docker 对未请求地址的端点回报 null，空对象只是防御）；`IPAMConfig` 非空但 `IPv4Address` 缺失、空、非字符串或非 IPv4 时失败，不回落到宽松核对；真实 Docker 对未请求地址端点的实际回报由 exact-head 的 `container-network-mode`/`container-reconcile` Docker 用例证实。假 daemon（`platform/test/container-start-fixture.ts` 的 `attach`）现在忽略 `IPAMConfig` 而自行分配地址，须改为与真实 Docker 一致：请求了 `IPAMConfig.IPv4Address` 时以该地址作为 `IPAddress` 和端点 `IPv4Address`，在 attachment 中回显 `IPAMConfig: { IPv4Address }`；未请求时保持现有分配且不回显；启动时所请求地址已被该网络其他端点持有则启动失败（与真实 Docker 一致）；覆盖点如上，只作用于启动时的 attach。单元测试（`start.test.ts`/`networks.test.ts`/`transport.test.ts`，经该假 daemon）覆盖：network 模式请求体含 +2、published-loopback 不含；声明 +2 实际 +5 时启动失败、容器与网络被退役、两卷未删、行 `status` 为 `error` 且 `last_error` 恰为 `Platform attachment/startup failed; started container and owned network removed`、有 `instance.start-failed` 审计、未接入平台（请求日志无 `/networks/<id>/connect`），并断言请求日志在 `POST /containers/<id>/start` 之后依次出现 `POST /containers/<id>/stop?t=1`、`DELETE /containers/<id>`、`DELETE /networks/<id>`，证明失败确实经过 `compensateStarted` 而非 `rollbackStartupNetwork`；无声明且地址为 +5 的文档仍通过核对；声明存在但 `IPv4Address` 非法时失败；替换路径复用已有网络且 +2 已被其他端点占用时启动失败（假 daemon 返回 500 `Address already in use`）、占用端点不被断开、复用的网络不被删除、两卷保留、不记录就绪；容器未启动，所以不经 `compensateStarted`（请求日志无 `stop`/`DELETE /containers`），`rollbackStartupNetwork` 因 `containerAttempted=true` 不删网络；创建尝试在启动前已由 `persistCreatedInstance`（`start.ts` 第 420 行，第 429 行 `consumeCreationAttempt` 删除 `creation_attempts` 行）消费，启动失败时 `failedStartup` 的 `started === undefined` 分支不写数据库，所以用例断言：调用以 `Container startup failed during container start` 拒绝；无 `creation_attempts` 行；`instances` 行 `status='starting'`、`container_id=<id>`、`upstream_host`/`upstream_port`/`last_error` 为 NULL；审计只有 `instance.created`，无 `instance.started`/`instance.start-failed`；容器仍存在且 `Running=false`；复用的网络与持有 +2 的端点原样不动。`networks.ts:42` 与 `creation-attempt.ts:52` 的规范 /28 判定改用 `instanceAddressLayout`（行为不变）。Docker：`pnpm test:docker platform/test/container-network-mode.docker.test.ts`（network 模式、stand-in 平台）断言新建容器文档 `NetworkSettings.Networks[dsh-team-net-<user>].IPAMConfig.IPv4Address` 与 `IPAddress` 都等于子网基址+2，并与 `started.upstreamHost` 一致（证明真实 Docker 回显声明、严格分支实际生效）；1.2a 任务文本里写的 `container-network.docker.test.ts` 是 published-loopback 用例，+2 断言在 1.3 补入该文件，PR 描述须说明验收项由 `container-network-mode.docker.test.ts` 满足。Must preserve：DSH 监听仍为 `0.0.0.0`；平台接入不请求地址（1.2b）；无声明文档的核对、退役顺序与仅删空网络的语义不变。
Risk packs (1.2b): selected - Concurrency / shared state（接入决策读 `attachPlatform` 预检那次 inspect 的 bridge，接入后核对是 `inspectPlatformAttachment` 的另一次 inspect，两者只共用捕获的子网；平台重建、替换路径复用网络）、Error handling / rollback（启动路径的平台地址失配走现有 `compensateStarted`：退役容器、断开平台端点、删自有网络、保留两卷、行置 `error`、写 `instance.start-failed`；对账路径的失配明确失败且不破坏任何资源；connect 被 daemon 明确拒绝仍走现有 `PlatformAttachmentFailedError` 退役路径）、Legacy compatibility（阶段 1 存量实例的补接请求体不变、不按布局核对、不停止、不写审计）、Public API（connect 请求体形状）；not selected - Config（无新配置）、File IO、Schema、Auth、Resource limits、Release、Documentation（1.4）。
Evidence (1.2b): 请求：`attachPlatform`（`networks.ts` 第 397 行）只在 `if (!platformMembership(...))` 分支内（第 418 行，即确实要发 connect 时）读取预检 inspect 的 `before.Containers[<container>].IPv4Address`（去掉 `/28`），员工端点缺失时抛 `Owned network endpoint missing`、不发 connect；平台已接入、不发 connect 的路径不新增任何检查；实际地址等于 `instanceAddressLayout(network.subnet).container` 时 connect 请求体为 `{ Container: <platform.id>, EndpointConfig: { IPAMConfig: { IPv4Address: <布局 platform> } } }`，否则（阶段 1 存量实例）请求体保持 `{ Container: <platform.id> }` 不变。判定依据是员工端点的实际地址，不是它有没有声明（design 决定 2：「容器在 +2 的实例才请求 +3 并核对」）。核对：`platformMembership`（`transport.ts` 第 41 行）增加显式参数 `declaration: 'checked' | 'ignored' = 'checked'`，转交给第 62 行的 `validateEndpointAddress`；`'checked'` 且返回的声明非空时，要求声明等于 `instanceAddressLayout(subnet).platform`，否则抛 `Platform endpoint address differs from its layout`；无声明（缺失、null、`{}`）的平台端点只做阶段 1 范围核对，这是存量补接与阶段 1 接入的形态。+4 不在此硬编码（16.3）。七个调用点：`validateUserNetwork`（第 179 行附近）转交自己的 `declaration`，因此 `compensateStarted` 的 `'ignored'` 同时覆盖平台端点；`disconnectPlatform`（第 306 行）与 `removeUserNetwork`（第 359 行）传 `'ignored'`（清理权限只认身份与范围，否则 `compensateStarted` 内的 `removeUserNetwork` 会被吞异常、网络退役不了）；`captureUserNetwork`（第 157 行）也增加显式 `declaration` 参数并转交，`compensateStarted` 在 `start.ts` 第 155 行的那次调用传 `'ignored'`（它在 `'ignored'` 的 `validateUserNetwork` 之前、在吞异常的 try 内，否则失配时 outcome 停在 `compensation failed or unconfirmed`，四步退役一步都不发），其余调用方 `stop.ts` 第 190/266/279 行、`network-reconcile.ts` 第 100 行、`creation-attempt.ts` 第 317 行保持默认 `'checked'`，作为有意的失败即关闭（与现有范围核对在这些路径上的行为一致）；`createUserNetwork` 复用分支（第 238 行）、`inspectPlatformAttachment`（第 393 行，接入后的核对点）、`attachPlatform` 预检（第 418 行）保持 `'checked'`。清理面上的 `'ignored'` 比 1.2a 的单点更宽，PR Risk 一节要写成有意决定。失配路径：启动路径（`startedUpstream` → `attachPlatform` → `inspectPlatformAttachment` 抛错）经 `failedStartup` 进入 `compensateStarted`，断言与 1.2a 失配用例同形：`stop?t=1` → `DELETE /containers/<id>` → `POST /networks/<id>/disconnect`（平台）→ `DELETE /networks/<id>`，行 `error` 且 `last_error` 恰为 `Platform attachment/startup failed; started container and owned network removed`，`instance.start-failed`，两卷保留；对账路径（`restorePlatform`）的布局失配不是 `PlatformAttachmentFailedError`，按现有规则原样抛出：`owner.reconcile()` 以 `Instance reconciliation failed` 拒绝，行保持 `running` 不变、无审计、无 stop/DELETE/disconnect，平台端点不被强制断开（规格「不把不明端点当作可强制断开或删除的对象」）。目标 +3 被占：`ownedEndpoints` 只允许员工容器与平台两个端点，持有 +3 的只能是陌生端点，在所有调用点都于 connect 前以 `Network has unknown endpoints` 失败（现有用例 `transport.test.ts` 的 foreign endpoint 两例必须保持不变）；daemon 对 connect 的明确拒绝走现有 `DockerHttpError` → `PlatformAttachmentFailedError` 路径（启动：补偿；对账：`reconcile.test.ts` 第 559 行的 error/null 退役），不新增用例；假 daemon 的 `connect` 不加占用检查（生产代码不可达，列为非目标）。假 daemon（`platform/test/container-start-fixture.ts`）：`connect`（第 211 行）已把 `body.EndpointConfig` 交给 `attach`，1.2a 起 `attach` 会采用并回显 `IPAMConfig.IPv4Address`，所以 +3 的回显无需改动；把 `startAddresses` 改名为 `actualAddresses`，由 `/start` 处理器和 `connect` 两处作为 `attach` 的 `actual` 参数使用（回显的声明不变），用来制造“平台声明 +3、实际 +5”；`connect` 在 `startupNetworks(containers)` 内而该 map 现定义在 `startupDaemon` 里（第 319 行），需把 map 传进 `startupNetworks`，它按容器 ID 取值，对同一平台在所有网络上的接入都生效。存量实例在单元层用现有方式构造：改写 seeded 网络的 `Containers[<id>].IPv4Address` 与容器 attachment 的 `IPAddress` 为基址+4、不带 `IPAMConfig`（`container-reconcile.integration.test.ts` 第 370-385 行对第二个幸存者已这么做，但它现在在 .16/28 的 .18 即 +2，要改成 .20）。单元用例：(a) `transport.test.ts`：network 模式全新启动，`/networks/<id>/connect` 请求体恰为 `{ Container: PLATFORM, EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.3' } } }`，启动后 bridge `Containers[PLATFORM].IPv4Address === '172.30.0.3/28'`，平台文档 attachment `IPAddress === '172.30.0.3'` 且 `IPAMConfig.IPv4Address === '172.30.0.3'`，`started.upstreamHost` 仍为 `172.30.0.2`；(b) `transport.test.ts`：`actualAddresses` 使平台实际为 `172.30.0.5`，启动拒绝并断言上述补偿序列与行/审计/卷；(c) `container-reconcile.integration.test.ts` 第 357 行用例改为一个布局实例（.0/28 的 .2，保持现有种子 `attachOwnedNetwork` 的无声明形态，即阶段 1 实例恰好在 +2 的多数形态，证明判定依据是实际地址而不是有无声明）加一个存量实例（.16/28 的 .20，无声明）：平台重建后对账，两个 connect 请求体分别带与不带 `EndpointConfig`，布局实例 bridge 上平台端点 `.3/28` 且 attachment 回显 `IPAMConfig`，存量实例的平台端点无 `IPAMConfig`、地址为假 daemon 分配的下一个空闲地址且在 (基址, 基址+15) 内；两行不变、无审计、非 GET 请求只有两个 connect（沿用现有断言）、再次对账无写；(d) 对账层声明失配：布局实例、`actualAddresses` 使重建平台实际为 .5（回显声明 .3），`owner.reconcile()` 拒绝 `Instance reconciliation failed`，行 `running` 不变、无审计、非 GET 只有那一个 connect；daemon 已接受 connect，平台端点留在“声明 .3、实际 .5”，所以再次 `reconcile()` 在 `reconcile.ts` 第 202 行的 `'checked'` 核对处以同样文本再次拒绝、仍无写入，`stopUserContainer` 走 `captureUserNetwork('checked')` 同样失败且不发 stop/disconnect/DELETE——这是该（真实 Docker 不可达的）卡住状态的刻画，用例要把这两步也断言；(d2) 布局判定本身：在 `transport.test.ts` 第 75 行的 it.each 增加 `platformLayout` 变体，测试直接把 bridge `Containers[PLATFORM].IPv4Address` 改为 `172.30.0.4/28`、平台文档 attachment 改为 `IPAddress '172.30.0.4'` 且 `IPAMConfig: { IPv4Address: '172.30.0.4' }`（声明等于实际但不是 +3），复用启动与对账都以 `Platform endpoint address differs from its layout` 失败、无写入无恢复（规格「实际地址与布局不符」）；红先里 (d2) 在改动前通过 `validateDeclaredAddress`（声明等于实际）而不拒绝，所以也作为红项；(e) 现有用例不改语义：`transport.test.ts` 第 62（复用不重接）、184（缺失 membership 退役）、337（退役顺序）行与 foreign endpoint 两例、`reconcile.test.ts` 第 559/596 行、`container-network-mode.integration.test.ts` 的 connect 失败结算用例全部保持通过；现有测试中出现的 `{ Container: … }` connect 请求体都是测试自己的种子调用 `daemon.reply(...)`，模拟阶段 1 的无声明接入，保持原样不改（`network-reconcile.test.ts` 第 45 行、`readiness.test.ts` 第 452/593 行、`container-reconcile.integration.test.ts` 第 402/596/744 行、`container-network-mode.integration.test.ts` 第 382 行）；没有现有断言比较生产代码发出的 connect 请求体，报告写“无”。红先：在未改源码上先写 (a)、(c)、(d2)，(a) 红在 connect 请求体缺 `EndpointConfig`，(c) 红在 .2 实例的 connect 请求体缺 `EndpointConfig`（.20 实例分支在改动前后都不带，天然通过），(d2) 红在未拒绝。Docker：`pnpm test:docker platform/test/container-network-mode.docker.test.ts`（启动路径）新增断言：bridge `Containers[platformId].IPv4Address === <布局 platform>/28`，平台 stand-in 文档 `Networks[dsh-team-net-<user>]` 的 `IPAddress` 与 `IPAMConfig.IPv4Address` 都等于布局 platform；`pnpm test:docker platform/test/container-reconcile.docker.test.ts`：重建前原平台在布局 platform，重建并对账后替换平台在两个幸存者 bridge 上都是布局 platform 且 attachment 回显 `IPAMConfig`（证明真实 Docker 接受 connect 的 `EndpointConfig.IPAMConfig` 并回显）。存量实例（不在 +2）的 Docker 级补接属于 1.2c 的测试自有幸存者用例（同一文件新增），1.2b 在单元层证明该分支；1.2b 任务文本写的 `container-network.docker.test.ts` 是 published-loopback 用例（无平台），+3 断言落在 `container-network-mode.docker.test.ts`，PR 描述与 issue 评论写明这两处映射。Must preserve：存量实例补接不请求地址、接入后不按布局核对、不停止、不写审计；`verifiedPlatform` 的身份校验、端点名称/ID 一致性、退役时先断开平台再删空网络、只删已验证为空的网络不变；1.2a 的员工端点声明/+2 核对与 `'ignored'` 范围不变；DSH 仍监听 `0.0.0.0`；平台地址不落库、不进网关。
Risk packs (1.2c): fixture level compact（偏离 issue 建议的 expanded：本任务只新增一个 Docker 用例，不改 `platform/src/`，是对已合入 1.2a/1.2b 行为的真实 Docker 刻画；理由记于 proposal.md Impact）。selected - Legacy compatibility（所造幸存者必须是阶段 1 形态：员工端点无 `IPAMConfig`、地址不在 +2、带 `u-<id>` 别名、行 `upstream_host` 指向该地址；对账后它保持运行、无审计、可经网关访问）、Error handling（构造若意外落在 +2 则用例明确失败而不是静默退化成布局一类；失败路径下所有自有资源经 `registerResource` 登记可被 lifecycle 清理）；not selected - Concurrency、Public API、Config、File IO、Schema、Auth、Resource limits、Release、Documentation（无生产代码、无接口、无文档变更）。
Evidence (1.2c): 新用例写在 `platform/test/container-reconcile.docker.test.ts`，独立的 scenario 函数经 `runUserImage('container-start', …)` 运行，与现有 `reconciliationScenario` 同形，复用 `createStandInPlatform`、`startupClient`、`inspect`、`inspectNetwork`、`record`、`platformHttpStatus`、`startDockerInstance`（后者需从 `container-start-docker-fixture.ts` 导入）。步骤与断言：(1) stand-in 平台 `dsh-team-test-survivor-<runId>`，network 模式 owner；为用户登记 `dsh-team-u-<user>` 容器、两卷和 `dsh-team-net-<user>` 网络（`registerResource('network', …, { 'dsh-team.user': user })`，使失败路径也能清理）；用 owner 启动并等待就绪，取行与 cookie，用 `exec python3` 在 `/data/work/survivor-marker` 写入标记。(2) 测试自有方式构造阶段 1 幸存者，网络操作走 `startupClient` 的 `raw.json`（Docker CLI 的 `network connect` 即使不带 `--ip` 也会发出一个 `IPAMConfig` 结构，inspect 可能回 `{}`，所以不能用 CLI）：`POST /networks/<netId>/disconnect { Container: <containerId>, Force: false }`；先 `registerResource('container', 'dsh-team-test-placeholder-<runId>', { 'dsh-team.test-run': lifecycle.runId })` 再 `docker run --detach --name dsh-team-test-placeholder-<runId> --network <netId> --label dsh-team.test-run=<runId> <imageId> sleep infinity` 占住当前首个空闲地址（登记必须在 run 之前，`registerAbsent` 要求登记时资源尚不存在）；`POST /networks/<netId>/connect { Container: <containerId>, EndpointConfig: { Aliases: ['u-<user>'] } }` 不带 `IPAMConfig` 键（与阶段 1 创建请求同形，Docker 回报 `IPAMConfig: null`）；`docker rm -f` 占位容器。断言重连后的容器文档：`NetworkSettings.Networks` 只有 `dsh-team-net-<user>`，`NetworkID` 等于 `HostConfig.NetworkMode`，`Aliases` 含 `u-<user>`，`IPAMConfig` 为 null，`IPAddress` 在 (基址, 基址+15) 内且不等于布局 +2（等于 +2 时用例以 `Survivor construction landed on the layout address` 失败，不得继续）；bridge `Containers` 只剩容器与原平台。随后 `UPDATE instances SET upstream_host = <新地址> WHERE user_id = ?`（模拟阶段 1 行），并断言原平台 `platformHttpStatus(…, 新地址, authority, cookie)` 为 200。(3) 记录 `startupEvidence` 快照；`docker container rm --force <原平台>`，`createStandInPlatform` 同名重建（ID 不同）；新 owner `createOrchestrator` 连续 `reconcile()` 两次。断言：`startupEvidence` 不变（行含 `status='running'`、同一 `container_id`、`upstream_host` 为新地址、cookie 不变；审计仍只有 created/started/ready 三条）；容器 ID 不变且 `Running=true`，地址不变；bridge `Containers` 恰为 {容器, 重建平台}；重建平台在该网络上的 attachment `IPAMConfig` 为 null（证明 connect 未带 `EndpointConfig.IPAMConfig`，Docker 层对请求体唯一可观察的证据）、`IPAddress` 在 (基址, 基址+15) 内且不等于容器地址，bridge 端点 `IPv4Address` 为 `<IPAddress>/28`；经重建平台 `platformHttpStatus` 无 cookie 401、带 cookie 200。(4) 用重建后的 owner（步骤 (3) 的 `createOrchestrator`；原 owner 的 `transport.platformId` 已钉在原平台上，`verifiedPlatform` 会抛 `Configured platform identity changed or unavailable`）`stopUserContainer({ userId, reason: 'admin' })`：容器与网络经 `isAbsentResource` 确认不存在，两卷 `docker volume inspect` 仍为 0，审计追加 `instance.stopped {"reason":"admin"}`。(5) 同一重建后 owner `startDockerInstance(…)` 再次启动：新容器 ID 不同，其 attachment `IPAMConfig.IPv4Address` 与 `IPAddress` 都等于布局 +2，重建平台在新 bridge 上为布局 +3 且回显 `IPAMConfig`（1.2a/1.2b 断言在新实例上成立），`exec python3` 读回 `/data/work/survivor-marker` 等于写入文本；最后再 `stopUserContainer admin` 退役，容器与网络不存在、两卷保留。summary JSON 固定字段：`{ survivorAddressOffLayout: true, reattachedUndeclared: true, authenticatedAfterRecreation: 200, auditsUnchanged: true, restartedAtLayout: true, markerRetained: true }`。红先（本机无 Docker，不能本地红）：在 VPS 上先用 exact head 跑完整 lane（custody `test:docker` 全量 + `test:deploy`）取得绿证据，然后在同一 prepared root 里对 `platform/src/orchestrator/networks.ts` 的 `connectRequest` 做变异（无条件返回带 `EndpointConfig.IPAMConfig.IPv4Address = layout.platform` 的请求体），只跑 `pnpm test:docker platform/test/container-reconcile.docker.test.ts`：新用例必须在步骤 (3) 的「重建平台 attachment `IPAMConfig` 为 null」断言失败（变异下平台以声明 +3 接入且 +3 空闲、布局核对通过，只有这条断言能发现），现有用例不受影响；随后 `git checkout -- networks.ts` 恢复并以 `git status` 证明 root 回到 exact head。变异日志与恢复证明贴进 PR。PR 描述写明 issue 的关键路径勾选项（「本 issue 触及关键路径 `platform/src/orchestrator/`」）不适用：diff 不碰 `platform/src/`，VPS 上对 `networks.ts` 的变异是临时的、已用 `git status` 证明恢复。Must preserve：现有 `reconciliationScenario` 用例与其 summary 不变；不改 `platform/src/`；不改共享 Docker fixture 的现有导出语义（如需新助手，加在本测试文件内）；占位容器与所有自有资源都带 `dsh-team.test-run` 标签并登记；不使用 `--ip` 构造幸存者（那会产生声明，1.2a 会按 +2 核对）。
Risk packs (1.3): selected - Error handling / rollback（published-loopback 的地址失配从“没有核对、启动成功”变为与 network 模式相同的补偿：退役容器与自有网络、保留两卷、行置 `error`、写 `instance.start-failed`；退役统一 network 模式的声明网络 fence 与删容器前的端点归属捕获，失配时明确失败、不删容器、不删网络）、Legacy compatibility（阶段 1 的 published-loopback 存量实例无 `IPAMConfig` 声明，继续只做 (基址, 基址+15) 范围核对：对账保持运行、退役照常，退役本身不做布局核对）、Concurrency / shared state（loopback 的 `/start` 改经结算 client 发送，已提交的启动不因调用方取消而丢失补偿身份；退役中容器删除后的网络退役改用自有 signal，与 network 模式一致；名额语义随之改变：loopback 下启动后失败的实例经补偿置 `error`，不再占运行名额，与 network 模式一致，`orchestrator-capacity.test.ts` 的对应用例按新语义改写）、Public API（loopback 创建请求体形状：增加 `IPAMConfig`）；not selected - Config（无新配置）、File IO、Schema、Auth、Resource limits、Release、Documentation（1.4 / #386 负责 AGENTS.md）。
Evidence (1.3): 不变量：两种模式的员工容器都在创建时声明 +2 并在启动后第一次核对时验证；失配都走同一补偿（退役容器与自有网络、保留两卷、行置 `error`、写 `instance.start-failed`）；退役都用同一套声明网络 fence 和删容器前的端点归属核对，退役本身不做布局核对；无声明的阶段 1 存量实例只做范围核对。现状：published-loopback 已经由 `createUserNetwork`（`start.ts` 第 565 行，两种模式无条件调用）建自有带标签 /28 bridge，并由 `stop.ts` 第 289 行的 `removeUserNetwork` 删除空网络（`container-network.docker.test.ts` 的 `network()` 与 `container-network.integration.test.ts` 已断言）；1.3 不新增网络创建代码，差异只在四处 `platform/src/orchestrator/` 的模式守卫。(i) `start.ts` 第 403-405 行 `createInstance` 的 `NetworkingConfig.EndpointsConfig[<network.id>]` 去掉 `upstreamMode === 'network'` 条件，两种模式都带 `IPAMConfig: { IPv4Address: instanceAddressLayout(network.subnet).container }`；第 390-392 行回环 `PortBindings` 不变。布局核对复用 `validateUserNetwork` 的声明分支，钉在 `startedUpstream` 第 229 行（两种模式都跑；`verifiedPlatform` 对 loopback 返回 undefined，平台核对自然跳过），失配文本仍是 `Endpoint address differs from its declaration` / `Instance address differs from its layout`。(ii) `start.ts` 第 291-299 行 `launchInstance` 删除 `networkMode`：`/start` 一律经 `cleanup`（结算 client），`confirmed` 一律按 `inspectUserContainerState` 判定。改动前 loopback 的 `confirmed` 恒为 undefined，一旦启动后核对失败会留下运行中的容器和 upstream 为 NULL 的 `starting` 行（`rollbackStartupNetwork` 因 `containerAttempted` 直接返回）；改动后 loopback 失配走 `failedStartup` → `compensateStarted`，其每一步与模式无关（`captureUserNetwork('ignored')` 无平台、`requireUnpublished` 对 loopback 直接返回、`stop?t=1`、`stoppedNetwork`、`DELETE /containers/<id>`、`removeUserNetwork` 无平台端点只删空网络），序列比 network 模式少一个平台 disconnect。这是有意的行为变更，三个现有 loopback 用例因此改写（逐个手算）：`container-start.integration.test.ts` 第 481-523 行 `instance.started` 分支——`start persistence` 失败后补偿：拒绝消息含 `start persistence` 且以 `started container and owned network removed` 结尾，行 `error`、`last_error` 恰为 `Platform attachment/startup failed; started container and owned network removed`、upstream NULL，审计为 `instance.created` + `instance.start-failed`，`/start` 之后非 GET 恰为 `stop?t=1` → `DELETE /containers/<id>` → `DELETE /networks/<START_NETWORK>`，容器与网络不存在，无 `/volumes/` DELETE（`instance.created` 分支不变，结尾处“容器仍在”的共用断言要按分支拆开）；同文件第 525-568 行 `'wildcard endpoint'` 分支——容器已确认运行、随后 `upstreamPort` 拒绝通配发布，进入补偿（loopback 的 `requireUnpublished` 直接返回，通配发布的容器会被删除）：行 `error` 与上面同文本、审计 created + start-failed、容器与网络不存在；`'start failure'`（`/start` 500，未确认）、`'foreign owner'`/`'wrong identity'`（`inspectUserContainerState` 抛错，未赋值 confirmed）、`'not running'`（返回 false）四例保持 `starting` 行与仅 created 审计不变；`orchestrator-capacity.test.ts` 第 150-170 行 “failed indexed start remains counted after owner reconstruction” 改写为“failed indexed start compensates to error and releases admission after owner reconstruction”：`start persistence` 失败后 START_USER 行为 `error`，重建的 owner 给 OTHER_USER 返回 `{ outcome: 'starting', containerId: START_CONTAINER, upstreamHost: '127.0.0.1', upstreamPort: 49173 }`（原容器已被补偿删除，假 daemon 的下一个 ID 仍是 START_CONTAINER；或先 `setContainerId(NEXT_CONTAINER)` 并断言 NEXT_CONTAINER），START_USER 行与补偿后的快照相等，这与同文件第 171-196 行“`error` 不占名额”一致；`platform/src/admin/instance-actions.test.ts` 第 374-405 行 bulk 用例——trigger 在 `instance.created` 后把行置 `error`，`start persistence` 的 `WHERE status='starting'` 更新 0 行而失败，现在补偿把 `last_error` 覆写为 `Platform attachment/startup failed; started container and owned network removed`（响应 items 与 restart 审计不变，只改第 402 行的期望）。(iii) `stop.ts` 四处 `upstreamMode === 'network'` 守卫删除：第 74 行 `select` 的端点一律 `indexedEndpoint(object(row), true, input.transport.config.upstreamMode)`（loopback 校验 host 恰为 `127.0.0.1`、端口合法）；第 135 行 `running` 的声明网络 fence 两种模式生效（运行中容器：`inspectUserContainerEndpoint` 后以 `HostConfig.NetworkMode` 为 declared、host/port 与行比对；已停容器：`stoppedNetwork`；两次观察不一致抛 `Declared instance network changed during retirement`）；第 189 行 `remove` 删容器前的 `captureUserNetwork(…, container, declaredNetworkId)` 两种模式生效；第 276 行容器删除后 `networkSignal = work.signal` 两种模式生效。退役不做布局核对（`captureUserNetwork`/`removeUserNetwork` 只认身份、范围与端点归属），阶段 1 的 loopback 存量实例照常停止。(iv) 不改：`reconcile.ts` 第 221 行 `restorePlatform` 仍仅 network 模式；`creation-attempt.ts` 第 189-204 行 loopback 发布校验；`readiness.ts`、`credentials.ts`、`start-identity.ts`、`networks.ts`、`transport.ts`；假 daemon（`attach` 已在两种模式回显声明，`actualAddresses` 对 loopback 的 `/start` 同样生效；唯一允许的改动是 `attachOwnedNetwork` 对 `/networks/create` 回复不是 201 时抛 `Fixture user network creation failed`，避免同一用户重复播种时 409 让容器悄悄落到默认 bridge）；`AGENTS.md` 第 188 行文字归 1.4。必须改的现有种子（统一退役后 `running()` 要求容器有 `HostConfig.NetworkMode`、canonical 网络 attachment 和恰一个 `3080/tcp` → `127.0.0.1` 绑定）：每个手写的、会被退役的 loopback 运行中容器改为 `NetworkSettings.Ports = { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '<行里的端口>' }] }` 并调用共享的 `daemon.attachOwnedNetwork(user, id)`（建 `dsh-team-net-<user>` /28 于 START_NETWORK、无声明接入，即阶段 1 形态）：`stop.test.ts` `indexedFixture`（第 41-60 行）、`container-stop.integration.test.ts` beforeEach 种子（第 59-66 行；第 193 行的同名异 ID 容器是陌生容器，不接网络）、`instance-idle.integration.test.ts` 第 111-118 行、`account-status-fixture.ts` `seedRunning`（第 65-80 行，供 `admin-account-status` / `admin-instance-restart` / `admin-instance-restart-lifecycle` 集成测试与 `platform/src/admin/instance-actions.test.ts`、`platform/src/admin/account-status.test.ts` 的禁用与重启退役；它们对 requests 的相等断言都在拒绝或幂等重放路径上，逐个核对）；已接网络的 `instance-idle-fixture.ts`、`container-reconcile-fixture.ts`、`dsh-cookie.integration.test.ts`、`credentials.test.ts`、`readiness.test.ts` 不动。模拟容器消失的 `daemon.containers.delete(id)` 改为 `daemon.removeContainer(id)`（同时移除端点，否则留下的端点让 `ownedEndpoints` 以 `Network has unknown endpoints` 拒绝）：`stop.test.ts` 第 194/234/271 行、`container-stop.integration.test.ts` 第 191/432 行。写序列断言：每次完成的退役（含精确 ID 已不存在的退役）末尾追加 `DELETE /networks/<START_NETWORK>`，拒绝路径的 `writes()` 仍为 `[]`——`container-stop.integration.test.ts` 第 133-136、204、217-219 行，第 440 行附近 `writes().every(path 含 START_CONTAINER)` 改为允许 `/networks/<START_NETWORK>`，第 301-302 行 `deleted` 的 `toHaveLength(1)` 改为 2（DELETE 容器加 DELETE 网络，重试后仍相等）；`instance-idle.integration.test.ts` 第 141-144 行；逐例手算，不照抄观察值。回显断言：`container-network.integration.test.ts` 第 34-41 行 strict `Networks` 加 `IPAMConfig: { IPv4Address: '172.30.0.2' }`，第 63-66 行创建请求体 `toMatchObject` 加同样的 `IPAMConfig`。新增单元用例：(a) `start.test.ts` 第 602 行用例改为两种模式都声明：loopback 创建请求体的 `EndpointsConfig[START_NETWORK]` 恰为 `{ Aliases: ['u-<user>'], IPAMConfig: { IPv4Address: '172.30.0.2' } }`，`HostConfig.PortBindings` 仍为 `{ '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }`；(b) `start.test.ts` loopback 失配：`daemon.actualAddresses.set(START_CONTAINER, '172.30.0.5')`，默认 loopback owner 启动拒绝且消息以 `started container and owned network removed` 结尾，行 `error`、`last_error` 恰为 `Platform attachment/startup failed; started container and owned network removed`、审计含 `instance.start-failed`，`/start` 之后的非 GET 恰为 `POST …/stop?t=1` → `DELETE /containers/<id>` → `DELETE /networks/<START_NETWORK>`，无 connect/disconnect、无 `/volumes/` DELETE，容器与网络在假 daemon 中不存在；(c) `stop.test.ts` loopback 声明网络 fence：真实形态种子后把容器改成已停且已脱网但声明指向别处——`State.Running = false`、`NetworkSettings.Networks = {}`、`HostConfig.NetworkMode = 'f'.repeat(64)`（canonical 网络 START_NETWORK 仍在）；`running()` 走 `stoppedNetwork` 得到 declared `'f'.repeat(64)`，随后 `captureUserNetwork(…, expected)` 在 `inspectedNetwork` 以 `Docker network ownership mismatch` 拒绝；断言 `stopUserContainer` 拒绝 `User container retirement failed`、`expectIndexPreserved`、容器仍在 daemon 中、非 GET 请求为 `[]`、`daemon.networks.has(START_NETWORK)`；(c3) `stop.test.ts` loopback 运行中分支：真实形态种子、`State.Running` 保持 true，只把 `HostConfig.NetworkMode` 改为 `'f'.repeat(64)`（attachment 的 `NetworkID` 仍是 START_NETWORK）；改动后 `running()` 的 `inspectUserContainerEndpoint` → `attachedNetwork` 以 `Instance declared network identity mismatch` 拒绝：`stopUserContainer` 拒绝 `User container retirement failed`、`expectIndexPreserved`、容器仍在且 Running、非 GET 请求为 `[]`、网络仍在（改动前 loopback 退役不读容器 attachment，`stop.ts` 第 135 行守卫跳过 running 分支，第 266 行 capture 也不读它）；(c2) `stop.test.ts` 删容器前的归属捕获：`beforeRequest` 在 `POST …/stop?t=1` 时向 `daemon.networks.get(START_NETWORK).Containers['9'.repeat(64)]` 加一个 `Name: 'foreign'` 端点，退役拒绝，容器仍在 daemon 中且 `State.Running === false`、未被 DELETE，行保持 `running`、无审计，网络仍在；(d) `container-start.integration.test.ts` loopback `/start` 取消（network 模式的对应证据是 `container-network-mode.integration.test.ts` 第 67 行）：`createBarrier = { …, path: '/containers/<START_CONTAINER>/start' }` hold 住 `/start` 的回复，调用方在 hold 期间 `abort()`，然后 release；改动后 `/start` 经结算 client 不被取消，确认运行后调用方 signal 在 `startedUpstream` 处生效，进入补偿：拒绝消息以 `started container and owned network removed` 结尾，行 `error` 与上面同文本，审计 created + start-failed，容器与网络不存在，无 `/volumes/` DELETE；(e) 现有 loopback 退役用例在真实形态种子下语义不变（第 136/192/210/268/279/344/363/391 行等）。红先（在未改源码上先做种子转换并写 (a)(b)(c)(c2) 与回显断言）：(a) 红在 loopback 请求体缺 `IPAMConfig`；(b) 红在启动以 `{ outcome: 'starting', upstreamHost: '127.0.0.1', upstreamPort: 49173 }` 成功（无声明即无布局核对）；(c) 红在退役成功（改动前 loopback 对已停容器不读声明网络，直接 DELETE 容器并删网络）；(c2) 红在容器已被 DELETE（改动前退役仍失败，但失败发生在删容器之后的 `removeUserNetwork`）；(c3) 红在退役成功；(d) 红在拒绝消息为 `Container startup failed during container start`（调用方 signal 中断了 `/start` 请求本身）、行仍 `starting`、容器留在 daemon 中；三个改写的现有用例红在旧期望（`starting` 行 / `full`）；回显断言红在 strict `Networks` 缺 `IPAMConfig`；种子转换与写序列更新在改动前就应通过。Docker：`pnpm test:docker platform/test/container-network.docker.test.ts`（published-loopback 用例所在文件；任务行原写的 `container-network-mode.docker.test.ts` 是 network 模式 stand-in 用例，本任务把任务行改正）在 `network()` 里加：`endpoint.IPAddress === instanceAddressLayout(subnet).container`、`record(endpoint.IPAMConfig).IPv4Address` 同值、`Containers[id].IPv4Address === <+2>/28`；在 `start()` 里加：`HostConfig.PublishAllPorts !== true`、`HostConfig.PortBindings` 恰为 `{ '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }`、`NetworkSettings.Ports` 恰为 `{ '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(result.upstreamPort) }] }`；summary 增加 `atLayout: true, loopbackOnly: true`；自有带标签 bridge、/28、仅本容器一个端点、退役后网络不存在、两卷保留沿用现有断言。Docker 红先：exact-head 全量 lane 绿后，在同一 prepared root 上把 `createInstance` 的 `IPAMConfig` 变异回仅 network 模式（1.2a 形态）运行该文件，预期在 `IPAMConfig` 回显断言处失败（真实 Docker 对未声明端点回报 `IPAMConfig: null`），现有 network 模式用例不受影响，随后恢复并证明 `git status` 为空。Must-preserve：network 模式字节级不变（`transport.test.ts`、`reconcile.test.ts`、`container-network-mode.*`、`container-reconcile.*` 全部原样通过）；loopback 启动取消用例（helper wait 处 abort）不变；`instance-idle-fixture.ts` 的已接网络种子不变。PR 写明触及关键路径 `platform/src/orchestrator/`，人工逐行白盒评审延至 Epic #380 收尾。
Risk packs (1.4): fixture level compact（偏离 issue 建议的 expanded：本任务只改 `AGENTS.md` Environment 两段文字，不改代码或测试；理由记于 proposal.md Impact）。selected - Documentation（文字必须与已合入的 1.1–1.3 行为逐句对应，不描述尚未实现的功能为现状）；not selected - Concurrency、Error handling、Legacy compatibility、Public API、Config、File IO、Schema、Auth、Resource limits、Release（无代码变更）。
Evidence (1.4): 只改 `AGENTS.md` Environment 的两段：(1) `PLATFORM_UPSTREAM_MODE` 段末尾追加固定布局说明——实例 bridge 是对齐的 /28，`instanceAddressLayout` 给出 base+1 网关、base+2 员工容器、base+3 平台、base+4 预留给 Document Server；创建时经 `IPAMConfig` 声明 base+2，启动后第一次核对验证，失配走已启动容器的补偿（删容器与自有 bridge、保留两卷、行 `error`、`instance.start-failed`）；平台只在员工端点位于 base+2 时请求 base+3，有声明的平台地址必须等于 base+3；阶段 1 存量实例无 `IPAMConfig`，只做 (base, base+15) 范围核对，保持运行直到空闲/管理员/账号禁用退役，下次启动按布局创建；平台重建后容器在 base+2 的幸存者请求 base+3 并按声明核对，不在 base+2 的按无地址方式补接且不按布局核对（`connectRequest` 只看实际地址）。(2) `published-loopback` 段改写——建同样的带标签 /28 bridge 并以相同核对与补偿把员工容器声明在 base+2，再把 3080 发布到 127.0.0.1 随机端口，不接入平台与 Document Server，因此该模式下由后续各组交付的知识库代理与 Office 编辑按设计不可用（design 决定 2）；退役在两种模式下用同一套声明 bridge fence、删容器前端点归属捕获与空 bridge 删除；其余句子（不满足部署无宿主端口要求、配置字段在对账/监听前校验、生命周期用 owner 捕获的 transport）保持。每句话都对应 1.1–1.3 已合入的代码：`subnet.ts` `instanceAddressLayout`、`start.ts` `createInstance`/`launchInstance`/`compensateStarted`、`networks.ts` `connectRequest`/`validateUserNetwork`、`transport.ts` `platformMembership`/`validateEndpointAddress`、`stop.ts` `running`/`remove`、`reconcile.ts` `restorePlatform`；不写 Office/知识库的具体端点或配置（第 10/16 组）。不改 `docs/DEPLOY.md`、`.env.example`（现有句子仍正确）。验证：`pnpm lint:agents`、`pnpm fmt:check`、`pnpm check` exit 0；giap-vps exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且清理已确认（文档 PR 仍按任务行要求跑）。审核：一席只读 reviewer 逐句对照代码核实文字准确性。PR 的关键路径勾选项不适用（diff 不碰 `platform/src/`）。

## 2. 撤回 #375 的插件页补丁（DSH 0.2.0 上的预备组）

依赖：无。关键路径 `images/dsh-user/`。

- [x] 2.1 删除 `images/dsh-user/patch-plugin-manager.mjs`、Dockerfile 里对应的步骤，以及 `platform/test/plugin-manager-patch.integration.test.ts`。用户镜像的 Docker 用例改为断言：插件管理器的 `client.js` 是发行原样的哈希，插件页可以看到添加和卸载入口。验证：`pnpm test:docker` 中用户镜像用例和首次使用插件页的浏览器用例通过，并有截图。
- [x] 2.2 覆盖层不再移除 `@deepseek-ai/dsh-plugin-manager/tools`。`registryProbeEnabled: false` 和联网工具的去除保持不变，等第 11 组接上后台开关时再改。验证：生成器单元测试断言输出中没有 `plugin_manager` 的移除项、仓库探测仍为 false；`platform/test/managed-policy.docker.test.ts` 中 Agent 可用的工具包含插件管理工具。
- [x] 2.3 更新 AGENTS.md 中用户镜像补丁的段落和相关部署文档，删掉已撤回的说明。验证：`pnpm lint:agents` 通过；文档中搜不到 `patch-plugin-manager`。

Suggested fixture level: compact - 删除一个补丁、放开一项受管移除，不新增运行时组件
Minimal mergeable slice: 2.1 镜像侧删除补丁单独合入（覆盖层仍移除插件管理工具，插件页入口恢复，测试保持绿）
Risk packs (2.1): selected - Release / packaging（删除一个 BuildKit 绑定挂载的构建步骤与脚本，镜像层不变、`client.js` 回到发行原样）、Documentation（只改测试内注释与 probe 的说明，AGENTS.md/部署文档由 2.3 负责，列为非目标）；not selected - Public API、Config、File IO、Schema、Auth（受管覆盖层仍移除 `plugin_manager` 工具、仍钉 `registryProbeEnabled:false`，属 2.2）、Concurrency、Resource limits、Legacy compatibility（旧镜像不再构建）、Error handling（被删的是补丁自身的拒绝路径，随脚本与其集成测试一并删除，不保留等价物）。
Evidence (2.1): 删除 `images/dsh-user/patch-plugin-manager.mjs`、Dockerfile 中 `RUN --mount=type=bind,source=patch-plugin-manager.mjs …` 一步及其注释、`platform/test/plugin-manager-patch.integration.test.ts`。`platform/test/user-image.docker.test.ts` 的插件页用例改为断言 `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` 的 SHA-256 等于发行原样 `bf25686c575d598b91a5dec43cc725d9c1066c801555ce06e6f12f0f72e94f77`（即被删脚本的 `INPUT_SHA256`）、仍为 root 所有且 uid1001 不可写、`/tmp/patch-plugin-manager.mjs` 不存在、全局恰有一份该包。浏览器证据 `scripts/probe-plugin-page.mjs` 的 `verifyPluginPage` 改为要求列表页有「添加插件」按钮（计数 ≥1）、详情页有「卸载」按钮（计数 ≥1），开关来回切换与截图数量不变；`platform/test/probe-plugin-page.integration.test.ts` 先红后绿：无按钮的页面现在失败（`error=add-plugin`/`error=uninstall` 的反向），有按钮的页面通过；`platform/test/first-use.docker.test.ts` 的 `expectPluginPage` 与结果字段（`pluginPageWithoutInstallEntries` 改名为表达“入口存在”的字段）同步。`pnpm test:docker` 中用户镜像用例与首次使用插件页用例通过且保留截图。Must preserve：镜像其余步骤与 profile 种子不变；覆盖层仍移除 `plugin_manager` 工具并钉 `registryProbeEnabled:false`（2.2 再改）；`managed-policy-oracle` 对 `plugin_manager` 的期望不变。
Risk packs (2.2): selected - Auth / permissions（实例内 Agent 重新获得 `plugin_manager` 工具是权限面的变化，由设计决定 12/D9 修订授权）、Legacy compatibility（`@deepseek-ai/dsh-tool-web` 的移除、`ui-plugin-manager` 行钉死的 `registryProbeEnabled: false`、员工自定义预设的保留校验、oracle 的其余控制检查全部不变）；not selected - Config、Schema、Public API、File IO、Error handling、Concurrency、Resource limits、Release（镜像不变）、Documentation（AGENTS.md 与部署文档归 2.3/#389）。
Evidence (2.2): 生成器——`platform/src/managed-config/generate.ts` 的 `REMOVED_TOOLS` 只保留 `@deepseek-ai/dsh-tool-web`；`filterPlugins`/`transformPreset` 与其余行逐字不变（只按包名删行，不碰 `disabled` 等字段）；`ui-plugin-manager` 行仍写 `registryProbeEnabled: false`（第 11 组再改）。`generate.test.ts`：`EXPECTED_NETWORK_POLICY_ROWS` 恢复输入里的 `renamed-plugins`、`nested-plugins`（含其 `disabled: false`）与 `tool-plugin-manager` 行并保持原位置与原形状，`@deepseek-ai/dsh-tool-web` 行（含嵌套与改名行）仍被移除，`persona.config.lookalike` 里的同名 JSON 仍保留；用例名改为只说联网工具；现有 `ui-plugin-manager` 行断言（`registryProbeEnabled: false`，员工重开探测被覆盖）不变；该用例在改 `REMOVED_TOOLS` 前必须红（期望行里多出插件管理工具项）。oracle——`platform/test/managed-policy-oracle.ts` 的 `assertManagedPolicyRuntime` 不再把 `plugin_manager` 当作禁止工具（`NETWORK_TOOLS` 仍禁止）。`RETAINED_TOOLS` 只给 `cordis` 加 `plugin_manager`：按精确 tag `git show dsh-v0.2.0-rc.2:packages/bundle/web-app/presets/cordis.patch.yml`（:152-154）该行是 `disabled: !!js "!ctx.get('profileContext')"`，在有 profile 的 web 实例里启用；`standard`（`standard.patch.yml:144-146`）与 `ptc`（`ptc.patch.yml:150-152`）的该行是 `disabled: true`（上游 `packages/boot/plugin-manager/README.md:31`：仅 Creator 模式启用），2.2 只停止删行、不改 `disabled`，所以它们不加；`minimal` 与仓库自有的 office 预设没有该行，不加。VPS 若观察到 `cordis` 没有 `plugin_manager`，那是要诊断的失败，不是改期望的理由。主要 VPS 证据是员工自定义预设：`platform/test/managed-policy-employee-edit.ts:65` 的 `renamed-plugins` 行没有 `disabled`，经生成器原样通过，所以 `managed-policy-fixture.ts` 的 `RESTART_EXPECTED.retainedTools[CUSTOM_PRESET_ID]` 改为 `['read','present','plugin_manager']`；`customPresetFailure` 的 `custom-plugin-manager` 控制分支（无覆盖层的对照运行）不变。`managed-policy-oracle.integration.test.ts`：原「forbidden plugin manager tool」与「plugin manager beside required tools」两条拒绝用例改为三条各自传入字面 `retainedTools` 的用例——`cordis` 含 `['bash','read','plugin_manager']` 且期望要求它时接受（改 oracle 前必须红：旧 oracle 把它当禁止工具）、`cordis` 为 `['bash','read']` 而期望 `{ cordis: ['bash','read','plugin_manager'] }` 时拒绝（改前即绿）、`office` 侧出现 `plugin_manager` 且期望不要求时接受（office 预设不要求也不禁止）；表格共享期望（:71-75）保持 `['bash','read']`，使 `web_search` 行仍是单一原因的拒绝；其余用例与 `platform/test/managed-policy.integration.test.ts` 不变（均为本地字面期望，不引用 `RETAINED_TOOLS`）。Docker（VPS）——`managed-policy.docker.test.ts` 经 `managed-policy-fixture.ts:674` 的 `assertManagedPolicyRuntime(started.observation, expected)` 证明 `cordis` 实际工具含 `plugin_manager`（发行预设证据）、重启后的员工自定义预设含 `plugin_manager`（生成器证据）、`pluginPage.registryProbeEnabled` 仍为 false；用例不新建流程。证据门：`pnpm check`；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 在 giap-vps 通过且 cleanup confirmed。偏离与上报：规格场景「员工在默认预设下…实际生效的预设工具里有 `plugin_manager`」（`specs/managed-config/spec.md:50-53`）在 2.2 内不满足——默认预设是 `office-general`（`plugins/office-agents/cordis.patch.yml:3`），没有插件管理工具行，而上游只在 Creator 模式启用；给 office 预设加行要改 `plugins/`，超出本 issue 边界。该场景标记为延后，由编排方上报用户决定：后续组给 office 预设加该行，或改规格措辞；本 PR 不得声称已覆盖。Docker 检查证明的是工具 schema 已注册，不证明「Agent 能执行该操作」。PR 措辞：`images/dsh-user/` 自 #387 后只剩 `Dockerfile` 与 `workspace.json`，2.2 不改任何关键路径文件，issue 里继承自父 issue 的关键路径勾选项不适用，PR 描述明说；`docs/DEPLOY.md:55` 仍写「受管覆盖层去掉 Agent 的插件管理工具」，归 #389。Must preserve：`@deepseek-ai/dsh-tool-web` 的移除（含嵌套组与改名行）、`registryProbeEnabled: false` 钉死、`REMOVED_TOOLS` 按包名匹配的注释语义、`generate.ts` 其余行、oracle 对 `web_search`/`web_fetch` 的禁止与 `controlEmployeePolicyFailure` 全部分支、`managed-policy.docker.test.ts` 的其他断言、`managed-policy-employee-edit.ts` 输入不变；AGENTS.md/docs 不动（#389）；镜像与 `plugins/` 不动。
Risk packs (2.3): selected - Documentation（AGENTS.md、CONTEXT.md 与 docs/DEPLOY.md 的描述必须与 #387（补丁已删）和 #388（覆盖层不再删插件管理工具）合入后的真实状态一致）；not selected - 其余全部（无代码、配置、镜像、测试改动）。本 PR 不改 `images/dsh-user/` 下任何文件（#387 后该目录只剩 `Dockerfile` 和 `workspace.json`），issue 从父 issue 继承的「触及关键路径、需人工逐行审查」勾选项不适用，PR 描述里明说；AGENTS.md 属规则文件，其人工审查按阶段 1 对 #24/#25 的惯例推迟到 Epic #380 收尾，PR 描述同样写明。
Evidence (2.3): 改动点三处。AGENTS.md:295 的用户镜像段落：删去「As root, a BuildKit bind-mounted … prove the real result.」整句，改为一句不含任何补丁脚本文件名的现状陈述：插件管理器的 `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` 保持发行原样（用户镜像用例断言发行哈希、root 所有、uid1001 不可写、全局恰一份、已撤回的构建期补丁脚本不在镜像内），首次使用的插件页浏览器用例断言列表页有「添加插件」、详情页有「卸载」入口（`pluginPageWithInstallEntries`）；段落其余句子（named contexts、`dsh --version`、离线 DOCX、Python 前置）逐字不变。CONTEXT.md:24 用户镜像行的「不修改 DSH 源码」括注：删去 `@deepseek-ai/dsh-client-ui-plugin-manager` 安装、卸载入口那半句，只保留 `dsh-better-sidebar`（阶段二，尚未进入生产镜像）半句和「版本不符即构建失败」。docs/DEPLOY.md:55 段落改写为现状：插件页保留 DSH 原生的添加、更新、卸载入口；受管覆盖层不再去掉 Agent 的插件管理工具，但目前仍关闭插件页的公共仓库探测（`registryProbeEnabled: false`，第 11 组接后台开关后改为管理员配置）；升级前员工自行安装的 bundle 保留，可关闭或卸载；管理员重置该员工 DSH 设置可恢复镜像 profile 初始副本；员工仍可在终端 `dsh plugin add`，按 D9/F46 2026-10-28 修订这是允许的行为，不再写成「已接受的残留」。验证：`pnpm lint:agents` 通过；`git grep -n patch-plugin-manager -- AGENTS.md CONTEXT.md docs platform/AGENTS.md README.md images plugins scripts` 无结果（`platform/test/user-image.docker.test.ts:146` 的 `/tmp/patch-plugin-manager.mjs` 断言是测试代码、`openspec/changes/**` 是历史任务文本，都不在范围内）；`git grep -n dsh-client-ui-plugin-manager -- CONTEXT.md` 无结果；`pnpm check` 通过；exact-head VPS `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed（CI 证据门要求；无行为改动）。Must preserve：AGENTS.md 其余段落与验证矩阵、CONTEXT.md 其余行、`docs/DEPLOY.md` 其余章节、`platform/AGENTS.md` 不动；不改代码、测试、镜像、openspec 规格。

## 3. 权限档覆盖 continuable 子会话（DSH 0.2.0 上的预备组）

依赖：无。

- [x] 3.1 `plugins/permission-tiers` 的 client 和 host 两半，对 continuable 子会话套用与根会话相同的档位判定。子会话继承父会话的档位；恢复时保留子会话自己的档位，不重新继承。验证：成对单元测试覆盖 one-shot 和 continuable 两种子会话在三个档位下的判定，以及恢复时的档位。
- [x] 3.2 Docker 浏览器用例：用测试自有的 `backgroundMode: continuable` 组合产生 continuable 子会话，验证人工批准档下拒绝、允许、取消三条路径的文件效果和原生审计身份，以及 Auto、Yolo 档的行为；阶段 1 的 one-shot 用例保持不变。验证：`pnpm test:docker platform/test/permission-tiers.docker.test.ts` 通过，截图保存在 `.run/` 下。
- [x] 3.3 更新 `plugins/permission-tiers/README.md` 中子会话的语义。验证：README 描述与 3.1 的测试一致。

Suggested fixture level: expanded - 权限边界，影响每个子 Agent 的批准行为
Minimal mergeable slice: 3.1 插件判定和成对单元测试单独合入（现有 Docker 用例保持绿，continuable 的浏览器证据随后补上）
Risk packs (3.1): selected - Auth / permissions（子会话的档位继承是权限边界；批准面板选择保持原样，continuable 子会话留给原生 priority 1 面板）、Legacy compatibility（one-shot 子会话与根会话的三条路径、client composer 选择器不变、现有 Docker 浏览器用例语义不变）、Error handling（父会话无档位或子会话无记录时仍 fail closed 抛 `UNAVAILABLE`）；not selected - Public API（插件无对外接口）、Config、File IO、Schema、Concurrency（现有 revision/guard 机制不改）、Resource limits、Release（镜像内插件文件由现有 Docker 用例覆盖）、Documentation（README 归 3.3）。
Evidence (3.1): **client 半区不改代码。** 发行版 0.2.0-rc.2 的 composer 链（`resource/deepseek-harness` `packages/client/ui-subagent/src/client/index.ts` `selectReadOnlySubagent`）只对 `one-shot`/`unknown` 以及“父会话不可用且未运行”的 continuable 子会话占用只读席位；父会话可用的 continuable 子会话返回 null，于是原生 `ApprovalPanel`（priority 1，`ui-approval/src/client/index.ts`）在子会话自己的 Session 里展示并回答批准请求，与根会话完全相同。仓库面板 `selectChildApproval`（priority -20）只因 one-shot 只读席位（-10）挡住原生面板才存在；若把它扩到 continuable，会用精简面板替换原生面板，违反设计决定 10“阶段 1 语义保持不变”和 README 第 43 行。所以 `client.js` 不变，`client.test.js` 拒绝表中的 `owner(pending, 'continuable')` 保留为有意拒绝（把原生 priority 1 留给 continuable），用例名或注释写明理由。规范句“子会话的批准请求 MUST 归属子会话本身”已由 host 满足：每个子会话自己的 `approval/request` 瀑布在子会话里发起请求，原生面板在那里显示，不以此为由改选择器。**host 半区**：`index.js` 的 `initializeChild` 只依据 `header.origin`、`header.parentSession` 与 permissions 投影判定，从不读取 `subagent/descriptor` 事件里的模式（host 的 `Session` 类型没有 `subagent.address.mode`，上游称 `origin` 为展示元数据）；上游事实：原生 `applyChildComposition` 对每个进程内子 Agent 在新建与冷恢复时都运行（`child-agent.ts`），continuable 路径新建走 `agents.create`、续用走 `agents.resume`（`continuation-activation.ts`），所以 `startup` 只发生一次、resume 从不再继承；原生只在新建时追加委派的 `approval/policy: never`，插件的追加在其后。若实现发现任何按模式分支的判定，改为模式无关；预期 `index.js` 无行为改动或只有等价整理。`index.test.js` 新增成对用例（one-shot/continuable 只是测试参数化的标签，host 不读取它）：假 `ctx` 须改为 `stateOf` 按 Session 返回各自的 permissions 投影（子会话的投影由它自己追加的事件构成）、`agents.get` 按 ID 区分父与子；观察：三档下 startup 追加的 `permission/preset`/`sandbox/mode`/`approval/policy` 与父档位一致（danger 为 `never`，其余 `ask`）；父会话切换档位后 resume 子会话既不追加也不抛错，子会话仍按自己记录的档位；`tools/pre-execute` 以 `exec.agent = child` 时按子会话档位判定（approval 档交由下游批准、auto-review 经 review、danger 直接允许）；父会话无档位时 startup 抛 `UNAVAILABLE`，子会话无记录时 resume 抛 `UNAVAILABLE`。假设（由 3.2 的浏览器证据证明，本 issue 只记录）：安装的 npm 发行版对 continuable 子会话暴露 `subagent.address.mode === 'continuable'` 且等待批准时 `running === true`，原生面板在子会话内回答；父会话不可用且未运行的 continuable 子会话被只读席位占用的情形留给 3.2。Must preserve：根会话判定、one-shot 路径、`-20` 优先级与 `conversation.composer` 注册、`client.types.d.ts`、`permission-browser-fixture.mjs` 的现有 Docker 浏览器用例（本 issue 不改）；README 归 3.3；插件单元测试覆盖率阈值不变。
Risk packs (3.2): selected - Auth / permissions（continuable 子会话在真实发行版里是否真的在第一个回合前继承父档位、批准是否归子会话本身并由原生面板作答、恢复后是否保留自己的档位，只有真实浏览器能证明）、Legacy compatibility（阶段 1 的 `it('enforces root and one-shot child reject, allow and cancel …')` 及其 6 个场景、`.run/issue83` 证据目录、`scenarios: 6` 断言和 `ChildApprovalPanel` 只接管 one-shot 的语义逐字不变；对共享 fixture/provider 的改动必须是增量的，第三个 `it` 不触发任何新分支）、Concurrency（continuable 的父会话在工具调用返回后即回到 idle；子会话结算、activation 拆除时父会话被 `subagent-settled` 再唤醒一个回合（`packages/subagent/subagent/src/continuation-activation.ts:862-881`，根父会话走 `followup`）；等待 idle 和计数 dispatch 必须把这次唤醒算进去；子会话结算后再收消息会经 `agents.resume` 重新触发 `agent/created`）、Error handling（不确定项一律 fail closed：发行版行为与假设不符时用例失败并保留证据，不放宽断言、不 skip；取消审计只接受原生 `approval/decided` 的 `cancelled`）、Resource limits（新用例是独立的 `it`，自有 `runUserImage` 生命周期和 900s `testTimeout`；每个 `waitFor` 沿用 30s；控制接口输出有 60000 字符上限（`permission-browser-fixture.mjs:295`），新增的唤醒回合、审查记录和 `subagent/descriptor` 事件会增加审计条数，实现者要留意不被截断）；not selected - Public API、Config、File IO（只写 `/data/work` 下自有 nonce 文件）、Schema、Release（镜像、插件、覆盖层都不改；用例跑在捕获的镜像 ID 上）、Documentation（README 归 3.3）。无关键路径文件。PR 边界说明：issue 写「只改 `permission-tiers.docker.test.ts`」，但该文件的浏览器用例全部由 `platform/test/permission-browser-fixture.mjs`（及 `.d.mts`）和 `platform/test/permission-browser-provider.mjs` 驱动，continuable 场景必须在这两个测试自有文件里参数化，属于任务点名用例的组成部分，PR 描述写明。
Evidence (3.2): **不新增 cordis patch。** rc.2 的 `standard` 预设（`git -C resource/deepseek-harness show dsh-v0.2.0-rc.2:packages/bundle/web-app/presets/standard.patch.yml` 第 92-96 行）已把 `tool-subagent` 配成 `provider: spawn`、`backgroundMode: continuable`，覆盖层不碰它；`backgroundMode` 是插件配置不是工具入参，工具入参只有 `run_in_background`，缺省值为 `options.continuable`（`packages/subagent/tool-subagent/src/index.ts:303`、`:322`）。阶段 1 的六个场景是前台 one-shot，只因为测试自有 provider 传了 `run_in_background: false`（`platform/test/permission-browser-provider.mjs:132-136`）。任务里的「测试自有的 `backgroundMode: continuable` 组合」就是这个组合：根会话仍按 `agentPreset: 'standard'` 创建，provider 新增 `issue391-ui` 作用域，在 `delegate` 回合传 `run_in_background: true`，其余协议（child 的 `write`、第二次进入返回 `completed`）复用。**provider 的增量改动**（第三个 `it` 不触发）：(a) `tools/result` 对 `name === 'subagent'` 额外记录 `kind` 与 `subagentId`，不记录其他输出；(b) `agent/created` 观察器记录事件里的 `source`（现在写死为 `'real-native-in-process-child'`，`provider.mjs:194-205`），同一子会话每次 `agent/created` 各记一行；(c) 子会话的 `mode` 在 `agent/created` 观察器里读：按 `eventAt` 倒序扫描 `agent.session` 的日志取最近一条 `subagent/descriptor`（与控制接口取 `identity` 的写法相同，`provider.mjs:355-362`），连同 `tier`/`policy`/`source` 一起记进 `facts.children` 该行。不能靠 `session/event`：continuable 子会话的 descriptor 在 `setup` 回调里追加（`packages/subagent/subagent/src/continuation-activation.ts:622-630`），早于 session 公布和 `enter()`，`Session.append` 此时不派发 `session/event`（`packages/core/session/src/index.ts:740,756-764,1104`），而且子会话那时还不在 provider 的 `owned` 集合里；现有 `catalog` 是权限档目录、`providers` 是 `subagents.list()`，都读不到 mode。浏览器侧 `report.addresses[].mode`（`scripts/probe-session-address.mjs:7-13`）作为第二来源，两者必须一致。子会话结算后其 session 可能已从 `ctx.sessions` 移除（`packages/core/agent/src/index.ts:174-181`），所以档位、policy、mode 都在 `agent/created` 时记录，回合之间不读实时投影；(d) 只放行审查形态的模型请求：system 含 `authorization reviewer` 且 `!isAgentLoopRequest`（与 `plugins/permission-tiers/review.js:2,129` 和 `platform/test/permission-tiers-host.js:55` 一致），按 `permission-tiers-host.js:46-57` 回答 `{"decision":"allow"}`，`finish stop`（`:88`）。审查请求不带 `sessionId`（`review.js:120-128`），所以这个分支必须放在适配器 `:85` 和观察器 `:183` 两处 `owned.has(options.sessionId)` 检查之前，只能用审查 JSON `arguments.file_path` 里的 nonce 关联到具体调用，记录为 `facts.reviews`；其他非主循环模型请求仍抛「This oracle forbids auxiliary model calls」。`report.limits` 里「Auto selected only; review behavior belongs to production Docker protocol tests」改为说明 continuable 用例覆盖了 Auto 的真实审查放行。**新用例**：`platform/test/permission-tiers.docker.test.ts` 增加第四个 `it`（continuable 子会话），自有 `runUserImage` 生命周期、`isolatedBrowserRuntime`、证据目录 `.run/issue391/permission-continuable-*`（`evidence.json`、`lifecycle.json`、每个场景的 `*-pending.png`/`*-settled.png`，0600），`summary` 断言 `{status:'PASS', scenarios: 6}`；第三个 `it` 和 `.run/issue83` 不改。第三、四个 `it` 的 lifecycle.json try/catch（现 `:117-179`）抽成一个共享 helper（`*.test.ts` 不在 jscpd 统计内，仍按唯一性要求不复制）；`runPermissionBrowserScenario` 把场景列表、`report.limits`、Chrome 前缀、覆盖层名和 provider 作用域参数化，`runApprovalScenario`/`selectChild`/`auditFor` 按模式参数化，不复制第二份。**六个场景按顺序**，每个场景新建一个子会话、各自 nonce、各自文件 `/data/work/issue391-ui-child-<nonce>.txt`：(1) 人工批准档拒绝：文件不存在、dispatch 0、该 callId 的 `results.isError === true`（子会话得知被拒绝）、子会话的 `approval/asked` 恰一条且 `approval/decided` 为 `rejected`，`facts.approvals` 恰一条且 `agentId` 等于子会话、`exactRegisteredAgent`，父会话里没有该批准请求也没有面板；(2) 人工批准档允许一次：文件 base64 等于预期、dispatch 1、`allowed-once`；(3) 取消：批准面板挂起时取消**子会话**的当前任务。UI 的 Stop 按钮在 `InputBar` 里，composer 链 `overlay: true` 选中批准面板后 `InputBar` 被 `display:none` 隐藏（`packages/client/ui-slots/src/index.ts:275-282`、`ui-conversation/src/client/skeleton/ConversationContent.tsx:171-175`、`InputBar.tsx:461-476`），`physicalClick` 点不到，所以和 one-shot 的 `session/cancel` RPC 一样走 RPC：调用 Stop 背后同一个远端方法 `interruptByParent(child, parent, 'continuable')`（客户端 `packages/api/session-controller/src/client/sessions/session.ts:347-355` 与 `remotes.ts:33-37`，远端 `packages/subagent/subagent/src/index.ts:482-490` `@Remote('interruptByParent')`；实现者用 fixture 现有的 `mappedRpc` 通道确定映射名；gateway 的 `assertExactArguments`（`packages/api/gateway/src/index.ts:1478-1504`）要求参数名完全一致，所以参数是 `{childSessionId, parentSessionId, mode:'continuable'}`，不像 `session/cancel` 那样包一层 `request`）；父会话的 `session/cancel` 对 continuable 不生效，不得用。断言：面板消失、dispatch 0、文件在 settle 窗口后仍不存在、之后没有任何 `tools/execute`、`approval/decided` 恰一条且 outcome 为 `cancelled`（原生 `ApprovalService` 在信号中止时固定结算为 `cancelled`，`packages/interaction/user-approval/src/index.ts:269,297`）。本 change 规格「等待批准时取消」场景的 WHEN 同步改为「员工停止该子会话当前的任务」，因为 continuable 子会话按设计不随父 Session 取消而中止：用户发起的中断只取消子会话自己的回合（`continuation-activation.ts:305-326`），以父会话名义的取消只在父会话销毁时发生（`:808`）；修订见 `specs/permission-tiers/spec.md` 该场景，PR 作为记录在案的偏差写明；(4) 根会话用现有 `selectTier` 切到 Auto（UI 控件，不重启覆盖层）再委派：`facts.children.tier === 'auto-review'`、`policy === 'ask'`，写文件没有出现面板、dispatch 1、文件内容正确、没有 `approval/asked`、`facts.reviews` 恰一条且关联到该 nonce；(5) 根会话切到 Yolo（处理风险对话框）再委派：`tier === 'danger-full-access'`、`policy === 'never'`，无面板、dispatch 1、文件正确、没有 `approval/asked`、`facts.reviews` 0 条（人工批准档场景也是 0 条）；(6) 恢复保持自己的档位：根会话切回人工批准并委派，子会话允许一次写第一份文件并等它结算；然后根会话切到 Yolo，**员工在子会话的输入框**发送 `issue391-ui child reject <nonce2>`（continuable 的输入框在父可用时启用，`ui-conversation/src/client/skeleton/InputBar.tsx:133-139`；provider 对同一子会话的新用户消息返回新的 `write` 调用，第二份文件用 nonce2），断言该子会话第二行 `agent/created` 的 `source === 'resume'` 且 `tier === 'approval'`、`policy === 'ask'`（resume 是新的驻留周期，`facts.delegations` 会多一行 `local: true`，`packages/subagent/subagent/src/lifecycle.ts:177-195`，属预期），子会话仍弹原生面板、员工拒绝，第二份文件不存在，根会话自己的 tier 仍为 Yolo（`sessions` 投影）。**每个 continuable 场景共同断言**：父会话 `subagent` 调用的 `tools/result` 记录 `kind === 'continuable'` 且 `subagentId` 等于子会话；子会话 `subagent/descriptor` 与 `report.addresses` 的 `mode === 'continuable'`；该子会话首行 `agent/created` 的 `source === 'startup'`；`facts.children` 的 `origin === 'subagent'` 且 `parentSessionId` 为根会话；`facts.delegations` 的 `provider === 'spawn'` 且 `local === true`；`selectChild` 对 continuable 的顺序是：先等 `facts.children` 出现并立即断言该行 `mode === 'continuable'`（在 `agent/created` 时已确定，变异在此处失败），从子智能体目录点进子会话并核对 `report.addresses` 的 mode，再用 waitFor 等 `subagent` 调用的 `tools/result` 出现 `kind === 'continuable'`（continuable 下它可能晚于 `agent/created`，不能立即断言），最后等父会话回到 idle 且没有面板；批准挂起时控制接口 `sessions[]` 里子会话 `status === 'running'`（host 侧 `AgentStatus`，`provider.mjs:364-376`、`packages/core/agent/src/runtime-types.ts:109`；控制通道不暴露客户端 `session.running`，这里用 host 状态近似 3.1 留给 3.2 的第一项）；批准由子会话里的原生 `ApprovalPanel`（`[data-approval-key]`，按钮「允许一次」/「拒绝」）作答，`ChildApprovalPanel`（aria-label「子任务审批」）不得出现；场景结束前等父会话经历 `subagent-settled` 唤醒的回合并回到 idle，且该回合不产生新的 `tools/execute`。3.1 留给 3.2 的第二项「父会话不可用且未运行时只读席位接管」本用例明确不做：根会话在整个用例里始终存活，制造父 Agent 不可用需要杀掉根 Agent，不属于三档门禁的验收，留待后续 issue。**Red/mutation**：只有测试改动，没有可变红的生产代码；在 VPS 上用一次测试自有的变异证明断言有区分力：把 `issue391-ui` 作用域的 `run_in_background` 临时改回 `false`，新用例必须在 `facts.children` 的 mode 断言上失败（该断言在 `agent/created` 记录后立即执行、位于等待父 idle 之前，所以不是 30s 超时），`lifecycle.json` 为 FAIL；变异不进 PR。**不确定项的处理**：若真实发行版里 continuable 子会话首次 `agent/created` 不是 `source === 'startup'`、resume 时 `parentAvailable` 不为 true 导致输入框禁用或只读接管、或 `interruptByParent` 不撤回挂起批准，这些都是 3.1 插件或本用例假设的真实缺陷，实现者停止并报告，不改断言凑绿。验证：VPS 上 `pnpm test:docker platform/test/permission-tiers.docker.test.ts` 4/4 通过（阶段 1 的 6 个场景照旧），截图保存在 `.run/issue391/` 下；一次变异失败证据；`pnpm check` 通过；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：现有三个 `it` 的断言和证据目录、`permission-tiers-host.js` 协议用例、`plugins/permission-tiers/**` 不改（client.js、index.js、README 都不动）、`scripts/probe-permission-ui.mjs` 的 `selectTier` 只复用不改语义、镜像与覆盖层不变；PR 不超过 400 行，超出时带 `diff-limit-exempt` 标签并说明是单一验证用例的场景参数化。
Risk packs (3.3): selected - Documentation（README 对子会话语义的每一句都必须能对应 3.1 的成对单元测试、3.2 的浏览器用例或点名的插件/上游源码行；不得描述未测的行为，设计意图要标明是设计事实而非验证结果）；not selected - 其余全部（无代码、配置、镜像、测试改动）。无关键路径文件（`plugins/` 不在 Critical Paths 列表内）。
Evidence (3.3): 只改 `plugins/permission-tiers/README.md`，三处。(1) 第 35 行「Fresh same-process children …」段改写为同时覆盖 one-shot 与 continuable 子会话：两种模式都在 awaited `agent/created` 且 `source === 'startup'` 时继承一次父会话当时选定的档位，按顺序写入自己的 `permission/preset`、`sandbox/mode: danger-full-access` 和 `approval/policy`（danger 为 `never`，其余为 `ask`）（`plugins/permission-tiers/index.test.js:558-572`）；`resume` 不追加事件、不重新继承，子会话按自己记录的档位判定（approval→ask、auto-review→经审查后 allow、danger→allow；`:574-593`，`CHILD_DECISION` 在 `:536`）；父会话无档位或无存活 Agent 时启动抛 `UNAVAILABLE`，resume 时子会话无记录同样抛 `UNAVAILABLE` 且之后 gate 为 deny（`:595`、`:604`、`:612`）；host 只依据 `header.origin`、`header.parentSession` 和 permissions 投影判定，从不读取子会话模式，这是代码性质（`plugins/permission-tiers/index.js:98-102,156-168`），`describe.each(['one-shot','continuable'])`（`:555`）两种标签结果相同是其间接证据；委派提示词替换（`:622`，只用 one-shot 标签）对 continuable 同样成立的依据也是 host 与模式无关；批准请求归子会话本身，员工在子会话里作答。(2) 第 41 行标题「One-shot child approval presentation」改为与模式无关的标题（如「Child approval presentation」；仓库内没有引用该锚点），其下保留 one-shot `-20` 面板的原有描述（第 43-47 行不动），并在前面加一段 continuable 的呈现方式：发行版 `selectReadOnlySubagent`（`packages/client/ui-subagent/src/client/index.ts:37-49`）对父会话可用的 continuable 子会话返回 null，原生 `ApprovalPanel`（priority 1）在子会话自己的 Session 里展示并作答，`ChildApprovalPanel` 对 continuable 一律不接管（`client.test.js:68,75-77`）；continuable 的取消在 3.2 中通过远端方法 `subagents/interruptByParent`（UI Stop 按钮背后的同一方法：`packages/api/session-controller/src/client/sessions/session.ts:347-355`、`remotes.ts:33-37`）验证，批准挂起期间没有验证 UI 上的 Stop 按钮；「父会话的取消不中止 continuable 子会话」只作为上游设计事实陈述（`packages/subagent/subagent/src/continuation-activation.ts:305-326`、`:808`），并写明浏览器用例未验证它；父会话不可用且子会话未运行时的只读接管（`ui-subagent/src/client/index.ts:44-48`）未验证（`platform/test/permission-tiers.docker.test.ts:166` 的 `CONTINUABLE.limits`）。(3) 第 57-59 行验证段补上 3.2 的浏览器用例：用例名 `enforces continuable child reject, allow, cancel, Auto, Yolo and resume through the actual DSH browser UI`（`platform/test/permission-tiers.docker.test.ts:248`，逐字），证据目录 `.run/issue391/permission-continuable-*`，六个场景摘要；恢复场景的触发路径是员工在子会话自己的输入框发送后续消息（`platform/test/permission-browser-fixture.mjs:357-392`），断言第二行 `agent/created` 为 `source:'resume'`、`tier:'approval'` 而根会话已是 Yolo，与 one-shot 面板「does not enable follow-up messages」形成对照。两个用例的 limits 分别写：one-shot 原句（selects Auto but does not claim model review、administrator-default restart/resume/PTC/unload）保留不动；continuable 写「生产审查请求由测试自有的确定性 provider 答复 allow，deny/超时退为询问仍归协议用例，非 real-model；父会话不可用的只读接管未覆盖」（与 `CONTINUABLE.limits` 逐条对齐；administrator-default restart/PTC/unload 若要提及须注明是 README 自行补充的保守说明）。验证：README 的每条语义陈述在 PR 描述里列出对应的 file:line；`pnpm check` 通过（`pnpm fmt:check` 是 `prettier --check .`，`.prettierignore` 不含 `plugins/`）；exact-head VPS `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed（CI 证据门要求；无行为改动）。Must preserve：README 其余章节（revocation、Auto、unload、boot roster）不动；第 35 行改写时保留对两种模式都成立的现有表述——「after registry/Session publication but before first work is released」（`packages/core/agent/src/index.ts:176,550`）、「replacing the native `never` pin where necessary」、「A public scoped system-prompt assembly extension …」（`index.js:169-181`）、「Parent-scoped questions/screenshots are not child evidence」；第 57 行末句「Cancellation uses the actual parent Session cancellation boundary for its foreground child」不动（`permission-browser-fixture.mjs:235-239` 的 one-shot `session/cancel` 路径）；第 57 行 one-shot 用例名与 `permission-tiers.docker.test.ts:245` 逐字一致；第 43-47 行 one-shot `-20` 面板描述不动；不改代码、测试、规格。范围外（本 PR 不改，另行登记）：`AGENTS.md:313` 在 3.2 合入后仍只写 root/one-shot 与 `.run/issue83/permission-browser-*`。

## 4. DSH 0.2.1-rc.2 原子升级

依赖：1、2、3。关键路径 `images/dsh-user/`、`platform/src/orchestrator/`。PR 带 `diff-limit-exempt` 标签。理由：4.1–4.4 任何一项单独合入都会让 exact-head 的 `test:docker` 变红；4.6 的凭据绑定如果晚于升级合入，main 上会出现员工凭据覆盖平台密钥的窗口（F18）。PR 描述中要标明这是预发行版本线上的依赖升级。

- [x] 4.1 用户镜像钉定 `@deepseek-ai/dsh@0.2.1-rc.2`，构建期版本校验随之更新；四个镜像插件用 `engines.dsh` 声明兼容范围，并删除对 0.2.0-rc.2 的精确 peer 断言；镜像内 DSH 版本不满足任一插件的 `engines.dsh` 时构建失败；profile 初始副本按新版本重新生成。验证：用户镜像 Docker 用例中 `dsh --version` 为 `0.2.1-rc.2`，四个插件都被加载，profile 与初始副本逐字节一致；拒绝用例把一个插件的 `engines.dsh` 改为不含 0.2.1-rc.2 的范围，构建以非零状态失败。
- [x] 4.2 覆盖层的 webserver `host` 改为实例的 +2 地址；启动令牌只从 `dsh web: http://<+2>:3080/…` 这一行提取；对照 0.2.1 发行包核对 DSH 认证 cookie 的格式（`platform/src/orchestrator/credentials.ts:174`）。验证：解析器单元测试覆盖正确的行、旧格式的行、他人 IP 的行；`platform/test/container-readiness.docker.test.ts` 在 0.2.1 上就绪。
- [x] 4.3 对照覆盖层逐项核对 0.2.1 新增的 preset 行和 bundle（schedule、harness-dev-context、ui-secret-mask、ui-schedule、web-deepseek-api），涉及联网的行纳入联网工具的去除。验证：生成器单元测试列出每个新增行的处理方式；`platform/test/managed-policy.docker.test.ts` 通过。
- [x] 4.4 `plugins/office-agents` 删除自定义的选择逻辑，综合办公改用原生 `agentPreset`/`allowedAgentPresets` 把委派限定到 writer。Docker 和模型用例中写死 one-shot 的期望，改为不依赖子会话模式。验证：`pnpm test:docker platform/test/office-delegation.docker.test.ts`、`platform/test/office-agents.docker.test.ts` 通过。
- [x] 4.5 先写凭据优先级的 Docker 用例：员工在 `.credentials.yaml` 中为受管 provider 写入另一个密钥后重启实例，由测试自有的确定性 provider 记录 Authorization 头的哈希，断言使用的是平台密钥。在加入 4.6 的绑定之前，先在本 PR 的升级提交上运行该用例并记录结果（预期失败）。验证：`pnpm test:docker` 跑这个单独用例，留下绑定前的输出。
- [x] 4.6 覆盖层为受管 provider 显式绑定平台的环境变量来源，使员工凭据不生效。具体写法按 0.2.1 的凭据解析器核实后确定。验证：4.5 的用例通过；生成器单元测试覆盖这个绑定。若 0.2.1 的解析器无法做到，停止并报告，不降级。
- [x] 4.7 旧卷重置用例：用 0.2.0-rc.2 镜像初始化一对自有命名卷，并写入 Session 和工作区文件标记；换用 0.2.1-rc.2 镜像后执行重置实例配置并启动。断言 `profiles/` 与新镜像种子逐文件一致、实例认证就绪、原有 Session 和文件都可读取。验证：`pnpm test:docker` 中该用例通过，自有卷、容器和镜像都已清理。
- [x] 4.8 在升级后的镜像上重跑第 3 组的 continuable 用例和阶段 1 全部子会话用例。验证：exact-head 全量 `test:docker` 和 `test:deploy` 通过，清理已确认；另取得单独的 SHA 授权后，`pnpm ci:model` 中办公委派和真实模型用例通过。

Suggested fixture level: expanded - 跨镜像、编排器、覆盖层和三个插件的版本升级，加上平台密钥是否被员工绕过（F18）
Minimal mergeable slice: atomic: 0.2.1 拒绝 0.2.0 的监听值，又会跳过 peer 不匹配的插件，委派语义也随子会话模式改变；凭据绑定晚于升级会留下 F18 窗口；任何一项缺失，exact-head 全量 Docker 都无法保持绿或安全
Risk packs (4.x): fixture level expanded（与 issue 建议一致）。selected - Release / dependency upgrade（预发行线上的 DSH 依赖升级 0.2.0-rc.2 → 0.2.1-rc.2，发布于 2026-10-17，满足 7 天规则；一个 PR、`diff-limit-exempt`，理由见组首）、Legacy compatibility（阶段 1 旧卷经重置取得新 profile 并保留真实 Session；阶段 1 存量实例的网络形态不变；0.2.1 删除了 `ctx.subagents.start`/`startContinuable`/`drainContinuableChildren`，确定性测试 host 必须迁移）、Auth / credentials（F18：员工 `.credentials.yaml` 不得覆盖平台密钥；密钥只经环境变量名引用，不进日志、响应、审计、报告）、Config（覆盖层 `webserver.host` 从通配改为实例固定地址；生成器新增输入并校验）、Public API（启动令牌解析器签名变化；生成器输入形状变化；四个插件 manifest 从 peer 钉定改为 `engines.dsh` 范围；permission-tiers 删除客户端半区；委派从前台一次性改为原生异步 continuable）、Error handling / rollback（覆盖层生成移到网络分配之后，失败经现有 `rollbackStartupNetwork` 回滚；构建期兼容性校验以非零退出失败；通配地址的覆盖层让 DSH 拒绝启动）、Concurrency / shared state（start.ts 只交换 `managed overlay` 与 `network allocation` 两段的先后；原生子会话结算异步唤醒父会话）、Documentation（AGENTS.md、docs/DEPLOY.md、插件 README 的版本与规则）；not selected - File IO（无新文件格式）、Schema（无 HTTP 路由或迁移变更）、Resource limits（无变化）。
Evidence (4.x 共同): 分支 `codex/issue-393-dsh-0-2-1`（`scripts/ci-vps-run.mjs:10` 只接受 `refs/heads/codex/...`，否则 4.8 的 `pnpm ci:model` 直接拒绝）。所有 0.2.1 事实以 npm 发行包为准（本地只读副本，路径相对 `node_modules/@deepseek-ai/`；0.2.0 对照包：`dsh-web-app`、`dsh-base`、`dsh-subagent`、`dsh-tool-subagent`）：webserver 只接受具体 IP 字面值，`0.0.0.0` 在配置校验时抛错（`dsh-host-webserver/lib/index.js:134-143,251-257`）；启动行 `dsh web: http://<绑定地址>:3080/?token=<43 位 b64url>` 无 LAN 后缀（`dsh-web-app/lib/index.js:162`，token `dsh-client-connection/lib/index.js:294-299`）；cookie `/` 换取格式不变（`dsh-client-connection/lib/index.js:335-357,466-472`）；兼容性判定 `unmetRequirements`（`dsh-app-boot/lib/index.js:279-299`）以 `engines.dsh` 优先，`semver.satisfies(version, range, { includePrerelease: true })`，`semver` 只由 `dsh-app-boot` 声明（`^7.8.5`）；不匹配时 bundle 被跳过（stderr 前缀 `dsh: skipping profile bundle`）、`--patch` 插入行被 disable（stderr 前缀 `dsh: disabling profile plugin`，`:2306-2309`），`--dump-default-config` 仍以 0 退出；patch 行接受 `isolate`（`:3033-3036`），home 层先于 CLI `--patch` 层应用（`:3207`），员工去不掉平台写的 `isolate`，只能加入同一标签；凭据解析顺序 文件→进程环境→`.env`（`dsh-credentials-local/lib/index.js:480-497`），扁平旧布局会被自动迁移为 `version: 1` + `refs:`（`:174-196`），`loadInitial` 对不存在的文件会 `canonicalizeWatchPath` 到最近的现存父目录并 `opendir`（`:91-99,641-643`；`dsh-home-paths/lib/index.js:35-49`），所以存储目录必须对 uid1001 可遍历；pi-ai 解析 `apiKeyEnv` 在 `resolveApiKey`（`dsh-llm-pi-ai/lib/index.js:2892-2898`），环境发现在 `:2189`，两处都经该行 ctx 的 `ctx.get('credentials')`；`tool-subagent` 参数为 cwd/description/prompt/agent_preset/provider/model/reasoning_effort，没有 `run_in_background`（`dsh-tool-subagent/lib/index.js:384-416`；0.2.0 有），`agentPreset` 默认只在 `resolve(request)` 应用（`:248-254`）；spawn provider `capabilities.agentPreset: true`、`inheritsParentContext: false`、定义 `prepareContinuable`（`dsh-subagent-spawn-in-process/lib/index.js:21-31`），进程内子会话一律 continuable（`dsh-subagent/lib/index.js:3047`）；委派工具立即返回子会话 id，子会话结束后由 `notifySettlement` 向父会话注入一条结算消息，内容含子会话的 closing text（`dsh-subagent/lib/index.js:487-523,2048-2060`），不需要 `send_message` 即可拿到结果；子会话运行时 API 只有 `startActivation(spec: { provider, label, childId?, request, signal, delivery: 'parent'|'caller' })`、`drainChildren`、`waitForChildren`、`sendMessage`（`dsh-subagent/lib/index.js:3036-3047,3133-3147`，类型 `lib/types/types.d.ts:25-52`）；`agentPreset` 投影由创建头 `header.agentPreset` 初始化，`agent-preset/selected` 事件只在显式 select 时出现（`dsh-agent-preset-registry/lib/index.js:48-52`）；`cordis-plugin-loader` 1.0.6，`GlobalRealm` 按标签共享（`cordis-plugin-loader/lib/index.js:497-521`）；插件管理器 `lib/client.js` sha256 `b4efaa441258a547a0d7b3cab559fe073c69e69fe2bbb617c710ded134e7c4f9`；`conversation.composer`、`sidebar.footer.action` 两个 slot 仍存在。固定地址 Web 容器 helper（所有跑真实 DSH Web 的 Docker fixture 共用，写在 `platform/test/web-startup-fixture.ts`）：`WebContainer` 增加 `network: { name, subnet }`；helper 为每个容器建一个 invocation 自有、带 `dsh-team.test-run=<runId>` 标签的 /28 bridge（名字 `dsh-team-test-net-<runId>-<suffix>`，子网先读取当前所有 Docker 网络的 IPAM CIDR 快照和宿主 IPv4 内核路由表（`/proc/net/route`，每行目标/掩码换算成 CIDR，默认路由跳过），合并为 occupied 后再用编排器导出的 `allocateSubnet('198.18.0.0/15', occupied)`（RFC2544 基准测试段）分配，残留或并发网络以及宿主自己占用的地址段因此都被排除——2026-10-31 VPS 首跑证据：giap-vps 有 `198.18.0.0/30 dev Meta`（本机代理的 tun 口），只读 Docker IPAM 时第一个 /28 正好落在上面，宿主到 198.18.0.2:3080 的发布端口探测全部无响应（`n393d1diag` 诊断车道：launch 行已出现、`listening on 198.18.0.2`、HTTP 状态恒为 null）。路由表解析是纯函数，`web-startup.integration.test.ts` 用固定的 `/proc/net/route` 文本覆盖默认路由跳过、/30 和 /32 主机路由换算、异常行拒绝；池耗尽仍是显式错误，不回退到其它池；`docker network create` 仍冲突时以明确错误失败，不静默重试），在 `docker create` 前经 lifecycle `registerResource('network', …)` 登记，`createWebContainer` 加 `--network <name> --ip <instanceAddressLayout(subnet).container>`（从 `../src/orchestrator/index.ts` 导入），仍 `--publish 127.0.0.1::3080`；覆盖层由调用方写，`webserver.host` 默认写该 +2（4.7 的 0.2.0 容器例外写 `0.0.0.0`）；`observeWebEndpoint`（`web-startup-fixture.ts:73`）的就绪判定参数化为「启动行判定」，默认 `launchTokenPresent(logs, <+2>)`，调用方可注入其他判定（4.7 注入 0.2.0 格式读取器）；清理顺序容器→网络，并进入 owned inventory 与 `isAbsentResource` 检查。消费者（每个都要迁）：`user-image-fixture.ts:456-470`（web-startup 覆盖层字面量）、`managed-policy-fixture.ts:383-388`（`publishTransportOverlay`）及其 `generateManagedConfig` 调用、`model-refusal-fixture.ts`、`office-delegation.docker.test.ts`、`permission-tiers.docker.test.ts`、`permission-browser-fixture.mjs`、新 4.5 用例、`web-startup.integration.test.ts`（期望 argv 与覆盖层字面量）、`scripts/probe-first-run.sh:148,170` 与 `verify/phase0/managed.patch.yml:3`（`scripts/probe-dsh-api.sh:45,100,114` 使用；这两个浏览器通道同样建自有 bridge + `--ip`，子网选择经 `node` 调用编排器导出的 `allocateSubnet`（不在 bash 里重写），occupied 同样合并宿主路由表：同一段 `node` 从 `platform/test/web-startup-fixture.ts` 导入 `hostRouteCidrs`（该模块只依赖 node 内建和编排器导出，不依赖 vitest），路由表文件取 `${PROBE_ROUTE_TABLE:-/proc/net/route}`，`probe-cleanup.integration.test.ts` 用固定文件断言 `198.18.0.0/30` 宿主路由把分配推到 `198.18.0.16/28` 之后、文件缺失或畸形时探针失败而不是静默忽略，覆盖层由探针在自己的工作目录生成而不再使用静态的 `verify/phase0/managed.patch.yml`（阶段 0 证据文件不改），`scripts/probe-dsh-api-lifecycle.sh:156` 写死 `127.0.0.1` 的令牌正则改为探针已知的 +2 地址）。实现分批，批次之间由编排者跑 `pnpm check` 并 checkpoint 提交：A 镜像与插件（4.1、4.4 插件半区、版本钉定扫描）；B 编排器与生成器的 4.2、4.3（不含 4.6 绑定）；C 测试 fixture 迁移（固定地址 helper、子会话 API 与模式迁移、roster/哈希）；D1 新 Docker 用例（4.5、4.7、通配拒绝、task7.4 固定地址）；VPS 上对 D1 的 checkpoint SHA 单跑 4.5（预期红，观察到员工值哈希）；D2 4.6 绑定（生成器两行、Dockerfile 目录、单元测试）；VPS 单跑 4.5（绿）；D3 文档；最后 exact-head 全量。Docker 用例只能在 giap-vps 上跑；每批的 Docker 预期写在各任务 Evidence 里。
Evidence (4.1): `images/dsh-user/Dockerfile`：`npm install -g pnpm@10.34.6 @deepseek-ai/dsh@0.2.1-rc.2`，`expected="0.2.1-rc.2"`；删除三处内联 peer 比较和 office-agents 的 `peerDependencies` 断言，改为一段 `RUN node -e` 脚本：`const boot = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').resolve('@deepseek-ai/dsh-app-boot/package.json'); const semver = createRequire(boot)('semver');`，对四个 manifest（`/data/home/profiles/web/node_modules/@dsh-team/zh-locale`、`.../office-agents`、`/opt/dsh-team/permission-tiers`、`/opt/dsh-team/platform-nav`）要求 `engines.dsh` 为非空字符串、无 `peerDependencies["@deepseek-ai/dsh"]`，且 `semver.satisfies(installed, range, { includePrerelease: true })`，否则打印插件名并 `exit 1`；放在四个 COPY 之后、profile-seed 捕获之前；office-agents bundle 注册后再次 `dsh --profile web --dump-default-config`，stderr 捕获到文件，含 `dsh: skipping profile bundle` 或 `dsh: disabling profile plugin` 时构建失败。office-agents 的 COPY 列表去掉 `index.js`；permission-tiers 的 COPY 列表去掉 `client.js`（4.8）。四个 `plugins/*/package.json`：删除 `peerDependencies["@deepseek-ai/dsh"]`（对象空则整个删除），新增 `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }`；四个 README、`client.types.d.ts`/`types.d.ts` 注释、`plugins/zh-locale/README.md:153,183` 的 0.2.0-rc.2 改 0.2.1-rc.2。Docker 用例（`user-image.docker.test.ts`）：版本用例期望 `0.2.1-rc.2`；platform-nav 用例改断言 `manifest.engines.dsh` 包含 installed（容器内用同一 semver 解析法）且无 peer，输出 `{immutable:true, engines:<range>, uid:1001}`；`permission-tiers.docker.test.ts:15-45` 同样改法；`RELEASED_PLUGIN_PAGE_SHA256` 改 `b4efaa44…`（完整值见 4.x 共同）；新增「通配地址被拒绝」用例：手写 `host: 0.0.0.0` 覆盖层在自有 bridge 上起容器，断言容器在 60s 内非零退出且日志中没有 `dsh web: http` 行（日志只在内存中判定，不落盘、不打印）；task7.4 web-startup 用例改用固定地址覆盖层（经 helper），断言启动行地址等于 +2（`web-startup-fixture.ts` 的 summary 增加 `announcedHost` 字段）；拒绝用例：把 `plugins/platform-nav` 复制到 invocation 自有临时目录，`engines.dsh` 改 `>=0.3.0`，用该目录作 `platform-nav` 命名上下文构建 invocation 标签镜像，断言 `docker build` 非零退出且 stderr 含 `platform-nav`，成功或失败都删除可能产生的标签（`user-image-fixture.ts` 新增 `buildUserImageExpectingFailure`，复用 `prepareUserImage` 的参数拼装，不复制 argv）。「四个插件都被加载」证据放在使用完整受管覆盖层的 `managed-policy.docker.test.ts`：断言该实例 stderr 不含 `dsh: skipping profile bundle` 与 `dsh: disabling profile plugin` 两个前缀，且 boot roster 含 `@dsh-team/zh-locale`、`@dsh-team/platform-nav` 的客户端半区，受管 `permission` 行与 `agent-loop` 的 `managedPermissions` 注入生效（permission-tiers 在 4.8 后是纯 host 插件，以权限档观察为证），office 两个预设在 `SHIPPED_PRESET_IDS` 中被观察到。版本扫描清单：`profile-seed-fixture.ts:38,57`、`profile-seed.integration.test.ts:54,227`（改 `engines.dsh` 语义：canonical 读 `engines.dsh`，readback 的 `enginesDsh` 必须等于 canonical 且用 semver 包含 installed；保留一条范围不含 installed 的负例）、`permission-tiers-revocation-host.mjs:11`、`permission-tiers-fixture.ts:28`、`permission-browser-fixture.mjs:607`、`managed-policy-profile.ts:145-147`（loader `1.0.6`、DSH `0.2.1-rc.2`）、`managed-policy-oracle.ts:71`（注释）、`docker-version.integration.test.ts`、`scripts/probe-first-run-composition.{mjs,sh}`、`scripts/probe-plugin-page.mjs:8`、`scripts/probe-platform-nav.mjs:5`（注释）、`constraints.yaml:204,275`、`docs/DEPLOY.md:53`、`AGENTS.md:295`；`knip.json:7` 与 `plugins/office-agents/tsconfig.json` 对 `index.js` 的引用删除。Red-first：只改 Dockerfile 钉定与版本断言、不改插件 manifest 时，构建在 `engines.dsh` 校验处失败——这是红态；绿态为四个 manifest 改完后构建成功。Must preserve：`workspace.json` 不变；seccomp、非 root、分离挂载、离线 DOCX、遥测关闭、官方源策略、基础层 digest 全部不改（`images/seccomp/README.md` 与开发笔记 1 为历史记录，不改）。
Evidence (4.2): 生成器：`ManagedConfigInput` 新增必填 `instanceAddress: string`——由调用方按 /28 布局求出的员工容器固定地址；`generateManagedConfig` 校验它是规范点分 IPv4（`isIPv4` 且 `split('.').map(Number).join('.') === value`）、不是 `0.0.0.0`，且末八位组 `% 16 === 2`（即某个对齐 /28 的基址 +2），否则 `throw new TypeError('Managed overlay instance address must be the fixed container address of an aligned /28')`（不返回 `unconfigured`）；`webserver` 行 `config.host` 取该值。managed-config 不能 import orchestrator（`start.ts:5-8` 已 import managed-config，会成环），所以 spec「实例 Web 服务监听实例固定地址」的两个生成器场景在本变更中改写为「收到实例固定地址 / 收到非 +2、非规范或通配地址时拒绝」（spec delta 同步修改，理由记于 proposal.md Impact）。`start.ts`：`stage='managed composition'` 不动；`stage='managed overlay'` 的 `generateManagedConfig`/`writeManagedConfig` 移到 `network = await allocate(...)` 之后，传 `instanceAddress: instanceAddressLayout(network.subnet).container`；`unconfigured` 分支不可达（顶部已判），写成 `throw new Error('Managed overlay unexpectedly unconfigured')` 以免泄漏已建 bridge（走 `failedStartup` → `rollbackStartupNetwork`，`containerAttempted=false`）；`published-loopback` 同样写 +2（design 决定 2）。启动令牌：`web-launch-token.ts` 改为 `extractLaunchToken(logs, address)`/`launchTokenPresent(logs, address)`，正则由 `^dsh web: http://<escape(address)>:3080/\?token=([A-Za-z0-9_-]{43})\r?$` 按行匹配构成，不再接受 LAN 后缀与 127.0.0.1 特例；`credentials.ts` 的 `launchToken` 增加 `address` 参数，地址取自同函数第 285-306 行已经 inspect 并经 `validateUserNetwork` 核对的 `document` 中 `Networks['dsh-team-net-<user>'].IPAddress`（network 模式等于 `host`；loopback 模式是容器在自建 bridge 的地址），不新增 inspect，fake daemon 无需多一个响应；`readiness-logs.ts:14` 删除 `extractLaunchToken` 调用，保留 `/\bdsh\s+web\b/i` 作为脱敏判定。单元测试（`web-launch-token.test.ts`）：正确行 `dsh web: http://172.30.0.2:3080/?token=<43 字符>`（`\n`/`\r\n`）→ 提取；旧格式含 LAN 后缀 → undefined；他人 IP `172.30.0.18` → undefined；127.0.0.1 → undefined；前后多余字符、42/44 位 token → undefined。改签名后必须同步的调用点：`platform/test/deployment-audit-fixture.ts:144,217`、`deployment-credential-isolation-fixture.ts:88`、`deployment-privacy-fixture.ts:299`（`test:deploy`）、`instance.docker.test.ts:618`、`container-readiness.docker.test.ts:176`、`container-start.docker.test.ts:641`、`managed-policy-fixture.ts:523`（`qualifyHostSession`，同时增加一个可注入的 token 参数供 4.7 的旧容器使用）、`web-startup-fixture.ts:73`；生成器新增必填 `instanceAddress` 后 `write.test.ts` 等每个 `generateManagedConfig` 调用点同步；输出 127.0.0.1 启动行的夹具：`platform/src/orchestrator/readiness.test.ts:143`、`readiness-logs.test.ts:63-72`、`credentials.test.ts:115,219,222`、`platform/test/dsh-cookie-fixture.ts:176-177`、`dsh-cookie.integration.test.ts:269,273,732`、`web-startup.integration.test.ts:136-138,294`。`credentials.test.ts` 补「地址不符的行不换取、最终记录启动失败」。`generate.test.ts`：`webserver.host` 等于输入；`0.0.0.0`、`::`、`172.30.0`、` 172.30.0.2`、`172.030.0.2`、`172.30.0.5`（非 +2）抛 TypeError；`read.test.ts:86,182` 的 observation 用具体地址。`start.test.ts`：覆盖层写入发生在 `POST /networks/create` 之后、`POST /containers/create` 之前；写入失败时 `DELETE /networks/<id>` 且无 `containers/create`。Docker：`container-readiness.docker.test.ts` 在 0.2.1 上就绪；`container-start.docker.test.ts:184` 的期望 `webserver` 行改为 `instanceAddressLayout(<subnet>).container`。`credentials.ts:174` 注释改 0.2.1-rc.2。
Evidence (4.3): 0.2.1 相对 0.2.0 的行差异（`dsh-web-app/cordis.patch.yml`、`dsh-web-app/presets/*.yml`、`dsh-base/cordis.patch.yml` 三处两版逐行比对）。web profile 新增：`schedule`（不联网）、`harness-dev-context`（不联网）、`ui-secret-mask`、`ui-schedule`、`ui-deepseek-model-label-1017`（客户端 UI）；删除 profile 级 `tool-ralph`（`disabled: true` 行）。presets（standard/cordis/ptc）新增组件：`time-context`（不联网）、`tool-schedule`（不联网）、`tool-plugin-market`（`@deepseek-ai/dsh-plugin-market/tools`，`fetch` 索引 URL，`dsh-plugin-market/lib/index.js:558`，联网）；删除 `tool-subagent-codex`、`tool-subagent-claude-code`、`tool-ralph`；minimal 新增 `tool-fs`、`compaction` group（`compaction-basic`、`command-compact`，不联网）。dsh-base 新增 `remote-access`（`dsh-api-remote-access`，manifest 带 `dsh.client` platform web）、`working-directory`、`tool-working-directory`（不联网）、`web-deepseek-api`（host，只经 `tool-web` 暴露，`tool-web` 在 profile 层 `disabled: true` 且已在 `REMOVED_TOOLS`）；删除 `skill-badge`、`tool-ralph`。处置：全部新增行保留，`REMOVED_TOOLS` 不变——`tool-plugin-market`（工具名 `plugin_market`，`dsh-plugin-market/lib/types/tools.js:54`）是只读列表工具，依赖的 `pluginMarket` 服务来自可选 bundle、web profile 与 dsh-base 都没有挂载它，`indexes` 默认 `[]`（`:364`），只对管理员配置的安装源索引发请求，与 Discover 页共用；proposal「Discover/插件市场照常可用」（D9 修订）与第 12 组的安装源管理决定它的去留，不绑到联网开关；其余新增行同样保留（design 决定 1 第 2 项：`registryProbeEnabled:false` 与联网工具去除保留到插件目录组；`ui-plugin-manager` 行不改）；另一行处置「员工 home patch 以同一 isolate 标签加入凭据 realm」：已接受、仅文档化（见 4.6）。`generate.test.ts` 新增表驱动用例逐行列出上述每个新增/删除行与处置（`removed`/`retained`/`absent`），对 `tool-plugin-market`/`time-context`/`tool-schedule`/`tool-fs`/`compaction` 断言保留且顺序不变，对 `tool-web` 仍断言顶层、嵌套 group、改名 id 均被移除。Docker：`managed-policy.docker.test.ts` 通过；`managed-policy-oracle.ts` 的 `RETAINED_TOOLS` 保持子集检查，`NETWORK_TOOLS` 不变；`MANAGED_BOOT_ROSTER`（`managed-policy-fixture.ts:66`）增加 `@deepseek-ai/dsh-api-remote-access`、`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`、`@deepseek-ai/dsh-client-ui-schedule`、`@deepseek-ai/dsh-client-ui-secret-mask`（`assertRosterObservation` 是精确比较；第一次 VPS 运行的 roster 观察是最终权威，若实际 roster 不同则按观察修正并在 PR 写明）。Must preserve：`llm-deepseek`/`llm-deepseek-account` 仍 disabled；权限表、`agent-loop inject`、locale patch 顺序不变。首次 VPS 观察（managed-policy 窄车道，2026-10-31）：受管实例的客户端名册与 `MANAGED_BOOT_ROSTER` 逐项一致；三处测试宿主需按 0.2.1 修正——(a) 镜像内观察者 `managed-policy-observer.js` 原 import 的 `livePresetMounts` 在 0.2.1 的 `dsh-agent-preset-registry` 已不导出（只导出 `AgentPresetRegistry`、`agentPresetProjectionDefinition`、`auditRows`、`entryListProblem`、`leakedServices`），改用 `compositionInventory()` 行身份 + lease 作用域内 `systemPrompt.assemble` 的 `deployment:persona-prefix` 段与 `tools.schemas()` 的 read 工具描述读取有效值；(b) 浏览器探针等待的 `button[aria-label="设置"]` 只是 `settings.launcher` 槽为空时的兜底，受管实例由 `dsh-client-ui-settings-account` 的「账号菜单」（`aria-haspopup="menu"`，portal 菜单项「设置」）填槽，探针改为识别两者；(c) `dsh-tool-subagent` 0.2.1 在 `agent/created` 时才把 `subagent` 工具注册进每个 agent 的运行时上下文（`lib/index.js:605`、`:489`），预设 lease 作用域内观察不到，oracle 的 `RETAINED_TOOLS['office-general']` 不再要求它，综合办公的委派工具由 `office-delegation.docker.test.ts` 的真实子会话创建证明。
Evidence (4.4): 插件：删除 `plugins/office-agents/index.js`、`index.test.js`、`types.d.ts`（若只被 index 使用），`cordis.patch.yml` 删除 `office-delegation` insert 行；`package.json` 删除 `main` 与 `"."` export，保留 `./docx-construction` 与 `./package.json`（`dsh-app-boot` 加载 bundle 只读 `dsh.bundle.patch`，`:493-530`）；`office-general` 的 `tool-subagent` 行 config 改为 `{ provider: spawn, toolName: subagent, agentPreset: office-writer, allowedAgentPresets: [office-writer] }`（`SubagentPresetSelection` 要求 `agentPreset ∈ allowedAgentPresets`；模型看到单值 `agent_preset` 枚举，省略即 writer，其他值被 `resolve()` 拒绝）。委派语义（异步）：0.2.1 的 `subagent` 工具立即返回子会话 id，子会话结束后结算消息（含 closing text）唤醒父会话；两个 office 预设不加入 `tool-subagent-control`（结果经结算消息交付，不需要 `send_message`）。persona suffix 改写三句：子 Agent 固定为公文与材料写作，无需也不要传其他预设；委派调用立即返回子 Agent 编号，子 Agent 完成后会以一条结算消息把结果送回，收到后再核对真实文件并交付，不要在收到前声称完成；委派不可用或失败时明确报告。README 对应改写。「before parent resumption」在异步语义下指：以子会话的构造结果事件为观察点，早于父会话收到结算消息的那一轮。确定性 host 迁移（0.2.1 删除了 `start`/`startContinuable`/`drainContinuableChildren`）：`office-delegation-host.mjs`（`:295,336,407,410,446,467,484,488,515,575,593,626`）、`permission-tiers-host.js:459`、`office-construction-native.mjs:15,54` 改用 `startActivation({ provider: 'spawn', label, request: { parent, prompt, … }, signal, delivery })` 与 `drainChildren`；其中 office-general→writer 的默认值与拒绝其他预设两条必须经真实 `subagent` 工具调用路径证明：协议适配器让模型侧发出一次 `subagent` 工具调用（省略 `agent_preset`）→ 子会话创建头 `agentPreset === 'office-writer'`、`projection.values.agentPreset === 'office-writer'`，且 `agent-preset/selected` 恰好一次、由原生创建 setup 在 `subagent/descriptor` 之前追加（`dsh-subagent/lib/index.js:1795-1802`），descriptor 之后没有任何选择事件（spec「No post-creation rebinding」）；0.2.1 在发布 agent 之前就写完选择事件与 descriptor（`dsh-agent-loop/lib/index.js:1786-1794,1931-1933`），所以阶段 1 的「descriptor 未发布前拒绝分页」窗口不再存在：`office-delegation-host.mjs` 的 `pendingChildIdentity` 与 `office-delegation.docker.test.ts` 改为断言 `agent/created` 时 descriptor 已存在、分页立即可用，保留错误父会话与错误模式的拒绝；`instance-idle-docker-fixture.ts:297` 容器内 RPC 的目标改为容器自己的 +2 地址；再发一次 `agent_preset: 'office-general'` → 工具调用失败、无子会话。`office-delegation-host.mjs:239-241` 的现有断言（header 为 `office-general`、选择事件由本仓库插件发出）反转为上述。父会话等待条件：等子会话结算且父会话被唤醒的那一轮结束，不以父会话第一次 idle 为完成。模式无关化：`office-writer-oracle.ts:50,101` 接受 `one-shot|continuable`；`office-delegation-host.mjs:261,353`、`office-delegation-copy-host.mjs:118`、`office-writer-model-fixture.mjs:91` 的地址 `mode` 从观察到的 descriptor 读取；`office-model-observer.mjs:14` eligible 改 `data.provider === 'spawn'`，`:16` writer 判定改读 `agentPreset` 投影/创建头；`office-model-observer.integration.test.ts:76-82`、`office-writer.integration.test.ts`（10 处）同步。Docker：`pnpm test:docker platform/test/office-delegation.docker.test.ts platform/test/office-agents.docker.test.ts` 通过；迁移前这两个文件与 `permission-tiers.docker.test.ts` 的协议用例在 0.2.1 镜像上必红（API 缺失）。Must preserve：构造回执、权限档效果、冷读/恢复、取消与失败目标的结算语义。
Evidence (4.5): 新 Docker 用例 `platform/test/credential-priority.docker.test.ts` + `credential-priority-fixture.ts`，先于 4.6 写入并在 VPS 上单跑：容器内 recorder 插件监听 `127.0.0.1:<port>` 充当受管 `baseURL`（`http://127.0.0.1:<port>/v1`，形态复用 `model-refusal-fixture.ts` 的 prepare 脚本/recorder/`runWebStartup`/`qualifyHostSession`/`mappedRpc`），对每个 `/chat/completions` 请求把 `Authorization` 头的 sha256 与计数写入 `/data/home/credential-ledger.json`，返回最小合法的非流式 completion；平台密钥经 `env: { DMXAPI_KEY: <nonsecret 平台值> }` 注入；准备脚本以 uid1001、0600 写 `/data/home/.credentials.yaml`：`version: 1\nrefs:\n  DMXAPI_KEY: <nonsecret 员工值>\n`；重启实例，经 RPC 发一条消息触发一次模型请求，读 ledger 断言 `total === 1`、`authorizationSha256 === sha256('Bearer ' + 平台值)`、且不等于 `sha256('Bearer ' + 员工值)`。假绿守卫：`dsh-llm-pi-ai/lib/index.js:2893-2895` 在 realm 里没有 `credentials` 服务时直接回退到启动环境，隔离凭据插件加载失败也会得到平台值；因此重启后的容器日志（两个流，只在内存里判断，token 不进报告）必须不含 `Failed plugins (`、`plugin tree failed to load`、`dsh: skipping profile bundle`、`dsh: disabling profile plugin`，含任一即失败并只报告命中的前缀。两个值都是测试自有的非密钥常量，ledger 只存哈希。绑定前记录：原计划在批次 D1 的 checkpoint（已升级、未绑定）上 VPS 单跑该文件；实际 D1 首跑失败于上文的宿主路由缺陷（不是哈希断言），因此红灯证据改为在 D2b checkpoint 上用 mutation 车道去掉 `generate.ts` 的两处 4.6 行（隔离标签与插入的凭据存储行）再单跑，预期失败于哈希断言且观察到员工值哈希（2026-10-31 实测 `observed: ["employee"]`），车道结束后远端检出恢复到精确 head；D2b checkpoint 本身单跑为绿（`observed: ["platform"]`）。两个 SHA、命令与输出写入 PR 的 Runtime evidence。Must preserve：`model-refusal.docker.test.ts` 继续通过。假绿守卫的标记列表移到共享的 `platform/test/plugin-failure-markers.ts`（`Failed plugins (`、`plugin tree failed to load`、`dsh: skipping profile bundle`、`dsh: disabling profile plugin`、`did not activate`——非必需项激活失败只打 `dsh: warning: N entr(y|ies) did not activate` 并继续启动，`dsh-app-boot/lib/index.js:4410/4474`），`credential-priority-fixture.ts` 与 `managed-policy-fixture.ts` 共用，Docker-free 用例 `plugin-failure-markers.integration.test.ts` 覆盖干净日志通过与五种失败日志抛错。
Evidence (4.6): C1 隔离凭据存储（用户 2026-10-30 拍板，design 决定 11 修订）。生成器在 `llm-pi-ai` 行加 `isolate: { credentials: 'dsh-team-platform' }`（config 照旧整份重述），并在最后的 `insert` 中、`platform-nav` 之后增加 `{ id: 'dsh-team-platform-credentials', name: '@deepseek-ai/dsh-credentials-local', disabled: false, isolate: { credentials: 'dsh-team-platform' }, config: { path: '/opt/dsh-team/credentials/platform.yaml', dshHome: '/data/home', watch: false } }`；`watch: false` 因为该路径永不变化、不需要 chokidar watcher；`/opt/dsh-team/credentials/` 由 Dockerfile 创建为 root 所有 0555 空目录——uid1001 可遍历、可 `opendir`（`assertOwnerOnly` 对 ENOENT 会 `canonicalizeWatchPath` 到该目录）、不可创建文件；pi-ai 在该 realm 解析 `apiKeyEnv` 时文件无值 → 落到进程环境变量。`generate.test.ts`：两处 `isolate` 标签相同；隔离行在 `platform-nav` 之后、`agent-loop` 之前；`path` 在 `/opt/dsh-team/credentials/`；`watch:false`；相同输入逐字节相同。user-image Docker 用例断言 `/opt/dsh-team/credentials` 为 root 0555、uid1001 `opendir` 成功、写入 `EACCES`。4.5 用例在绿态通过。残余风险（仅文档化，4.5 不覆盖）：任何能写补丁行的层（含员工可写的 `$DSH_HOME/cordis.patch.yml`）写同一 `isolate` 标签即加入该 realm，可再挂一个 `credentials` 实现；替代写法 `cordis:group` + `isolate: { credentials: true }`（LocalRealm，标签不可加入）需要把 `llm-pi-ai` 换 id 重插，未核实 UI 影响，另立 follow-up issue 评估；平台变量缺失时回落到 `.env`（平台总是注入，缺失则实例本就不启动）；设置页仍描述全局存储的凭据状态（显示性）；pi-ai OAuth 登录在该存储不可写时失败（本项目不用）。Must preserve：`client-connection` 继续使用全局 `credentials` 写 browser-session 密钥；员工对 `llm-pi-ai` 的设置页编辑仍被整份 config 覆盖。
Evidence (4.7): 新 Docker 用例 `platform/test/volume-upgrade.docker.test.ts`，经 `runNetworkAcceptance` 运行：(1) 旧镜像是真实的阶段 1 镜像：升级前的 main 提交写成完整 SHA 常量 `3482a5205be018c0716b5bd4e7718023f8e3af98`（本分支的父提交；VPS checkout 由分支 bundle 建立，含该祖先对象），`git archive <SHA> images/dsh-user plugins/zh-locale plugins/permission-tiers plugins/office-agents plugins/platform-nav | tar -x -C <invocation 临时目录>`，对象不存在则直接失败不跳过；断言取出的 Dockerfile 钉定 `@deepseek-ai/dsh@0.2.0-rc.2`，用同样的四个命名上下文构建 invocation 标签镜像 `dsh-team-test-<runId>-legacy`（登记为 image 资源，600s 期限），并断言其 `dsh --version` 为 `0.2.0-rc.2`；(2) 用 orchestrator 的卷命名与标签（`dsh-team-home-<user>`/`dsh-team-work-<user>`，同时带 `dsh-team.user=<user>` 与 `dsh-team.test-run=<runId>` 两个标签——前者给编排器的归属核对、后者给 `assertOwnedVolumes`，经 `registerResource('volume', …)` 登记；生产代码复用预建卷在仓库里没有先例，以第一次 VPS 运行为准）预建两卷；用旧镜像和一份 `host: 0.0.0.0` 覆盖层（0.2.0 只接受 127.0.0.1/0.0.0.0）在自有 bridge 上起 0.2.0 Web；0.2.0 的启动行是 `dsh web: http://127.0.0.1:3080/?token=… (LAN: …)`，由 volume-upgrade fixture 内部的 0.2.0 格式读取器提取令牌（不从生产模块导出），经 `qualifyHostSession` 的可注入 token 参数 + `mappedRpc` 创建一个真实 Session 并完成一次确定性回合（测试自有 provider，不联网），写工作区文件 `/data/work/dsh-team-legacy-marker.txt`，记录 Session id、观察到的 session `formatVersion`、`profiles/web/package.json` 的 `dsh.profile.bundles` 与哈希；停止该容器；(2b) 负向观察（不要求失败）：在重置之前，以 HEAD 镜像、只读挂载 home 卷、`--network none` 跑一次性 `dsh --profile web --dump-default-config`，stderr 含 `dsh: skipping profile bundle`（旧 office-agents manifest 为 exact peer 0.2.0-rc.2），只读挂载保证 dump 不改写旧 profile；(3) 用 HEAD 镜像与 `startupClient` + `createOrchestrator`（network 模式、stand-in 平台）对该用户执行 `owner.restoreUserProfiles({ userId, config: { userImage: lifecycle.imageId, … } })`，再 `startDockerInstance` 等待就绪（实例认证就绪 = 成功换取 cookie）；(4) 断言：`profileSeedOracle()(probe(profileSeedScript))` 逐文件一致；工作区文件内容不变；用 0.2.1 的 session RPC（`session/list` 或 projections）按 id 读回同一个 Session 且其回合记录可读，记录此时观察到的 `formatVersion`（迁移是否发生按观察写进 PR，不预设结论；design.md 第 23 行称 v4 不变）；`owner.stopUserContainer` 后旧镜像、容器、两卷、网络经 lifecycle 清理，`isAbsentResource` 确认。`RETIRED_BUNDLES` 是否改写旧 profile 以步骤 (2) 记录的 `bundles` 列表核实后写入 PR，不预设结论。AGENTS.md Docker 段落写明「VPS checkout 必须包含该提交对象」。旧镜像构建后随用例一起通过 lifecycle 清理（`dsh-team-test-<runId>:legacy-0.2.0-rc.2`，显式标签：Docker 29.1.3 把缺失的无标签镜像报告为 `<name>:latest`，`isAbsentResource` 精确匹配诊断）。VPS 事实（2026-10-31，n393vol2 诊断）：giap-vps 直连 deb.debian.org 约 25KB/s（宿主机与容器一致，npm 约 1.2MB/s，经 mihomo 约 1.9MB/s），而 BuildKit RUN 层不读 CLI 代理环境，两版 Dockerfile 共用的 `apt-get` 层一旦没有 BuildKit 缓存，任何原生用户镜像构建（本用例的旧镜像、`user-image.docker.test.ts` 的不兼容范围拒绝构建）都超过 600s；用户授权的宿主机前提：`dsh-team-docker0-egress.service` 加一条 `ip rule priority 9500 from 172.17.0.0/16 lookup 2022`（docker0 源地址走 mihomo auto-route 维护的表 2022；不改 mihomo/daemon 配置、不加 proxy build-arg；自有 198.18 网桥与外部 172.30/172.31 网桥不受影响），生效后容器内 12MB Packages.gz 3.9s。`docker()` 构建失败诊断只含 status/signal/elapsed/deadline，不含 stderr（代理 URL 可能带凭据）。会话头探针：0.2.1 的 `dsh-session-persistence-jsonl` 默认 zstd（`<root>/<projectKey>/<id>/v4.jsonl.zstd`，root = `$DSH_HOME/sessions`），探针同时读取明文 `.jsonl` 与 zstd 日志（内存解压，8 MiB 上限，超限/解压失败记入 `skipped` 不判定），头行 `type: "session"`；用例断言两版 `sessionHeaders` 非空、`formatVersion` 为正整数且版本集合相同（首次 VPS 运行 n393vol3 的旧探针只认 `.jsonl`，两版均为空，由此修正；89b7599 上 n393e1 实测两版均为 `session.v4.jsonl.zstd`、formatVersion 4、compression zstd，bundles 前后一致）。「版本集合相同」是对当前钉定 0.2.1-rc.2 的特征化断言，不是会话格式不变的契约：将来 DSH 升级若做合法的格式迁移，这条断言会大声失败并需要人工重新判定。Must preserve：`profile-restore.docker.test.ts` 现有断言。
Evidence (4.8): 阶段 1 全部子会话用例在 0.2.1 上重跑：`permission-tiers.docker.test.ts:117` 的 `ONE_SHOT` suite 改名 `STAGE1`，`mode` 改为 `'observed'`；`permission-browser-fixture.mjs` 的 `continuable` 由观察到的 descriptor `child.mode` 推导而不是 suite 常量，父会话等待/`session/cancel` 分支与父空闲/`subagents/interruptByParent` 分支按观察模式选择；`permission-browser-provider.mjs:167` 删除 `run_in_background`；`permission-browser-fixture.d.mts` 类型同步。`plugins/permission-tiers/client.js` 全文（111 行）就是 one-shot 只读批准座位，在 0.2.1 上执行不到：整块删除客户端半区——`client.js`、`client.test.js`、`client.types.d.ts`、manifest 的 `dsh.client`/`./client` export/`files` 条目、`tsconfig.json:4` include、Dockerfile 第 71 行 COPY 列表中的 `client.js`；同步 `permission-tiers.docker.test.ts:23,32,34`（文件清单去掉 `client.js`，改为断言 `client.js` 不存在且 manifest 没有 `dsh.client`）、`MANAGED_BOOT_ROSTER` 去掉 `@dsh-team/permission-tiers`（`managed-policy-fixture.ts:131`）、`permission-browser-fixture.mjs:44,805` 的 `CHILD_PANEL` 断言改为「子会话批准由原生面板作答」、`index.test.js:555,624` 的 one-shot 分支、README；由 continuable 浏览器用例证明原生 composer 承接子会话批准。spec 要求子会话 reject/allow/cancel 三条路径由 STAGE1 的 `delegate` 场景与 CONTINUABLE suite 共同覆盖，不删场景。证据：exact-head giap-vps `pnpm test:docker` 全量（含新用例）与 `pnpm test:deploy` 全部通过、cleanup confirmed；随后对同一 SHA 跑一次用户已授权的 `pnpm ci:model <sha> refs/heads/codex/issue-393-dsh-0-2-1`，办公委派与真实模型用例通过；重跑需再次授权。AGENTS.md：Docker 段落（`:295`）与 Verification Matrix 的 0.2.0-rc.2 改 0.2.1-rc.2，并写明 `engines.dsh` 构建期校验与 stderr 跳过检查、固定地址监听与按地址解析启动行、通配地址拒绝用例、task7.4 固定地址覆盖层（原「handwritten readonly `0.0.0.0:3080` overlay」改写）、隔离凭据存储及其残余风险、委派改原生 `agentPreset` 与异步结算、子会话一律 continuable、permission-tiers 纯 host 化、`tool-plugin-market` 保留的理由；`docs/DEPLOY.md:53` 同步。

## 6. 技术债 #374：显式化被容忍的变更型调用失败

依赖：无。由现有 issue #374 承载：Stage 5 不新建 issue，而是编辑 #374 的正文，补齐实现就绪字段并挂到 Epic 下。

- [x] 6.0 清点 `platform/test/` 和 `scripts/` 中捕获失败后继续执行的变更型 Docker 调用，产出清单写入 #374 正文。每条记录文件和行号、调用、当前的容忍方式，以及选定的处理：声明精确的 `acceptedStatus` 并独立核验结果，或让测试直接失败。验证：#374 正文中有完整清单；对两个目录做一次捕获点检索，结果条数与清单一致，差异逐条说明。
- [x] 6.1 按 6.0 的清单逐处转换：清单中的每个调用点（同一测试文件内的多个调用点可以合为一条）是 #374 下的一个独立子任务和 PR，各自先写回归测试、再改调用点。不放宽已有的 HTTP 拒绝矩阵和 `unconfirmed` 判定。验证：每个子任务的回归测试在改动前失败、改动后通过；清单逐条勾选，没有遗漏。
- [x] 6.2 验证：清单全部完成后，exact-head 全量 `test:docker` 通过，清理为 `confirmed`。

Suggested fixture level: compact - 只改测试和验证脚本，不改产品行为
Minimal mergeable slice: 6.1 中单个调用点的转换和它的回归测试可以单独合入（每处相互独立）
Risk packs (6.1 deployment): selected - Error handling（变更型 `docker exec` 的任何非零/异常都必须让用例失败而不是被 `expect.poll` 的重试吞掉；新函数内的 `inspect` 失败原样上抛；poll 里原有的 `container inspect` 仍受 poll 重试，因为它只读、不产生 submission（`scripts/docker-command.mjs:21-26`），可以接受；poll 里的 `ps` 不在那个只读动词表里、会产生 submission，所以改为同义的只读 `container ls`）、Concurrency（`State.Running` 为真只说明 PID 1 已启动，不等于它已阻塞在 vfork 等待：wchan 可以晚于 Running 出现，所以对 wchan 值的轮询要保留，但每次 `exec` 必须成功）、Legacy compatibility（`drains an active composition helper…` 用例里的 inspect/标签/挂载断言、helper 捕获、后续断流与清理逻辑不变，`ps` 只换成等价别名；`deployment.docker.test.ts` 其余用例与 `deployment-fixture.ts` 不动）；not selected - Public API、Auth、Config、Schema、File IO、Resource limits、Release、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`）。
Evidence (6.1 deployment): **现状**：`platform/test/deployment.docker.test.ts:241-290`（用例 `drains an active composition helper after its caller disconnects before removing the platform`）的 `expect.poll` 回调依次做 `ps --filter …`（`:245-259`）、`inspectAsync`（`:261`）与标签/挂载断言、捕获 `helper`（`:281`），最后 `command(['exec', id, 'cat', '/proc/1/wchan'])`（`:283-284`；`command` 在 `:207-208` 定义为 `output(await lifecycle.commandAsync(args, 30_000), args)`，非零即抛）。vitest 的 `expect.poll` 把回调抛错当作本轮未满足并按 `interval: 50` 重试直到 `timeout: 10_000`，所以首次 `exec` 非零时错误被吞掉、该 submission（`scripts/docker-command.mjs:30-44` 只在 status 0 结算）永不结算。**改动点**（只改 `platform/test/deployment.docker.test.ts`，新增 `platform/test/composition-helper-probe.ts` 与 `platform/test/composition-helper-probe.integration.test.ts`；不改产品代码、不改 `deployment-fixture.ts`、不放宽拒绝矩阵与 `unconfirmed` 判定）：(1) 新模块导出 `awaitHelperWaitingForPartner(probe, id, deadlineMs = 10_000, intervalMs = 50): Promise<void>`，`probe` 为 `{ inspect: (id: string) => Promise<Record<string, unknown>>, exec: (args: string[]) => Promise<string> }`。算法（单调时钟 `performance.now()` 计截止）：循环 `row = await probe.inspect(id)`；`record(row.State).Running !== true` 时等待 `intervalMs` 后重试（Running 之前绝不 `exec`）；Running 后 `wchan = (await probe.exec(['exec', id, 'cat', '/proc/1/wchan'])).trim()`，等于 `wait_for_partner` 则返回，否则等待 `intervalMs` 后从 inspect 重来（成功的 `exec` 已结算，重复观察 wchan 值是允许的）；`inspect`/`exec` 的任何 rejection 原样向上抛出，没有 try/catch，没有对非零的重试；超过截止抛 `new Error('Composition helper did not reach wait_for_partner')`（message 附最近一次观察：`running=<bool> wchan=<值或 none>`）。(2) 用例改动：`expect.poll` 回调在捕获 `helper` 后直接 `return true`（去掉 `:283-284` 的 exec）；`:246` 的 `'ps'` 改为 `'container', 'ls'`（`docker ps` 的官方别名，`--filter/--format/--no-trunc` 与输出完全相同；`args[1] === 'ls'` 属于 `scripts/docker-command.mjs:21-26` 的只读集合，不产生 submission，而 `ps` 不在该集合里，留在会吞错的 poll 中会与 exec 犯同样的错；#374 清单把 `ps` 视为只读是遗漏，已在 #374 留言更正；`:568` 的另一处 `ps` 不在 poll 内、经 `output()` 非零即失败，本 PR 不动）；其余 inspect/断言原位不动；`if (helper === undefined) throw` 之后新增 `await awaitHelperWaitingForPartner({ inspect: (id) => inspectAsync(lifecycle, id), exec: command }, helper.id)`；`:291` 起的逻辑不变。与 issue 文字「再做一次 exec」的差异及理由：`State.Running` 不保证 PID 1 已到 vfork 等待，单次 exec 会把时序抖动变成假失败，所以 wchan 值仍可在成功的 exec 之间轮询；被禁止的只是对失败 exec 的重试。**Docker-free 回归**（`composition-helper-probe.integration.test.ts`，用记录调用的桩 `probe`，不起进程、不碰 Docker；每个用例 `deadlineMs` ≤ 500、`intervalMs` 10）：(a) 红证据：inspect 返回 `{ State: { Running: true } }`；exec 第一次 reject `new Error('docker exec h cat /proc/1/wchan failed (1)')`，之后返回 `'wait_for_partner\n'` → `await expect(awaitHelperWaitingForPartner(probe, 'h', 500, 10)).rejects.toThrow('failed (1)')`，且 exec 恰好被调用 1 次；(b) inspect 依次返回 Running false、false、true（之后 true）；exec 依次返回 `'do_wait\n'`、`'wait_for_partner\n'` → resolve；断言 exec 第一次调用发生在第三次 inspect 之后（记录调用序列），exec 共 2 次，每次参数恰为 `['exec', 'h', 'cat', '/proc/1/wchan']`；(c) inspect 始终 Running false，`deadlineMs` 120 → reject `Composition helper did not reach wait_for_partner`，exec 从未被调用；(d) inspect reject `new Error('No such container')` → 立即 reject 同一错误，exec 从未被调用。**Red first**：第一步先把函数抽到新模块但保留现状语义（内部 `try { … } catch { 继续重试 }` 直到截止）并把用例改为调用它，写 (a) 运行 `pnpm test:integration platform/test/composition-helper-probe.integration.test.ts` → (a) 红（promise resolve 而非 reject，exec 2 次）；第二步去掉 try/catch 改为严格语义，再补 (b)(c)(d) 转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm check` 通过（knip：新导出只被 `deployment.docker.test.ts` 与其集成测试引用；`lint:tests` 不要求 `platform/test/` 下的配对）；VPS 窄跑 `pnpm test:docker platform/test/deployment.docker.test.ts` 通过且 owned inventory 为空、`pnpm test:deploy` 通过；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：该用例其余断言与断流/清理流程、`deployment.docker.test.ts` 其他用例、`deployment-fixture.ts`、`docker-cleanup.ts` 的 `output`、`trusted-docker-verification` 的拒绝矩阵与 `unconfirmed` 判定；`.run/`、产品代码、AGENTS.md 不动。残留风险（PR 写明）：真实 helper 是否曾在 Running 之前被 exec 只能由 VPS 运行间接证明（本次改动使之不可能发生）；若 wchan 在 10s 内始终不是 `wait_for_partner`，用例按新错误文本失败，不再被重试掩盖。
Risk packs (6.1 container-readiness): selected - Error handling（`badOverlay` 分支只容忍「DSH 快速退出导致的已启动容器检查失败」这一种形态；Docker 层失败（`/start` 非 2xx、清理失败、网络创建未确认、home helper 未确认）必须让用例失败，不能再被 `catch` 吞掉）、Legacy compatibility（`startFailed` 为真时的 DB 行、`createdId`、`instance.started` 缺席与 `instance.start-failed` 事件断言、`waitForUserContainerReady` 的处理、独立日志/网络缺席核验全部不变；`badOverlay: false` 行为不变）、Concurrency（真实快速退出与启动后 inspect 之间存在竞态：容器仍在运行则 `startUserContainer` 成功、随后 readiness 失败，该路径已有处理并保持）；not selected - Public API、Auth、Config、Schema、File IO、Resource limits、Release、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`，不改 `platform/src/orchestrator/`）。
Evidence (6.1 container-readiness): **现状**：`platform/test/container-readiness.docker.test.ts:110-129` 在 `badOverlay` 时 `catch (error) { if (!badOverlay) throw error; startFailed = true; }`，任何错误都被吞掉。预期的合法失败形态由产品代码钉死：published-loopback 模式下 `launchInstance`（`platform/src/orchestrator/start.ts:281-283`）`POST /containers/{id}/start` 后 `GET /containers/{id}/json`，`startedUpstream`（`:217-232`）先 `validateUserNetwork` 再 `inspectUserContainerEndpoint`；容器已退出时，真实 Docker 上通常由 `validateUserNetwork` 先抛（`platform/src/orchestrator/networks.ts:86` 空 `EndpointID` → `Invalid Docker container identity`，或 `:176` `Owned network endpoint missing`），假 daemon 只改 `State.Running` 时由 `inspectUserContainerEndpoint` 抛 `Started container identity or state mismatch`（`platform/src/orchestrator/start-identity.ts:68`）；两者都发生在 stage `started container inspection`（`:597` 在两次调用之前设置）、都是裸 `Error`，经 `failedStartup`（`:292-320`）用 `startupFailure(stage, error)`（`:86-107`）包装成 message `Container startup failed during started container inspection`、`cause: { stage: 'started container inspection', cleanupFailed: false, networkUnconfirmed: false, dockerStatus: undefined }`（stage 由 `:597` 的回调设置；`dockerStatus` 仅在 `DockerHttpError` 时有值；`HomeHelperUnconfirmedError` 时返回该子类而非裸 `Error`）。Docker 层失败的形态不同：`/start` 非 2xx → stage `container start` 且 `cause.dockerStatus` 为状态码；清理失败 → `cleanupFailed: true`；网络创建未确认 → `networkUnconfirmed: true`；helper 未确认 → 错误原型不是 `Error.prototype`。**改动点**（只改 `platform/test/container-readiness.docker.test.ts` 的那个 `catch`，新增 `platform/test/bad-overlay-start-failure.ts` 与 `platform/test/bad-overlay-start-failure.integration.test.ts`；不改产品代码，不放宽拒绝矩阵与 `unconfirmed` 判定）：(1) 新模块导出 `isBadOverlayFastExit(error: unknown): boolean`：`error instanceof Error` 且 `Object.getPrototypeOf(error) === Error.prototype`（排除 `HomeHelperUnconfirmedError` 等子类，不需要从产品模块导入类）、`error.message === 'Container startup failed during started container inspection'`、`error.cause` 为非 null 对象且恰好 `stage === 'started container inspection'`、`cleanupFailed === false`、`networkUnconfirmed === false`、`dockerStatus === undefined`；其余一律 false。不做任何重抛/日志，纯谓词。(2) 用例改动：`catch (error) { if (!toleratedStartFailure(badOverlay, error)) throw error; startFailed = true; }`，其中同文件顶部的三行私有辅助 `toleratedStartFailure(badOverlay, error) = badOverlay && isBadOverlayFastExit(error)`（把两个条件直接写进 `readinessScenario` 会让其 ESLint `complexity` 达到 16、超过上限 15；辅助函数保持 15，语义与单行写法相同）；该行之外的用例代码（`:130-205` 的行/事件/日志/网络断言与 `waitForUserContainerReady` 处理）原位不动。**Docker-free 回归**（`bad-overlay-start-failure.integration.test.ts`，用 `./container-start-fixture.ts` 的 `startupOwnerFixture()` 驱动真实 `createOrchestrator`/`startUserContainer` 与假 daemon，写法参照 `platform/test/container-start.integration.test.ts:524-546`）：(a) 红证据：`daemon.overrides.set('POST /containers/<START_CONTAINER>/start', { status: 500 })` → `await startUserContainer(input)` 捕获的真实错误 message 为 `Container startup failed during container start`，`isBadOverlayFastExit(error) === false`（`cause.dockerStatus === 500`）；(b) `daemon.beforeRequest` 在 `GET /containers/<START_CONTAINER>/json` 时把已 Running 的容器置 `State.Running = false`（即 `:535-540` 的 `not running` 注入）→ 真实错误 message 为 `Container startup failed during started container inspection`，谓词为 true；并断言 `JSON.stringify(error.cause)` 等于 `{"stage":"started container inspection","cleanupFailed":false,"networkUnconfirmed":false}`（`dockerStatus` 为 undefined 不序列化），把谓词和产品实际输出绑定；(c) 构造的非匹配值逐个为 false：非 `Error` 值、无 `cause` 的同 message `Error`、`cause.cleanupFailed: true`、`cause.networkUnconfirmed: true`、`cause.dockerStatus: 404`、`cause.stage: 'created container inspection'`、同 message 同 cause 但由 `class extends Error` 构造的实例；(d) 构造的匹配 `new Error(message, { cause: {…四键…} })` 为 true（最小正例）。**Red first**：第一步把谓词抽到新模块但保留现状语义（对任何值返回 true）并把 Docker 用例改为调用它，只写 (a)，运行 `pnpm test:integration platform/test/bad-overlay-start-failure.integration.test.ts` → (a) 红（谓词对 `/start` 500 返回 true）；第二步实现选择性谓词并补 (b)(c)(d) 转绿；PR 描述贴出两次输出。验证：该集成测试与 `pnpm test:integration platform/test/container-start.integration.test.ts` 通过；`pnpm check` 通过（knip：新导出被 Docker 用例与集成测试引用；`lint:tests` 不要求 `platform/test/` 配对）；VPS 窄跑 `pnpm test:docker platform/test/container-readiness.docker.test.ts`（`badOverlay` 两行）通过且 owned inventory 为空；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：用例其余断言与清理、`container-readiness.docker.test.ts` 的 `badOverlay: false` 行、产品代码、`trusted-docker-verification` 的拒绝矩阵与 `unconfirmed` 判定、AGENTS.md。残留风险（PR 写明）：该阶段的只读 GET 若以非 HTTP 错误（传输错误/超时/abort）失败，`dockerStatus` 同为 undefined 会被谓词接受，但它们不是变更型调用，且其后 `State.Running === false` 与 `assertFailedStartupLogs` 独立证明 DSH 确已退出；`:141-148` 围绕 `waitForUserContainerReady` 的 `badOverlay` 处理不在本调用点范围内（它不吞 Docker 变更失败，#374 清单未列）；真实坏 overlay 的快速退出若在 VPS 上落在别的 stage（按 published-loopback 代码路径不应发生），用例会按新谓词失败并暴露真实形态，由窄跑决定；本改动不消除「容器仍 Running 时 start 成功、随后 readiness 失败」的既有路径，它本来就不被吞。
Risk packs (6.1 office-delegation): selected - Error handling（主场景已失败时，证据读取容器（`execScript` 的 `docker create`/`start`）的失败不能再被降级成一行 stderr：它必须与原失败一起以 `AggregateError` 抛出，让用例失败并让该 submission 的未结算可被归因）、Legacy compatibility（主场景成功时的断言、证据文件写入、stdout 行、`.run/issue213` 证据目录、主场景成功但证据读取失败时直接抛该错误、主场景失败但证据读取成功时抛原错误——这六条可观测行为与错误分派不变；第二个 `it` 与 `managed-policy-fixture.ts` 不动）；not selected - Public API、Auth、Config、Schema、File IO、Concurrency、Resource limits、Release、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`）。
Evidence (6.1 office-delegation): **现状**：`platform/test/office-delegation.docker.test.ts:69-80` 把主场景 `execScript` 的结果收进 `outcome: { ok: true; value } | { ok: false; error }`；`:81-131` 的外层 `try` 先用 `execScript`（`platform/test/managed-policy-fixture.ts:170-235`：`:179` 登记容器后 `:180-197` `docker create`、`:230` `start --attach`、`:231-232` `wait`/`logs`，一次性证据读取容器）读取三份证据并写入 `native-<runId>.json`，再在 `outcome.ok` 时做成功断言；`catch (error) { if (outcome.ok) throw error; process.stderr.write('Office failure evidence persistence failed; original failure retained\n'); }`（`:132-137`），随后 `if (!outcome.ok) throw outcome.error; return outcome.value;`。主场景已失败且证据容器也失败时，证据失败只剩 stderr 一行，其 `docker create`/`start` submission 未结算且无法从用例失败里归因。**改动点**（只改 `office-delegation.docker.test.ts` 的 `:68-139`，新增 `platform/test/office-delegation-outcome.ts` 与 `platform/test/office-delegation-outcome.integration.test.ts`；不改产品代码、不改 `managed-policy-fixture.ts`、不放宽拒绝矩阵与 `unconfirmed` 判定）：(1) 新模块导出类型 `OfficeOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }` 与函数 `settleOfficeEvidence<T>(outcome: OfficeOutcome<T>, persist: () => void): T`：调用一次 `persist()`；它抛错时，`outcome.ok` 则原样重抛该错误，否则抛 `new AggregateError([outcome.error, error], 'Office delegation scenario and failure evidence persistence failed', { cause: error })`（顺序固定：主场景错误在前；`cause` 是持久化错误，满足 ESLint `preserve-caught-error`，不额外断言）；它不抛时，`outcome.ok` 则返回 `outcome.value`，否则抛 `outcome.error` 本身。不写 stderr。(2) 用例改动：`outcome` 的类型改为 `OfficeOutcome<string>`；`:81-139` 改为 `return settleOfficeEvidence(outcome, () => { …`:82-92` 的证据脚本、`execScript`调用与`writeFileSync(…native-<runId>.json…, { mode: 0o600 })` 逐字搬入…; if (outcome.ok) { …`:94-130` 的成功断言与 stdout 行，逐字不动… } });`，原 `catch`、`if (!outcome.ok) throw outcome.error;`、`return outcome.value;` 删除。**Docker-free 回归**（`office-delegation-outcome.integration.test.ts`，纯函数，不起进程、不碰 Docker）：(a) 红证据：`outcome = { ok: false, error: primary }`，`persist` 抛 `secondary` → `expect(() => settleOfficeEvidence(outcome, persist)).toThrow(AggregateError)`，捕获后断言 `errors` `toHaveLength(2)`、`errors[0]` `toBe(primary)`、`errors[1]` `toBe(secondary)`（对象同一性）且 message 为固定文本；`primary`/`secondary` 都是普通 `Error`，不得本身是 `AggregateError`；(b) `outcome` 失败、`persist` 正常 → 抛出的正是 `primary`（`toBe`），`persist` 调用 1 次；(c) `outcome = { ok: true, value: 'v' }`、`persist` 抛 `secondary` → 抛出的正是 `secondary`，不是 `AggregateError`；(d) `outcome` 成功、`persist` 正常 → 返回 `'v'`，`persist` 调用 1 次。**Red first**：第一步新建模块但保留现状语义（`persist` 抛错且 `outcome` 失败时写 stderr 并抛 `primary`），把用例改为调用它，只写 (a)，运行 `pnpm test:integration platform/test/office-delegation-outcome.integration.test.ts` → (a) 红（抛的是 `primary` 而非 `AggregateError`）；第二步改为聚合语义，补 (b)(c)(d) 转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm check` 通过（knip：新导出被 Docker 用例与集成测试引用；`lint:tests` 不要求 `platform/test/` 配对）；VPS 窄跑 `pnpm test:docker platform/test/office-delegation.docker.test.ts` 通过且 owned inventory 为空；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：`:94-130` 的成功断言与 `Native office delegation verified` 行逐字不变；`native-<runId>.json` 的写入时机不变（证据容器成功即写，不依赖主场景结果）；第二个 `it`（`rejects a native writer that only copies…`）、`managed-policy-fixture.ts`、产品代码、AGENTS.md 不动。残留风险（PR 写明）：聚合只改变失败的呈现，不改变证据容器本身的清理路径（`lifecycle.registerContainer` 登记的容器仍由既有 owned cleanup 回收）；主场景成功后证据容器失败的行为本来就不被吞，这里只保持。
Risk packs (6.1 browser-runtime): selected - Error handling（回收后的 `execBrowser` 不再用 `catch(() => undefined)` 丢弃拒绝：用例声明它期望的结果是一个封闭集：接受前发起的 `:441` 探针允许「以空输出正常结束」（`docker stop` 时 `byte-listener.mjs:72-76` 对已接受 socket 的 `destroy()` 向对端送 FIN，`node -e` 脚本无其他句柄即以 0 退出）或以 `exit`/`timeout` 原因拒绝；容器删除后的 `:497` 探针只允许 `exit`/`timeout`；其余 `resolved` 输出、`output-limit`、`spawn`、`callback`、spawn 前的 authority/submission 抛错与非 `Error` 拒绝都让用例失败；不新增通用的请求失败白名单）、Legacy compatibility（`adopts only an explicitly pending identity…` 用例的接受/半关闭/receipt 改写/`rescueChrome`/CDP 存活检查/按 nonce 的容器与网络缺席核验（`:476-496`）全部不变；`execBrowser` 与 `beginVerificationBrowserExec` 的发布栅栏不动；其他用例不动）；not selected - Public API、Auth、Config、Schema、File IO、Concurrency、Resource limits、Release、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`）。
Evidence (6.1 browser-runtime): **现状**：`platform/test/browser-runtime.docker.test.ts:441-445` 在接受连接前发起 `execBrowser(execution, …connect…)` 并 `void client.catch(() => undefined)`；`:460` 在 `rescueChrome` 回收容器后 `await client.catch(() => undefined)`，拒绝原因被丢弃；`:497-499` 对回收后的第二次 `execBrowser` 只断言 `rejects.toThrow()`，不声明原因（该调用点不在 #374 清单里，是本条的范围扩展：同一用例、同一「回收后 exec」探针，按 6.1 的同文件合并规则纳入，PR 与 #464 写明）。`execBrowser`（`platform/test/browser-runtime-fixture.ts:350-430`）的拒绝来源：spawn 前 `captureBrowserExecAuthority`（`:355`）/`beginVerificationBrowserExec`（`:356`）抛错、`fail()` 的 `timeout`（`:381`，message `Owned browser protocol client timeout`）/`output-limit`（`:388`，`Owned browser protocol client output limit`）/`callback`（`:396-400`，回调原错误）/`spawn`（`:405-411`，子进程 `error` 对象）、`close` 时非零退出的 `exit`（`:414-418`，`Owned browser protocol client failed`）以及未失败时 `publish` 抛错（`:421-424`）；原因通过 `publish({ exitCode, signal, failure })` 发布，但错误对象本身只带 message。两次探针的合法结果不同：`:441` 的探针在 `rescueChrome` → `retireIsolated` 的 `docker stop --time 8`（`scripts/probe-browser-runtime.mjs:259`）期间，PID1 的 `stop()`（`:676-678`）先 `app.close()`，`byte-listener.mjs:72-76` 对已接受 socket `destroy()` 送出 FIN，`:443` 的 `node -e` 脚本没有其他句柄，于是以 0 退出、`execBrowser` 以空字符串 resolve；若脚本未及退出而被命名空间 SIGKILL 则是 `exit`（137），超时则是 `timeout`。`:497` 的探针在容器已删除后发起，CLI 以 No such container 非零退出（`exit`）或 `timeout`。**改动点**（只改 `browser-runtime.docker.test.ts` 的 `:441-460` 与 `:497-499`，新增 `platform/test/browser-exec-outcome.ts` 与 `platform/test/browser-exec-outcome.integration.test.ts`；不改 `browser-runtime-fixture.ts`、不改产品代码）：(1) 新模块导出类型 `BrowserExecSettlement = { settled: 'resolved'; output: string } | { settled: 'rejected'; error: unknown }`、`settleBrowserExec(client: Promise<string>): Promise<BrowserExecSettlement>`（`client.then(output => ({ settled: 'resolved', output }), error => ({ settled: 'rejected', error }))`，永不拒绝，因此替代 `void client.catch(() => undefined)` 的防未处理拒绝作用）和 `expectRetiredBrowserExec(settlement: BrowserExecSettlement, options: { gracefulEmptyExit: boolean }): void`：当 `settled === 'rejected'` 且 `error instanceof Error` 且 `error.message` 恰为 `Owned browser protocol client failed` 或 `Owned browser protocol client timeout` 时返回；当 `options.gracefulEmptyExit` 为 true 且 `settled === 'resolved'` 且 `output === ''` 时返回；否则抛 `new Error('Retired browser exec settled outside the declared outcomes', { cause: settlement })`。(2) 用例改动：`:445` 改为 `const settlement = settleBrowserExec(client);`（在 `await accepted` 之前，与现状同位置）；`:460` 改为 `expectRetiredBrowserExec(await settlement, { gracefulEmptyExit: true });`；`:497-499` 改为 `expectRetiredBrowserExec(await settleBrowserExec(execBrowser(execution, 'process.stdout.write("unexpected-live-browser")')), { gracefulEmptyExit: false });`（同一用例里同样的「回收后 exec」探针，不是新调用；Prettier 会把这一行拆为多行，跑 `pnpm fmt`）。其余行不动。**Docker-free 回归**（`browser-exec-outcome.integration.test.ts`，纯 Promise，不起进程、不碰 Docker）：集成测试 `import type { BrowserExecSettlement }` 并用它标注 (a)–(d) 的字面量（knip 默认检查导出类型）。(a) 红证据：`expectRetiredBrowserExec({ settled: 'rejected', error: new Error('Owned browser protocol client output limit') }, { gracefulEmptyExit: false })` 抛 `Retired browser exec settled outside the declared outcomes`；(b) `{ settled: 'resolved', output: 'x' }` 在两种 `gracefulEmptyExit` 下都抛同一文本；(b2) `{ settled: 'resolved', output: '' }` 在 `gracefulEmptyExit: true` 下不抛、`false` 下抛同一文本；(c) `{ settled: 'rejected', error: 'exit' }`（非 `Error`）抛同一文本；(d) `Owned browser protocol client failed` 与 `Owned browser protocol client timeout` 两种 `Error` 在两种选项下都不抛；(e) `settleBrowserExec(Promise.resolve('out'))` 得 `{ settled: 'resolved', output: 'out' }`，`settleBrowserExec(Promise.reject(err))` 得 `{ settled: 'rejected', error: err }`（同一引用）且不产生未处理拒绝（由 vitest 的未处理错误检测判定）。**Red first**：第一步新建模块但 `expectRetiredBrowserExec` 保留现状语义（接受任何 settlement，直接返回），把用例三处改为调用它，只写 (a)，运行 `pnpm test:integration platform/test/browser-exec-outcome.integration.test.ts` → (a) 红（不抛；红对照的是这个保留现状语义的 stub，PR 写明）；第二步实现封闭集判定，补 (b)(b2)(c)(d)(e) 转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm check` 通过（knip：新导出被 Docker 用例与集成测试引用）；VPS 窄跑 `pnpm test:docker platform/test/browser-runtime.docker.test.ts` 通过且 owned inventory 为空（两次真实回收后 exec 的结果由它证明属于各自封闭集；第一次探针的实际结果（空输出 resolve 还是 `exit`）记入 PR）；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：用例其余步骤、`:443` 的探针脚本与 `:476-496` 的缺席核验、`browser-runtime-fixture.ts` 的 `execBrowser`/发布栅栏（其 `:381`/`:416` 两条 message 原文从此是断言契约，改动它们必须同步改 `expectRetiredBrowserExec`）、其他 Docker 用例、产品代码、AGENTS.md。残留风险（PR 写明）：若真实 `docker exec` 以 `spawn` 错误、非空输出或 spawn 前抛错结束，用例会按新文本失败并暴露实际结果，由窄跑决定；错误对象不携带 `failure` 原因字段，封闭集以 message 为准（与 `execBrowser:381,:416` 一一对应）；`execBrowser` 是裸 `spawn`，不经 `scripts/docker-command.mjs` 的 `acceptedStatus`，规格里的 `acceptedStatus` 字面不适用，以声明的封闭集代替。
Risk packs (6.1 browser-acquisition): selected - Error handling（`finally` 不再用 `pending?.catch(() => undefined)` 丢弃首次 `rescueChrome` 的失败：仅主路径未消费的首次失败在清理阶段被读取并保留（已被 `:208` 消费、成为主失败本身的那一个不再重复）；该失败、复调 rescue 的失败与场景本身的失败一起以 `AggregateError` 抛出，不丢弃任何一个）、Concurrency（`pending` 可能在主路径 `:208` 已 await 并成功，也可能因 `:192-200` 的 race 先抛而未被消费；清理阶段只在 `pending` 已 settled 之后复调 rescue，不与仍在进行的 rescue 并发）、Legacy compatibility（主路径断言、`stopDriver`、`rm(root)`、cgroup 路径的 `stopOwnedUnit`/`removeOwned` 与 PATH 恢复不变；`rescueChrome` 不动）；Concurrency 与 Legacy compatibility 仅限测试内 Promise 结算顺序和 `finally` 清理顺序，不触及产品共享状态，compact 维持；not selected - Public API、Auth、Config、Schema、File IO、Resource limits、Release（都不触及：纯测试内 Promise 聚合）、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`）。
Evidence (6.1 browser-acquisition): **现状**：`platform/test/browser-acquisition.docker.test.ts:166` 声明 `let pending: Promise<void> | undefined`，`:190` `pending = rescueChrome(receiptFile)`（内部经 `browserDocker` 做 `stop`/`rm`/`network rm`，变更型；#374 清单漏了 `stop`），`:192-200` 用 `Promise.race` 等待活体生产者栅栏，`:208` `await pending`；`:257-263` 的 `finally` 里 `await pending?.catch(() => undefined)` 吞掉首次 rescue 的拒绝后无条件 `await rescueChrome(receiptFile)`。主路径在 `:208` 之前抛错（race 的两种失败或 `:201-206` 的断言）时，首次 rescue 的失败只被丢弃，其 `rm`/`network rm` submission 未结算且无法从用例错误归因。**改动点**（只改 `browser-acquisition.docker.test.ts` 的 `:166`、`:190` 与 `:257-263`，新增 `platform/test/rescue-settlement.ts` 与 `platform/test/rescue-settlement.integration.test.ts`；不改 `rescueChrome`、不改产品代码）：(1) 新模块导出 `trackRescue(rescue: Promise<void>): TrackedRescue`（`TrackedRescue = { promise: Promise<void>; settled: () => boolean; failure: () => unknown }`，通过附加 `.then` 记录 settled 与拒绝值；附加的分支自己 `catch` 以免产生未处理拒绝；`promise` 仍是原 promise，主路径 `await tracked.promise` 行为不变）和 `settleRescue(tracked: TrackedRescue | undefined, rescue: () => Promise<void>, primary: { error: unknown } | undefined): Promise<void>`：`tracked` 已定义且未 settled 时先 `await tracked.promise.catch(() => undefined)` 再读 `failure()`（未 settled 只会出现在主路径从未等到 `pending` 的情况；这不是吞错，拒绝值随后被保留）；无论 `tracked` 是否定义，随后都恰好调用一次 `rescue()`（与现状 `:262` 的无条件复调一致，`:190` 之前失败时仍回收部分创建的资源）；收集 `failures: unknown[]`：`tracked.failure()` 非 undefined 且 `!Object.is(failure, primary?.error)` 时推入（首次失败若已在 `:208` 被主路径消费，它就是 `primary.error`，不重复）；然后 `await rescue()` 的拒绝推入；最后若 `failures` 非空：`primary` 存在时抛 `new AggregateError([primary.error, ...failures], 'Acquisition scenario and rescue failed')`，否则抛 `new AggregateError(failures, 'Acquisition rescue failed')`；`failures` 为空时返回（`primary` 由调用方原路径重抛）。(2) 用例改动：`:166` 改为 `let pending: TrackedRescue | undefined`，`:190` 改为 `pending = trackRescue(rescueChrome(receiptFile))`，`:192-200`/`:208` 的 `pending` 改为 `pending.promise`；外层 `try` 增加 `catch (error) { primary = { error }; throw error; }`（`let primary: { error: unknown } | undefined` 在 `try` 前声明）；`:261-262` 两行改为 `await settleRescue(pending, () => rescueChrome(receiptFile), primary)`；其余 `finally` 内容（`birthReleased.resolve`、`stopOwnedUnit`、`writeFile(released)`、`stopDriver`、`rm(root)`、内层 cgroup 清理与 PATH 恢复）原位不动。因为 `settleRescue` 在 `finally` 中抛出会替换主路径的异常，所以它把 `primary.error` 放进 `AggregateError` 的第一项，主失败不丢失；无清理失败时它不抛，主失败按原样（同一引用）传播。用例体内不得再加分支或 `?.`（用例箭头函数复杂度已接近 15），判断逻辑都放进 `settleRescue`。**Docker-free 回归**（`rescue-settlement.integration.test.ts`，纯 Promise，不起进程、不碰 Docker）：(a) 红证据：`tracked = trackRescue(Promise.reject(first))`，`rescue` 返回 resolved → `settleRescue(tracked, rescue, { error: primary })` 抛 `AggregateError`，`errors` `toHaveLength(2)`、`errors[0]` `toBe(primary)`、`errors[1]` `toBe(first)`，message `Acquisition scenario and rescue failed`，`rescue` 调用 1 次；(b) `tracked` 已 resolve、`rescue` 拒绝 `second`、无 `primary` → 抛 `AggregateError([second])`，message `Acquisition rescue failed`；(c) `tracked` 已 resolve、`rescue` resolved、有 `primary` → 不抛（主失败由调用方传播）；(d) `tracked` 尚未 settled（手工 `Promise.withResolvers`，在 `settleRescue` 开始后才 reject `first`）、无 `primary`、`rescue` resolved → 抛 `AggregateError([first])`，message `Acquisition rescue failed`，且 `rescue` 在 `tracked` settled 之后才被调用（记录顺序）；(e) `tracked` 为 undefined、`rescue` resolved → 不抛，`rescue` 调用 1 次；`tracked` 为 undefined、有 `primary`、`rescue` 拒绝 `second` → 抛 `AggregateError([primary, second])`，message `Acquisition scenario and rescue failed`；(f) `tracked = trackRescue(Promise.reject(first))`、`primary = { error: first }`、`rescue` resolved → 不抛（首次失败已是主失败）；`trackRescue(Promise.reject(x))` 不产生未处理拒绝（用 `process.on('unhandledRejection', handler)` 守卫，`finally` 里 `process.off`；断言前 `await new Promise((resolve) => setImmediate(resolve))` 让出一次宏任务，因为 Node 在微任务清空后才派发该事件）。**Red first**：第一步新建模块但 `settleRescue` 保留现状语义（`await tracked?.promise.catch(() => undefined)` 后直接 `await rescue()`，不收集、不聚合），把用例改为调用它，只写 (a)，运行 `pnpm test:integration platform/test/rescue-settlement.integration.test.ts` → (a) 红（不抛 `AggregateError`）；第二步实现保留/聚合语义，补 (b)–(f) 转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm check` 通过（knip：新导出被 Docker 用例与集成测试引用）；VPS 窄跑 `pnpm test:docker platform/test/browser-acquisition.docker.test.ts` 通过且 owned inventory 为空；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：主路径全部断言、`rescueChrome` 与 `scripts/probe-browser-runtime.mjs`、`finally` 里 `birthReleased.resolve`（`:257`）、`stopOwnedUnit`、`writeFile(released)`（`:259`）在 `settleRescue` 之前、`stopDriver`、`rm(root)`（`:263`）在其之后，外层 `finally` 的 `removeOwned`（`:266-284`）与 PATH 恢复（`:286-287`）不变；cgroup/非 cgroup 两种 termination 的清理顺序、产品代码、AGENTS.md。残留风险（PR 写明）：`settleRescue` 抛出（首次失败未被消费、或复调失败）时 `:263` 的 `rm(root)` 不执行，`root` 作为证据保留，与现状复调失败时的行为一致，外层 `removeOwned`/PATH 恢复仍执行；`rm(root)` 若失败仍会按 JS 语义替换前面的异常，这是既有行为、不在本调用点范围内；复调 rescue 的必要性（首次成功后再调一次应为幂等 no-op）不变。
Risk packs (6.1 shell-probes): selected - Error handling / rollback / partial outputs（`docker rm -f`/`rmi -f`/`run --rm` 的失败不再按自己的 stderr 子串放行：只有一次独立的只读、带 `probe_run_bound` 超时的 `docker <container|image> inspect` 以仓库既有 `isAbsentResource`（`platform/test/docker-command.ts:215-229`）同样严格的判定证明目标确实不存在才算清理成功，其余失败记入既有的 `cleanup_failed` 标志位；`probe-sandbox.sh:89` 的 `docker kill … || true` 改为 kill 失败后用同一只读 inspect 判定：容器已不在或 `State.Running` 为 `false` 放行，否则记入 `note_cleanup_failure`）、Legacy compatibility / examples（两脚本的成功路径、`cleanup_failed` 置位后函数仍返回 0、由 `cleanup()` 把 `probe_status` 置 1 决定最终退出码（`probe-sandbox.sh:58`、`probe-dsh-api.sh:85`、`probe-first-run.sh:120`）、`probe_run_bound` 的超时边界、`set -euo pipefail` 纪律、shellcheck 通过与 `probe-dsh-api.sh`/`probe-first-run.sh` 对 `probe_remove_owned` 的调用方式不变；`agree: 仅验证脚本`，compact 维持）、Auth / permissions / secrets（探针仍只对自己登记的名字做删除，inspect 只读，不触及凭据）；not selected - Public API、Config、Schema、File IO、Concurrency、Resource limits、Release（都不触及：只改验证脚本的清理判定）、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `scripts/*.sh` 与 `platform/test/`）。
Evidence (6.1 shell-probes): **现状**：`scripts/probe-sandbox.sh:42-48` 的 `note_cleanup_failure`（`:42`，单行，赋值 `cleanup_failed=1` 后返回 0）与 `remove_owned` 在 `docker <kind> -f <target>` 非零时按 stderr 含 `No such container`/`No such image` 放行；`scripts/probe-dsh-api-lifecycle.sh:89-98` 的 `probe_remove_owned` 同形（`probe_note_cleanup_failure` `:69-72` 同样只置 `cleanup_failed=1` 并返回 0）；`:100-120` 的 `probe_scrub_binds` 对 `docker run --rm` 按 `No such image`/`Unable to find image` 放行、对 `:115-120` 的 `docker rm -f "$helper"` 按 `No such container` 放行；`probe-sandbox.sh:89` 的 `docker kill "$container" >/dev/null 2>&1 || true` 丢弃 kill 失败。这些裸 `docker` 调用不经 `runDockerCommand`，不产生 custody submission，只违反规格字面（#374 已注明）；`probe_run_bound`（`scripts/probe-dsh-api-lifecycle.sh:59`）调用 GNU `timeout --foreground --kill-after=5`；`wait_for_container`（`probe-sandbox.sh:83`）调用 `timeout --foreground "$timeout_seconds"`（无 `--kill-after`）；`probe-sandbox.sh` 只定义 `timeout_seconds`（`:17`），没有 `docker_seconds`。**改动点**（只改 `scripts/probe-sandbox.sh`、`scripts/probe-dsh-api-lifecycle.sh`，新增 `platform/test/probe-cleanup.integration.test.ts`；不改 `probe-dsh-api.sh`/`probe-first-run.sh` 的调用、不改产品代码）：(1) 两个脚本各新增只读函数 `probe_absent kind target`（sandbox 里叫 `absent`；同一判定，镜像自 `isAbsentResource`，sandbox 是独立脚本不加载 lifecycle 库，故各写一份）：`kind` 为 `rm` → `docker container inspect --format '{{.Id}}' "$target"`，`rmi` → `docker image inspect --format '{{.Id}}' "$target"`；lifecycle 里经 `probe_run_bound "$docker_seconds"` 运行，sandbox 里经同样的 `timeout --foreground --kill-after=5 "$docker_seconds"`，并在 `probe-sandbox.sh:35-40` 的变量区、`workdir=""` 之前新增 `docker_seconds=30`（与 `probe-dsh-api.sh:68` 同值；`set -u` 下未定义会在 EXIT trap 的 `cleanup()` 中炸掉）；stdout 与 stderr 分开捕获（`{ out=$(…); } 2>"$errf"` 或两个临时文件），不用 `2>&1` 合并判断；仅当状态码恰为 1、stdout 为空、stderr 去掉末尾换行后恰等于 `Error response from daemon: No such <container|image>: <ref>` 或 `Error: No such <container|image>: <ref>`（`rmi` 时若 `target` 不含 `:` 则 `<ref>` 为 `<target>:latest`，Docker 29.1.3 对未打 tag 的镜像如此报告；其他情况 `<ref>` 即 `target`）时返回 0；其余（inspect 成功=对象仍在、别的名字、其他错误、超时）返回 1。(2) `remove_owned`/`probe_remove_owned`：`docker <kind> -f` 非零时不再看自己的 stderr，改为 `probe_absent "$kind" "$target" && return 0`，否则 `note_cleanup_failure`/`probe_note_cleanup_failure`（保留原 message 形式，函数仍返回 0）。(3) `probe_scrub_binds`：`docker run --rm` 非零时改为 `probe_absent rmi "$image"` 放行，否则记入 `scrub bind dirs`；`docker rm -f "$helper"` 非零时改为 `probe_absent rm "$helper"` 放行，否则记入 `docker rm -f <helper>`。(4) `probe-sandbox.sh:89`：`docker kill "$container" >/dev/null 2>&1 || kill_failed=1`，随后若 `kill_failed` 则 `absent rm "$container"` 或经同一超时的 `docker container inspect --format '{{.State.Running}}'` 输出恰为 `false` 放行（容器在 `docker wait` 超时的同时刚好退出是合法竞态），否则 `note_cleanup_failure "docker kill ${container}"`；函数的返回值仍是原来的 `wait_status`/124。**Docker-free 回归**（`probe-cleanup.integration.test.ts`：用 `bash` 以 `.` 方式加载 `probe-dsh-api-lifecycle.sh`（本就是被 `.` 的库）；`probe-sandbox.sh` 的函数段用 `eval "$(sed -n '/^note_cleanup_failure()/p; /^absent()/,/^}/p; /^remove_owned()/,/^}/p; /^wait_for_container()/,/^}/p' scripts/probe-sandbox.sh)"` 提取，不执行脚本主体（`:42` 是单行函数，只能用单行地址：`sed` 对落在多个范围内的行会重复打印，`/^}/` 范围会把下一个函数的每一行打印两次，`absent` 加入后 `case` 重复导致 `eval` 语法错误；Darwin `/bin/bash` 3.2 下 `source <(…)` 不定义函数，故用 `eval`）；测试头先 `set -euo pipefail` 并赋值 `repo_root=<仓库根>`（变量区 `:34` 引用它）、`probe_name`、`cleanup_failed=0`、`timeout_seconds`，lifecycle 用例赋 `docker_seconds=5`；sandbox 用例不在测试头赋 `docker_seconds`，而是把变量区（`sed -n '/^run_id=/,/^workdir=""/p'` 抽取，不按行号）一起 `eval` 进来并断言抽取出的定义含 `docker_seconds=30`（证明脚本自己定义了它）；PATH 前置一个临时目录，内含桩 `docker`（按 argv 记录调用并按用例脚本化返回）与桩 `timeout`（`docker wait` 那一次断言收到 `--foreground <timeout_seconds>`，其余断言 `--foreground --kill-after=5 <docker_seconds>`，然后丢弃选项与秒数并 `exec` 余下参数；Darwin 无 GNU `timeout`，没有它红/绿循环跑不起来）：(a) 红证据：桩让 `docker rm -f x` 以状态 1 和 stderr `Error response from daemon: No such container: x` 失败，且让 `docker container inspect x` 成功（返回一个 id，模拟「删除报不存在但对象仍在」）→ 改后 `probe_remove_owned rm x` 必须记入清理失败（`cleanup_failed=1`，函数返回 0），改前它按子串放行且 `cleanup_failed` 仍为 0；(b) `rm -f` 失败且 `inspect` 以状态 1 失败、stderr 为两种前缀之一的 `No such container: x` → 放行且 `cleanup_failed` 仍为 0，桩记录到恰好一次 inspect（两种前缀各一例）；(b2) inspect 状态 1 但 stderr 为 `No such container: other`（别的名字，`container-start-lifecycle.integration.test.ts:143` 的先例）→ 记入失败；(c) `rm -f` 成功 → `cleanup_failed` 为 0 且无 inspect 调用；(d) `rm -f` 以其他错误失败且 inspect 成功 → 记入失败；(d2) `rmi -f y`（无 tag）失败且 `image inspect y` 状态 1、stderr `Error response from daemon: No such image: y:latest` → 放行；(e) `probe_scrub_binds` 的 `run --rm` 失败且 stderr 含 `Unable to find image`、`image inspect` 状态 1 报 `No such image: <image>:latest` → 放行；`run --rm` 失败且 stderr 含 `Unable to find image` 但 `image inspect` 成功 → 记入 `scrub bind dirs`（红）；(e2) helper：`docker rm -f <helper>` 失败且 stderr 含 `No such container`、inspect 成功 → 记入 `docker rm -f <helper>`（红）；(f) `probe-sandbox.sh` 的 `remove_owned` 用同样的 (a)(b) 两例（(a) 形为红）；(g) `docker kill` 失败路径：桩 `docker wait` 返回非零、`docker kill` 返回非零、`container inspect --format '{{.State.Running}}'` 输出 `true` → 调用 `wait_for_container c || st=$?`，断言 `st` 等于桩 `wait` 的状态码、kill 的 argv 被记录、`cleanup_failed=1`（红）；(g2) 同上但 inspect 输出 `false` → `cleanup_failed` 仍为 0。每个用例断言桩记录的 argv 序列（例如 `['rm','-f','x']` 后紧跟 `['container','inspect','--format','{{.Id}}','x']`）。**Red first**：先只写 (a)、(e) 第二例、(e2)、(f) 的 (a) 形与 (g)（规格要求每个被容忍的调用点先红），对改前脚本全部红；再改脚本并补其余用例转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm lint:shell`（shellcheck）与 `pnpm check` 通过；信任主机上运行 `pnpm probe:sandbox` 与 `pnpm probe:first-run`（不调用模型；`probe:dsh-api` 需要 `DMXAPI_KEY`，属单独授权的模型通道，不用）的真实清理路径通过且 owned 资源缺席（这两脚本只在探针命令里执行，不在 `pnpm test:docker` 发现范围内，PR 如实写明）；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed（证明未破坏其他路径）。Must preserve：两脚本的参数约定、`probe_run_bound` 的 `timeout --foreground --kill-after=5` 与 `wait_for_container` 的 `timeout --foreground "$timeout_seconds"` 两种形式、`cleanup_failed` 语义（置位后函数返回 0，最终退出码由 `cleanup()` 置 `probe_status=1` 决定）、`probe-dsh-api.sh`/`probe-first-run.sh` 的 `probe_remove_owned` 包装、`wait_for_container` 的返回值、产品代码、AGENTS.md。残留风险（PR 写明）：`No such` 文本依赖 Docker CLI 的错误格式，但它现在只用于「inspect 说不存在」这一只读判断，且与 `isAbsentResource` 同样严格；inspect 自身的瞬时失败或超时会被记为清理失败（宁可误报不漏报）；每次删除失败多一次有超时上限的 inspect。
Risk packs (6.1 deployment-privacy-fixture): selected - Error handling（本机模型桩的就绪等待不再把变更型 `docker exec` 放进会吞错重试的 `expect.poll`：宿主侧只发一次 `exec`，容器内脚本自己轮询健康端点直到就绪或超时；该 `exec` 非零即用例失败，不重试）、Concurrency（桩进程 `exec --detach` 启动后到监听 3099 之间的窗口由容器内轮询覆盖，10s 预算不变）、Legacy compatibility（`verifyDeployedCredentialPrivacy` 其余步骤、三个消费者——Docker 用例 `deployment-audit-stop.docker.test.ts` 与 `deployment.docker.test.ts`，以及 Docker-free 的 `deployment-setup.integration.test.ts:37,73`（它加载本 fixture 模块并在 host admission 阶段失败，到不了就绪等待，但新模块的 import 必须不破坏它）——以及 `run`/`privatePlatformRead` 的非零即抛语义不变）、Security（就绪脚本只读 `http://127.0.0.1:3099/health`，输出只含 `ready` 布尔，不含密钥）；not selected - Public API、Auth、Config、Schema、File IO、Resource limits、Release、Documentation（AGENTS.md 无需改动）。无关键路径文件（只改 `platform/test/`）。
Evidence (6.1 deployment-privacy-fixture): **现状**：`platform/test/deployment-privacy-fixture.ts:276-293`：`run(['exec','--detach','dsh-team-platform','node','/verification/model.ts', …])` 启动本机模型桩后，`expect.poll(async () => platformRead("const r=await fetch('http://127.0.0.1:3099/health');…"), { timeout: 10_000 })` 轮询；`platformRead` → `privatePlatformRead(run, script)`（`:198-211`，`docker exec dsh-team-platform node --input-type=module -e <script>`，经 `lifecycle.commandAsync` → `runDockerCommand` 登记为 `cli exec`），`run`（`:246-251`）对非零抛 `Private observation failed`。桩尚未监听时首次 fetch 抛错、exec 非零、`run` 抛错被 `expect.poll` 吞掉重试，首次 exec 的 submission 永不结算（#469 正文：PR #467 lane `0347d644…` 的唯一未结行 `{cli, exec, deployment-audit-stop.docker.test.ts}`）。**改动点**（只改 `deployment-privacy-fixture.ts` 的 `:285-293`，新增 `platform/test/local-model-readiness.ts` 与 `platform/test/local-model-readiness.integration.test.ts`；不改产品代码、不改 `run`/`privatePlatformRead`）：(1) 新模块导出 `LOCAL_MODEL_READY_SCRIPT`（容器内脚本字符串，ESM，`--input-type=module`）：以 `performance.now()` 计 10s 截止，脚本形状（ESM `-e` 脚本禁止顶层 `return`，Node 24 下 `process.exitCode = 0; return;` 是 `SyntaxError: Illegal return statement`，所以用标志加 `break`）：`let ready = false; const deadline = performance.now() + <deadlineMs>; while (performance.now() < deadline) { const remaining = Math.max(1, Math.ceil(deadline - performance.now())); try { const r = await fetch(<origin>/health, { signal: AbortSignal.timeout(remaining) }); const body = await r.json(); if (body && body.ready === true) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); } process.stdout.write(JSON.stringify({ ready })); process.exitCode = ready ? 0 : 1;`——`origin` 用 `JSON.stringify` 嵌入；每次 fetch 带 `AbortSignal.timeout(remaining)` 使一个被接受但永不响应的连接也受 10s 截止约束；用 `process.exitCode` 自然退出而不是 `process.exit()`，保证 stdout 管道写完；成功与超时都只写一次 JSON——容器内的 fetch 失败是桩未就绪的正常状态，不是 Docker 变更失败，所以允许在同一个 exec 内重试；和导出 `awaitLocalModelReady(read: (script: string) => Promise<Record<string, unknown>>): Promise<void>`：恰好调用一次 `read(LOCAL_MODEL_READY_SCRIPT)`；`read` 拒绝时原样抛出（`read` 拒绝即 exec 非零，含超时退出），返回值的 `ready` 不为 `true` 时抛 `new Error('Local model stub not ready')`（最终模块不 import vitest，像兄弟模块一样抛普通 `Error`）；没有宿主侧重试。(2) 用例改动：`:285-293` 的 `await expect.poll(…).toMatchObject({ ready: true })` 改为 `await awaitLocalModelReady(platformRead)`；其余不动（`:314-315` 的第二次 `/health` 读取不在 poll 里，保持原样）。**Docker-free 回归**（`local-model-readiness.integration.test.ts`）：(a) 红证据：桩 `read` 第一次拒绝 `new Error('Private observation failed')`、之后 resolve `{ ready: true }` → `await expect(awaitLocalModelReady(read)).rejects.toThrow('Private observation failed')` 且 `read` 恰好调用 1 次（改前的 `expect.poll` 版本会重试到第二次并 resolve，调用 2 次）；(b) `read` resolve `{ ready: true }` → resolve，调用 1 次，且传入的脚本 `toBe(LOCAL_MODEL_READY_SCRIPT)`；(c) `read` resolve `{ ready: false }` → reject `Local model stub not ready`，调用 1 次（生产路径上超时以 exit 1 结束、`run` 在 `JSON.parse` 前就抛，所以这是 helper 的后置条件保护，不是可达的生产场景）；(d) 脚本本身的 Docker-free 执行（服务器与子进程必须异步：loopback `node:http` 服务器跑在同一个 vitest worker 里，`spawnSync` 会阻塞事件循环使服务器永远不响应、vitest 超时也无法触发，所以用异步 `spawn(process.execPath, ['--input-type=module', '-e', script])`，收集 stdout 并 `await` 其 `close`，外层用 `AbortSignal.timeout(5_000)` 之类的 `signal`/`timeout` 选项兜底）：模块导出 `localModelReadyScript(origin = 'http://127.0.0.1:3099', deadlineMs = 10_000)` 以便注入，`LOCAL_MODEL_READY_SCRIPT = localModelReadyScript()`；(d1) 延迟监听：先 `listen(0, '127.0.0.1')` 读出 `address().port` 后 `close()` 取得空闲端口，用该 origin 启动子进程，自 spawn 起固定延迟（例如 500ms，长于子进程启动）后再在同一端口 `listen`；监听后先返回 503 一次再返回 `{"ready":true}` → 退出 0、stdout 恰为 `{"ready":true}`，服务器收到恰好 2 次请求（只统计 `listen` 之后的请求）；ECONNREFUSED 窗口由这个构造覆盖而非断言——父进程看不到被拒绝的连接；(d2) 始终 503 的服务器、`deadlineMs` 传 300 → 退出 1、stdout `{"ready":false}`；(d3) 接受连接但永不响应的服务器（`server.on('request', () => {})`）、`deadlineMs` 传 300 → 退出 1、stdout `{"ready":false}`，证明单次 fetch 受截止约束而不是等 undici 默认 300s；teardown 先 `server.closeAllConnections()` 再 `close()`，否则 `close()` 会等挂着的 socket。**Red first**：第一步新建模块但 `awaitLocalModelReady` 保留现状语义（内部用 `expect.poll` 包 `read`，`timeout: 10_000`），把 fixture 改为调用它，只写 (a)，运行 `pnpm test:integration platform/test/local-model-readiness.integration.test.ts` → (a) 红（resolve 且调用 2 次）；第二步改为单次 `read` 并补 (b)–(d) 转绿；PR 描述贴出两次输出。验证：该集成测试通过；`pnpm test:integration platform/test/deployment-setup.integration.test.ts` 通过（第三个消费者不受新 import 影响）；`pnpm check` 通过（knip：新导出被 fixture 与集成测试引用）；VPS 窄跑 `pnpm test:docker platform/test/deployment-audit-stop.docker.test.ts platform/test/deployment.docker.test.ts` 与 `pnpm test:deploy` 通过且 owned inventory 为空；exact-head 全量 `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed。Must preserve：`verifyDeployedCredentialPrivacy` 其余阶段与 `progress.phase` 记录、`run`/`privatePlatformRead`、三个消费者（两个 Docker 用例与 `deployment-setup.integration.test.ts`）、产品代码、AGENTS.md。残留风险（PR 写明）：容器内 `fetch` 在 Node 24 的平台镜像里可用（`privatePlatformRead` 现有脚本已用 `fetch`）；就绪脚本的 10s 预算与原 `expect.poll` 相同，但现在超时表现为一次 exec 非零退出 + `{ ready: false }`，用例失败文本为 `Private observation failed`；超时路径上这唯一一次 exec 的 submission 同样不结算，但用例同时失败，不属于被容忍的变更。

## 7. 技术债 #352：未结 submission 的归因投影

依赖：无。由现有 issue #352 承载，处理方式同第 6 组。#352 以交付归因能力关闭，根因在复现之前仍为 UNKNOWN。

- [x] 7.1 清理因为有未结 submission 而判为 unconfirmed 时，私有终态的 `cleanup` 附带有界投影：每个调用标签及其计数，未带标签的计入 `unlabelled`。投影不含 ID、参数和路径；判定本身不变；清理已确认时不出现投影。验证：用 Docker-free 的 fixture 覆盖有投影、无投影和超过上限三种情况。
- [x] 7.2 `scripts/trusted-docker-record.mjs:214` 的终态解析接受这个可选键，旧终态和清理已确认的终态照常解析。验证：解析器的集成测试覆盖新、旧两种形状，以及非法形状的拒绝。

Suggested fixture level: compact - 私有证据格式扩展，不影响判定
Minimal mergeable slice: 7.2 解析器先接受可选键单独合入（还没有写入方之前行为不变）
Risk packs (7.2): selected - Schema（私有终态 `cleanup` 的可选键形状由本任务定义并被解析器钉死：封闭字段、有界条数、标签三元组复用日志写入方的封闭词表校验，不含 ID/参数/路径）、Legacy compatibility（没有该键的旧终态与 cleanup confirmed 的终态照常解析；`hasPassingOutcome`、`validateTerminal` 的其余判定与错误文本不变）、Error handling（非法形状一律拒绝：confirmed/not-started 时出现该键、多余字段、非法计数、超过上限、重复标签、词表外的 operation、非法 caller）；not selected - Public API、Auth、Config、File IO、Concurrency、Resource limits、Release、Documentation（AGENTS.md 已描述 `call` 标签词表；写入方归 7.1/#352）。无关键路径文件。
Evidence (7.2): **形状定义**（本任务是第一个定义者，7.1 的写入方必须照此生成）：`cleanup.unsettled`，可选；仅当 `cleanup.state === 'unconfirmed'` 时允许出现；值为 `{ labels: Array<{ transport: 'cli' | 'http', operation: string, caller: string, count: number }>, unlabelled: number, truncated: boolean }`，三个键都必须出现且不得有其他键。`labels` 最多 32 项；每项恰有 `transport`/`operation`/`caller`/`count` 四个键，前三者组成的三元组（新建的只含 `transport`/`operation`/`caller` 三键的对象，不能把带 `count` 的四键标签直接传入）必须通过 `scripts/verification-submission-storage.mjs:462` 已导出的 `requireSubmissionCall`（CLI 动词/组子命令或 HTTP `方法 模板` 封闭词表，caller 为 `^[a-z0-9][a-z0-9.-]*\.(?:ts|mts|mjs)$` 或 `unknown`；HTTP 模板含空格与 `/`，所以不另设字符类），按三元组去重且不得重复；`count` 为正安全整数；`unlabelled` 为非负安全整数；`truncated` 为布尔，语义：写入方发现不同三元组多于 32 个时只保留前 32 个（按日志首次出现顺序）并置 `truncated: true`，被截掉的计数不并入任何项；解析器据此要求 `truncated === true` 时 `labels.length === 32`；`labels` 为空时 `unlabelled` 必须大于 0。写入方注意（7.1）：`reserveSubmission`（`scripts/verification-submission-storage.mjs:211-224`）先建 pending 标记、再追加 `submitted` 行，只有标记没有日志行的未结预留计入 `unlabelled`。`requireTerminalFields` 的 `cleanup` 字段表改为 `['state', 'browserExec', 'unsettled']`（`scripts/trusted-docker-record.mjs:214`；该表只约束键集合，`unsettled` 仍可缺省），新增 `validateUnsettledProjection(cleanup)` 在 `validateTerminal`（`:298-318`）中于 `Invalid trusted Docker terminal outcome` 的封闭集检查（`:310-315`）之后、`hasPassingOutcome` 一致性检查之前调用，使非法 `state`/`interruption`/`failure` 仍先报原有文本：键不存在时直接返回；`state !== 'unconfirmed'` 而键存在、或形状不符（含 `requireSubmissionCall` 抛错）时抛固定文本 `Invalid trusted Docker unsettled projection`（`cause` 保留原错误）。`trusted-docker-record.mjs` 新增对 `./verification-submission-storage.mjs` 的导入（该模块只导入 Node 内建，无环）。`hasPassingOutcome`、`validateCleanupOutcome`（`browserExec` 规则）、`Trusted Docker terminal identity changed`/`Invalid trusted Docker terminal outcome`/`Inconsistent trusted Docker terminal outcome` 的判定不变。`scripts/verification-submission-assessment.mjs:22` 的 `CleanupAssessment` typedef 增加可选 `unsettled` 字段（仅注释类型 `UnsettledProjection`，无运行时改动；该文件的写入逻辑不动）。**测试**（`platform/test/trusted-docker-custody.integration.test.ts` 的 `validateTerminal` 用例旁，复用其现有的合法终态构造；(b)–(e) 的 unconfirmed/not-started 终态使用 `browserExec: null`，否则 `validateCleanupOutcome` 先报 `Invalid trusted Docker browser exec projection`）：(a) 旧形状（无 `unsettled`）confirmed 与 unconfirmed 终态照常通过；(b) unconfirmed + 合法投影（一个 `cli` 标签 `{transport:'cli', operation:'network create', caller:'deployment.docker.test.ts', count:2}`、一个 `http` 标签 `{transport:'http', operation:'POST /containers/{id}/start', caller:'unknown', count:1}`、`unlabelled: 1`、`truncated: false`）通过且返回值原样含该键；(c) confirmed + 投影 → 拒绝；not-started + 投影 → 拒绝；(d) 非法形状逐个拒绝：`unsettled` 多余字段、缺少 `truncated`、`labels` 非数组、33 项、重复三元组、标签多余字段、`count` 为 0/负/非整数、`unlabelled` 为负、`truncated` 非布尔、`truncated: true` 但 `labels` 不足 32 项、`operation` 不在词表（如 `POST /containers/{id}/exec/start`）、`caller` 含 `/`、`transport` 不在词表、`labels` 为空且 `unlabelled` 为 0；每个用例断言错误文本为 `Invalid trusted Docker unsettled projection`，且 (c)/(d) 的每个终态去掉 `unsettled` 键后，通过或失败的结果与改动前一致（可观测的「其余判定不变」）。(e) `hasPassingOutcome` 对带投影的 unconfirmed 终态仍为 false，且 `state: 'passed'` 与它组合仍报 `Inconsistent trusted Docker terminal outcome`。**Red first**：先写用例 (b)，对未改的解析器它以 `Invalid trusted Docker terminal fields` 失败（`:214` 的键集合检查），再实现转绿；PR 描述贴出两次输出。验证：`pnpm test:integration platform/test/trusted-docker-custody.integration.test.ts` 通过；`pnpm check` 通过（含 knip：新函数只被 `validateTerminal` 引用，不导出）；exact-head VPS `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed（CI 证据门要求；解析器只放宽一个可选键，现有终态不受影响）。Must preserve：`scripts/trusted-docker-record.mjs` 其余导出与错误文本、`verify:docker status/cancel/logs` 的行为（`trusted-docker-owner.mjs:402` 原样透传 `result.cleanup`，本切片没有写入方所以输出不变；7.1 合入后 status 输出会带上投影，属预期）、`platform/test/trusted-docker-*.ts` 既有用例；不改写入方（7.1）、不改 `verification-submission-storage.mjs`、不改 AGENTS.md。
Risk packs (7.1): selected - Schema（写入方生成的 `cleanup.unsettled` 必须逐字满足 7.2 已钉死的形状：三键、≤32 项、四键标签、三元组去重、`truncated` 语义、空 `labels` ⇒ `unlabelled > 0`；本任务不改解析器）、Error handling（投影只随「有未结 submission / 残留 pending 标记」这一种 unconfirmed 原因出现；身份/权限/格式错误导致的 unconfirmed 保持两键形状；计算投影本身不得把 unconfirmed 变成别的错误或 confirmed）、Legacy compatibility（无 `call` 的旧行计入 `unlabelled`；confirmed 与 not-started 终态无该键；`freshSubmissionAssessment` 的 `{state}` 输出、`readVerificationWritersBeforeRetirement`、`trusted-docker-retirement.mjs` 的 `requireSettled` 与 8 MiB 日志上限不变）、Security（投影只含已通过 `requireSubmissionCall` 的封闭词表标签与计数，不含 id、参数、资源名、路径、环境值；pending 标记文件内容不读取）、Documentation（AGENTS.md「Trusted Docker verification」节补一句投影说明，由 orchestrator 改）；not selected - Public API（新导出的错误类只在 `scripts/` 内被一个调用方使用）、Auth、Config、File IO（只多一次对已在读取的 pending 目录的受保护 readdir）、Concurrency、Resource limits、Release。无关键路径文件。
Evidence (7.1): **现状**：`readVerificationSubmissionsForCleanup`（`scripts/verification-submission-assessment.mjs:171-185`）在 `:178`（有行的最终状态不是 `settled`/`client-closed-unknown`）和 `:181`（pending 目录非空）抛裸 `Error('Verification submission settlement unconfirmed')`；`parseSubmissionRecords`（`:76-92`）用 `requireSubmissionCall` 校验 `call` 后丢弃标签；`assessTrustedDockerCleanup`（`scripts/trusted-docker-audit.mjs:227-267`）对 `!settled` 和 `catch {}` 里的任何失败都返回 `{ state: 'unconfirmed', browserExec: null }`；owner 原样透传 `cleanup`（`scripts/trusted-docker-owner.mjs:324-329`、status `:402`），终态由 7.2 的 `validateTerminal` 校验。**改动点**（只改 `scripts/verification-submission-assessment.mjs`、`scripts/trusted-docker-audit.mjs`、`platform/test/submission-call-evidence.integration.test.ts`、`platform/test/trusted-docker-audit.integration.test.ts`、`platform/test/browser-exec.integration.test.ts`、`platform/test/docker-client.integration.test.ts`（后两者只改既有的评估/错误期望；`deployed-docker-observer.integration.test.ts` 核对后不需改动）、`platform/test/trusted-docker-audit-fixture.ts`（仅类型）、`scripts/verification-submission-storage.mjs` 与 `scripts/trusted-docker-record.mjs`（仅为上限常量：`UNSETTLED_LABEL_LIMIT = 32` 唯一定义并导出于 storage 模块，record 与 assessment 两个模块改为导入，解析器逻辑不动）；AGENTS.md 由 orchestrator 改）：(1) `SubmissionRecords` 增加 `calls: Map<string, SubmissionCall>`，`parseSubmissionRecords` 把 `requireSubmissionCall` 返回的新建标签按行 id 存入（只有 `submitted` 行带 `call`）。(2) 新增导出 `class UnsettledSubmissionsError extends Error`：message 逐字为 `Verification submission settlement unconfirmed`，自有属性 `unsettled`（类型 `UnsettledProjection`），不改 `name`。(3) 新增非导出 `unsettledProjection(records, markerNames)`：未结集合 = 最终状态为 `submitted` 的 id ∪ 从标记文件名解析出的 id（文件名形如 `<uuid>` 或 `<generation-uuid>.<uuid>`，取末尾 uuid；解析不出的文件名按一条 `unlabelled` 预留计数，不做推断）。按 `records.states` 的插入顺序（即日志首次出现顺序；`Map.set` 覆盖已有键不改变位置）遍历：未结且 `calls` 有标签 → 键 `JSON.stringify([transport, operation, caller])`，已有则 `count += 1`，没有且 `labels.length < 32` 则 push `{ transport, operation, caller, count: 1 }`，没有且已满则 `truncated = true`（该计数丢弃）；未结且无标签 → `unlabelled += 1`；日志中不存在的标记 id（只有标记没有日志行的预留，对应 `reserveSubmission` 先建标记后追加行的顺序）与解析不出的文件名 → `unlabelled += 1`。返回 `{ labels, unlabelled, truncated }`（键按此顺序）。有至少一个未结项时必然 `labels.length > 0 || unlabelled > 0`，与解析器的空 `labels` 规则一致。(4) `readVerificationSubmissionsForCleanup`：`:178` 改为 `throw new UnsettledSubmissionsError(unsettledProjection(records, pendingNames()))`，其中 `pendingNames()` 只在这个抛错分支里执行一次受保护的 `readdirSync(join(directory, SUBMISSION_PENDING))`，任何异常时取 `[]`（只为投影提供名字，不参与判定；`:179` 的 `captureAuthority` 复核位置不动）；`:180` 自己的、不受保护的 `readdirSync` 原样保留为结算判定（它抛错时仍走原路径进 `assessTrustedDockerCleanup` 的 catch），`:181` 改为用 `:180` 已成功列出的名字抛同一类错误。函数其余逻辑不变；`requireVerificationSubmissionsSettled`（`:192-197`）不变，其 `browserExec.length !== 0` 分支仍抛裸 `Error`。(5) `assessTrustedDockerCleanup` 的 `catch {}` 改为 `catch (error) { return error instanceof UnsettledSubmissionsError ? { state: 'unconfirmed', browserExec: null, unsettled: error.unsettled } : { state: 'unconfirmed', browserExec: null }; }`；`!settled` 提前返回与 confirmed 返回值不变（confirmed/not-started 永远没有 `unsettled` 键）。(6) `platform/test/trusted-docker-audit-fixture.ts:22-25` 的 `assess` 返回类型加可选 `unsettled?: unknown`（仅类型）。(7) AGENTS.md（orchestrator）：在以「labels never change settlement.」结尾的段落后追加一句：投影的出现条件、每标签计数、32 上限与 `truncated`、`unlabelled` 含义（无标签行与只有标记的预留）、不含 id/参数/路径、不改判定。**Docker-free 回归**（`platform/test/submission-call-evidence.integration.test.ts`，放在 `assesses a mixed journal with an unresolved older row exactly as before` 用例旁；日志行用该文件已有的 `lines()`/`pair()`；pending 标记用 `writeFileSync(join(directory, SUBMISSION_PENDING, name), '', { mode: 0o600, flag: 'wx' })` 直接创建；评估路径用 `./trusted-docker-audit-fixture.ts` 的 `withAuditReceipt`，其 `directory = join(journal, '..')`，日志追加到 `join(directory, SUBMISSION_JOURNAL)`）：(a) 有投影：日志依次为 `pair(KILL)`（已结）、两条不同 id 的未结行 `call: A`（`{transport:'cli', operation:'network create', caller: SELF}`）、一条未结行 `call: B`（`{transport:'http', operation:'POST /containers/{id}/start', caller:'unknown'}`）、一条无 `call` 的未结旧行、一条 `call: C`（`{transport:'cli', operation:'rm', caller:'x.mjs'}`）的已结对但保留其宿主侧标记 `<id>`；另建只有标记的预留 `<uuid>` 和观察者作用域的 `<uuid>.<uuid>` 各一个 → 期望 `{ labels: [{...A, count: 2}, {...B, count: 1}, {...C, count: 1}], unlabelled: 3, truncated: false }`。断言：`readVerificationSubmissionsForCleanup` 抛出的错误 message 逐字相同、`toBeInstanceOf(UnsettledSubmissionsError)`、其 `unsettled` `toStrictEqual` 期望；`JSON.stringify(unsettled)` `not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-/)`（未锚定的 UUID 片段；该文件锚定的 `ID` 正则对整段序列化永远不匹配，不能用）；`await assess()` `toStrictEqual({ state: 'unconfirmed', browserExec: null, unsettled: 期望 })`；`freshSubmissionAssessment(directory)` 仍为 `{"state":"unconfirmed"}\n`；`readVerificationWritersBeforeRetirement(directory, new Set())` 仍为 `[]`。(b) 无投影：(b1) 全部已结（`pair(KILL) + pair()`）→ `await assess()` `toStrictEqual({ state: 'confirmed', browserExec: null })`；(b2) 同一日志 `await assess(false)` → `toStrictEqual({ state: 'unconfirmed', browserExec: null })`；(b3) 格式错误行（`call.caller` 为 `'../x.ts'`）→ `readVerificationSubmissionsForCleanup` 抛的不是 `UnsettledSubmissionsError`，`await assess()` `toStrictEqual({ state: 'unconfirmed', browserExec: null })`。(a) 与 (c-33) 另外各把写入方的真实输出交给 7.2 解析器：用 `trusted-docker-custody.integration.test.ts` 中已有的合法终态构造方式组一个 `state: 'failed'`、`cleanup: { state: 'unconfirmed', browserExec: null, unsettled }` 的终态（`unsettled` 取 `assess()` 或错误对象上的真实投影），断言 `validateTerminal` 返回它且不抛（写入方与解析方的 `truncated ⇒ 32 项`、空 `labels ⇒ unlabelled > 0` 两条约束由测试兜底，不只靠推理）。(c) 超上限：33 个不同三元组的未结行按日志顺序（`cli`/`rm`，`caller` 为 `c0.ts`…`c32.ts`），其中第 33 个重复 5 次 → `labels.length === 32`、顺序与日志一致、`labels[31].caller === 'c31.ts'`、无 `c32.ts`、`truncated: true`、`unlabelled: 0`；同样写法 32 个不同三元组 → 32 项且 `truncated: false`。**既有断言的调整**（规则：评估时日志仍有最终状态为 `submitted` 的行或 pending 目录非空，且 `captureAuthority` 通过 ⇒ 带投影的 `toStrictEqual`，投影按改动点 (3) 的算法手算并断言完整对象；否则两键的 `toStrictEqual`）。`platform/test/trusted-docker-audit.integration.test.ts`：`rejects changed submission authority %s` 的 `expect(await assess()).toEqual(...)`（`:358`）——这 12 种故障的写入方是无参 `beginVerificationSubmission()`（`:308`），行不带 `call`，所以投影的 `labels` 为空：`marker-replaced`（pending 里留下 `<id>` 与 `<id>.retired` 两个文件，后者解析不出）→ `{ labels: [], unlabelled: 2, truncated: false }`；`marker-missing`、`marker-malformed`、`anchor-changed`（锚点被原地覆盖，inode/mode 不变，新进程的 `captureAuthority` 没有 `captured.text` 可比且新 invocation 是合法 UUID，所以通过并走到 `:178`）→ `{ labels: [], unlabelled: 1, truncated: false }`；其余八种在 `captureAuthority` 处先失败 → 两键。同文件 `:187`（exit 表里 unconfirmed 的行：`exec` 留下带标签的未结行）、`:538`（`success`/`qualified-rejection` 残留标记，走 `:181`）与其余 `assess()` unconfirmed 期望（`:31`、`:42`、`:62`、`:85`、`:97`、`:114`、`:117`、`:381`、`:553`、`:564`、`:581`、`:626`）、`platform/test/browser-exec.integration.test.ts:426`（前面 `ordinarySubmission(journal, true)` 留下带 `{cli, network create, unknown}` 标签的未结行）、`:472`、`:498`（fsync 失败后标记残留，`browserExec` 行无 `call` → `unlabelled: 1`）以及 `platform/test/deployed-docker-observer.integration.test.ts:733`（预期仍为两键）按同一规则逐个核对；同样的规则也适用于直接比较抛出错误对象的断言：`platform/test/docker-client.integration.test.ts:321-323` 在请求在途时捕获 `requireVerificationSubmissionsSettled` 的错误并 `toEqual(new Error(...))`，此时日志恰有一条带 `{http, <该用例的 operation>, docker-client.integration.test.ts}` 标签的未结行且其标记仍在（同一 id 只计一次），改为断言 `toBeInstanceOf(UnsettledSubmissionsError)`、message 逐字相同、`unsettled` `toStrictEqual({ labels: [{ transport: 'http', operation, caller: 'docker-client.integration.test.ts', count: 1 }], unlabelled: 0, truncated: false })`；仓库内其他对该错误对象做深比较的断言（`grep -rn "new Error('Verification submission settlement unconfirmed')" platform/test`，排除 `throw`）一并按规则处理（评估时日志仍有未结 `submitted` 行或 pending 残留且权威校验通过 ⇒ 带投影的 `toStrictEqual`，否则两键的 `toStrictEqual`；`toEqual` 不会忽略多出的已定义键，所以漏改会直接红），PR 描述逐条列出改动的既有断言及原因。**Red first**：先写 (a)，对未改的两个模块跑 `pnpm test:integration platform/test/submission-call-evidence.integration.test.ts`：(a) 以 `unsettled` 为 `undefined` 的 `toStrictEqual` 失败（红阶段 (a) 暂不写 `toBeInstanceOf(UnsettledSubmissionsError)` 与该导入，转绿时补上）；再实现并补 (b)(c) 与既有断言调整转绿；PR 描述贴出两次输出。验证：`pnpm test:integration platform/test/submission-call-evidence.integration.test.ts platform/test/trusted-docker-audit.integration.test.ts platform/test/browser-exec.integration.test.ts platform/test/deployed-docker-observer.integration.test.ts platform/test/docker-client.integration.test.ts platform/test/trusted-docker-custody.integration.test.ts` 通过；`pnpm check` 通过（knip：`UnsettledSubmissionsError` 被 `trusted-docker-audit.mjs` 引用）；exact-head VPS `pnpm test:docker` 与 `pnpm test:deploy` 通过且 cleanup confirmed（confirmed 运行的终态按定义不含投影，PR 如实写明；投影的真实出现只能等下一次偶发 unconfirmed）。Must preserve：unconfirmed/confirmed 的判定条件、`Verification submission settlement unconfirmed` 文本、8 MiB 上限、`freshSubmissionAssessment` 输出、`readVerificationWritersBeforeRetirement`、`trusted-docker-retirement.mjs` 的 `requireSettled`（子类仍是 `Error`）、日志/标记格式与 `verification-submission-storage.mjs` 的其余导出、`trusted-docker-record.mjs` 的解析逻辑与错误文本（只换常量来源）、`trusted-docker-owner.mjs` 的透传。残留风险（PR 写明）：`reserveSubmission` 在建标记与追加行之间崩溃的预留只能计入 `unlabelled`；根因仍为 UNKNOWN，本任务只提供归因投影。

## 8. 技术债 #348：e2e fixture 不在检出中写字节码缓存

依赖：无。由现有 issue #348 承载，处理方式同第 6 组。

- [x] 8.1 `platform/test/e2e-engine-fixture.py` 的 worker 在自己的进程内禁止写字节码：在 `worker_args` 里加 `-B`，或设置 `sys.dont_write_bytecode`。验证：Docker-free 的回归测试证明 `scripts/__pycache__` 从未被创建，且在修复前失败。
- [x] 8.2 验证：在 VPS 上跑完一次后，检出中没有未跟踪的文件；在同一检出上再执行一次 `verify:docker start <同一 SHA>`，可以被接受。

Suggested fixture level: compact - 单个 fixture 进程的参数
Minimal mergeable slice: atomic: 只有一处改动加一个回归测试
Risk packs (8.1–8.2): selected - File IO（fixture 以 root 运行时不得在检出内写任何文件：字节码缓存只能靠进程内设置禁止，`sudo` 的 `env_reset` 与外层 python 的 `-B` 都到不了 worker）、Legacy compatibility（fault 模式、身份核验、清理语义与 `e2e-engine.docker.test.ts` 的断言全部不变）；not selected - Config、Schema、Auth、Public API、Error handling、Concurrency、Resource limits、Release、Documentation（AGENTS.md 不改；`.gitignore` 不加 `__pycache__`，那只会掩盖检出被写入的事实）。
Evidence (8.1–8.2): 修复点——把 `worker()` 里的 `importlib.util.spec_from_file_location`/`exec_module` 三行提成模块级 `load_supervisor(repository)`，在 `exec_module` 之前设置 `sys.dont_write_bytecode = True`（进程内设置，经 `sudo -n` 与 `unshare --fork` 后仍有效；不选 argv `-B` 是因为同一函数要同时服务 Docker-free 回归）；`worker()` 改为调用它，其余逻辑逐字不变。Docker-free 回归——fixture 新增 dispatch 模式 `load-supervisor`（必须排在 `else: parent(...)` 回退之前分派）：先记录入口处的 `sys.dont_write_bytecode`，再按 `worker()` 相同方式用 `load_supervisor(Path(__file__).resolve().parents[2])` 加载，然后打印一行 JSON `{"cache": importlib.util.cache_from_source(module.__file__), "loaded": hasattr(module, "engine_info"), "bytecodeEnabledAtEntry": <入口处 not sys.dont_write_bytecode>}`，不启动任何子进程、不碰 Docker；新建 `platform/test/e2e-engine-fixture.integration.test.ts`：在自有临时根下建 `<tmp>/platform/test/`（复制 `e2e-engine-fixture.py`）、`<tmp>/scripts/`（复制 `scripts/e2e-engine-supervisor.py`）与可写的 `<tmp>/home/`，这样 `parents[2]` 解析到临时根、真实检出不受影响；以 `/usr/bin/python3 <tmp>/platform/test/e2e-engine-fixture.py load-supervisor` 运行，子进程环境精确为 `{PATH, HOME: <tmp>/home, PYTHONIOENCODING}`（沿用 `cli-process-fixture.ts` 的显式环境约定，CI 上 `LANG` 可能未设置故不用它，但故意不设 `PYTHONDONTWRITEBYTECODE`；`HOME` 必须存在且可写：没有 `HOME` 时 Apple `/usr/bin/python3` 3.9 自身就是 `pycache_prefix=None`、`dont_write_bytecode=True`，用例会假绿；`SourceFileLoader.set_data` 吞掉 `OSError`，不可写的缓存位置同样假绿），断言退出码 0、`loaded === true`、`bytecodeEnabledAtEntry === true`（环境已禁写字节码时用例失败而非假绿）、输出的 `cache` 路径不存在、`<tmp>/scripts/__pycache__` 不存在。修复前该用例必须红：macOS 上未修复时缓存落在 `<tmp>/home/Library/Caches/com.apple.python/<realpath(tmp)>/scripts/e2e-engine-supervisor.cpython-39.pyc`（正是 `cache_from_source` 打印的路径），Linux 3.12 上落在 `<tmp>/scripts/__pycache__/`。缺少 `/usr/bin/python3` 时用例失败而不是跳过。真实 fault 模式仍只由 VPS 的 `e2e-engine.docker.test.ts` 证明。8.2 证据（VPS，一个全新、专用、冻结的 reviewed-SHA 检出，按规格场景顺序）——(1) 先单独运行 `pnpm test:docker platform/test/e2e-engine.docker.test.ts`，随后 `git ls-files --others --exclude-standard` 为空且 `scripts/__pycache__` 不存在；(2) 全量 custody `pnpm --silent verify:docker start <sha>` 通过且 cleanup confirmed；(3) `pnpm test:deploy`（同一检出）；(4) 再次做未跟踪/`__pycache__` 检查；(5) 在同一检出第二次 `pnpm --silent verify:docker start <同一 SHA>`：准入证据是 `start` 以 0 退出并打印 `{invocation, head, root, directory, owner}`，随后 `status <invocation>` 为 `state: running`，并让它自然到达终态记录 status（不以 cancel 替代）；第二次只在第一次 custody 与 `test:deploy` 结束后启动，避免与主机级部署锁重叠；两次 invocation 与结果都贴入 PR 证据评论。准入只检查 SHA/非 root/`DOCKER_HOST`、`requireReviewedCheckout`（HEAD 一致、`git diff --quiet HEAD --`、无未跟踪文件）、检出属主与私有目录，没有按 SHA 的目录、锁或 journal 检查，所以第二次被拒只可能源于检出被写入。Must preserve：`worker_args`、`unshare` 参数、`FaultPhaseUnavailable` 边界、各 fault 模式的注入与断言、custody/public-group/network-sentinel 模式、`e2e-engine.docker.test.ts` 的全部断言与 `runFaultFixture` 调用方式；不改 `requireReviewedCheckout`、不扩大 custody 清理权限、不清除 giap-vps 现存残留（pr454 检出里的 root 属主 `scripts/__pycache__` 留待运营方单独授权删除）；root 运行的 python 仍可能写 `/usr/lib/python3*/` 下的标准库缓存，在检出之外，不在范围内。

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
  - 对话模型用测试自有的确定性 provider（经管理员 model-config 调用的 `platform/test/deployment-model-wire.ts`，复用第 3 组和 `office-delegation` 已有确定性协议适配器的脚本约定），由它驱动工具调用和写文件；子 Agent 委派由任务 15.4 扩展同一 provider 承接；
  - 管理员模型配置在用例中指向这个 provider，不调用外部模型。

  验证：`pnpm test:stack` 中的用例让员工发一条消息，确定性 provider 收到请求、工作台显示回复、Agent 按脚本写出一个文件；截图留存，零意外控制台错误，没有发往外部模型的请求。

- [ ] 10.5 补充文档：
  - 本机 RAGFlow 测试栈（`infiniflow/ragflow:v1.0.0-rc2`）的部署步骤和私有配置文件格式；
  - AGENTS.md 验证矩阵新增 `test:stack` 一行，写明它用 Playwright Chromium 经网关驱动真实 DSH、模型是确定性 provider，是本机功能证据通道，不是隔离 CfT 通道，不提供隔离证据；`constraints.yaml` 的 `verification` 同步；
  - 证据评论的格式。

  验证：`pnpm lint:agents` 通过，文档中的命令照写可以运行。

Suggested fixture level: expanded - 新增验证入口，涉及私有凭据、本机浏览器运行时和本机资源清理
Minimal mergeable slice: 10.1 只有前提检查和所有权清理的骨架单独合入（还没有用例，不影响其他门禁）

Risk packs (10.1): selected - Config（私有文件 `~/.config/dsh-team/stack.json` 封闭键集 `ragflowUrl`/`ragflowApiKey`/`embeddingApiKey`，三者必填且为无控制字符的非空字符串，未知键、非对象、非法 UTF-8/JSON 一律拒绝；`ragflowUrl` 只接受 `http(s)://` 加字面 `127.0.0.1` 或 `[::1]`，可带端口，无 userinfo/query/fragment，路径为空或 `/`——不接受 `localhost`，因为它要经解析器和 `/etc/hosts`，不是字面地址；D16 的「只写本机测试栈」由此机械化，不靴带到 10.2 的地址一致性检查上）、File IO（沿用 `docker-proxy-environment.mjs` 的读法：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开，`fstat` 先于读取——普通文件、uid 等于当前进程、`mode & 0o7777 === 0o600`、≤16384 字节，任何路径都关闭描述符，ENOENT 对本通道是「配置缺失」而不是空配置；读取器在 proxy 模块内导出复用，不建新文件，见 Evidence）、Error handling（前提按固定顺序评估，第一条失败即以退出码 1 结束并在 stderr 写一行 `test:stack prerequisite failed: <固定原因>`；没有任何前提通过后的降级分支；没有用例文件时 vitest 的「No test files found」非零原样传出，不加 `passWithNoTests`；账本里出现固定平台名 `dsh-team-platform` 的 run 时，本任务的 `acquireLock` 以固定错误拒绝，该 run 一个资源都不删并计入 failures——这是 10.3 的前置阻塞项，见 Evidence）、Security（stderr/stdout/异常 message 都不含 `ragflowUrl`、两把密钥、文件内容、原始 JSON 解析错误；版本不符时只回显满足 `/^[\x21-\x7e]{1,64}$/` 的服务端版本串，否则写 `unparseable`；探测请求不带任何 Authorization；①只看环境变量 `DOCKER_HOST`/`DOCKER_CONTEXT`，管不到用户 `~/.docker/config.json` 里的 `currentContext`，所以 ④ 与清理用同一个私有空 `DOCKER_CONFIG`，根本不读用户配置）、Resource limits（版本探测 `redirect: 'error'`、`AbortSignal.timeout(5000)`、响应体上限 65536 字节；`docker info` 经 `createDockerCommands(..., bounded: true)` 的 `command(['info','--format','{{json .}}'], 30_000)`：调用方传 30s 超时，`bounded` 给 64 KiB `maxBuffer`；私有运行目录 `mkdtemp` 0700）、Public API（新增根脚本 `test:stack`；`docker-proxy-environment.mjs` 新增导出 `readPrivateJsonFile`；vitest 新项目 `stack`）、Legacy compatibility（`dockerProxyEnvironment()` 的全部可观察行为不变：ENOENT→`{}`，其余任何失败→固定 `Trusted host Docker proxy configuration invalid`，传给 `openSync` 的路径字符串仍是 `join(homedir(), '.config/dsh-team/docker-proxy.json')`——`platform/test/docker-proxy-config.integration.test.ts:61` 的 shim 按这个字符串识别描述符；不改 `docker-proxy-config.integration.test.ts`、`docker-proxy.integration.test.ts`、`ci-vps-proxy.integration.test.ts` 的任何期望；proxy 模块不新增任何 import，因为它被按文件名逐个发运进独立闭包：`scripts/verify-browser-runtime.mjs:198-201` 的 build context、`images/browser-verification/Dockerfile:17` 的 COPY（镜像内 `probe-browser-network.mjs:4` 导入）、`scripts/ci-vps-owner.mjs:256-271` 的 `git archive` 清单、`platform/test/trusted-docker-fixture.ts:70-80`；`platform/test/docker-cleanup.ts`、`platform/test/docker-command.ts`、`OWNER_LABEL`、`pnpm test`/`test:integration`/`test:docker` 的项目选择不变）、Concurrency（入口直接启动 vitest 入口而不经 pnpm，把 SIGINT/SIGTERM 转发给 vitest 并等待它自己的 `close`，之后才做账本退休并以 130/143 退出；这只结算 vitest 主进程：vitest 5 的 `stack` 项目默认 `forks` 池，主进程收到信号后约 1ms 就 `process.exit()`，不停止 worker，worker 没有 SIGTERM 处理器、只在下一次 IPC 发送失败时退出，所以一个正在 await `docker create` 的 worker 或 docker CLI 孙进程不在结算范围内，定向 `kill -TERM <runner>` 下退休可能先于它们完成（TTY Ctrl-C 的进程组信号会直接杀死 worker，是安全路径）；本任务没有资源，这条缺口走不到，作为 10.3 的硬前置项：10.3 在任何 `*.stack.test.ts` 登记资源之前必须交付进程组级结算——`detached` 子进程、向 `-pid` 转发、有界窗口内只有 `kill(-pgid, 0)` 返回 `ESRCH` 才算结算、未结算时保留账本不退休——并补定向 SIGTERM 的真实证据）；not selected - Auth（版本接口无鉴权；密钥本任务不消费）、Schema（无 HTTP 契约/数据库变化）、Release（proxy 模块不新增 import，闭包清单、浏览器镜像打包和 VPS archive 都不变；没有版本或发布面变化）、Documentation（10.5 负责 AGENTS.md 矩阵行、`constraints.yaml` `verification` 与私有配置文档；本任务不改 AGENTS.md）。无关键路径文件。Governing invariant：任何 Docker 资源创建之前，全部前提都已经由同一条 Docker 传输路径（`createDockerCommands` 的固定 `PATH` + 私有 `DOCKER_CONFIG` + `dockerProxyEnvironment()`）和同一个私有文件读取器验证通过；任何退出路径（通过、用例失败、信号、清理失败）都只按账本里的精确标签和名字退休资源，不用前缀、全局或未登记的发现。Sibling surfaces：上述 4 处按文件名发运 proxy 模块的闭包清单；`platform/test/docker-command.ts:40-56` `processOptions` 的环境策略；`platform/test/docker-cleanup.ts:186-200` 的 `flock` 锁原语（macOS 无 `flock`，见 Evidence）；`dockerProxyEnvironment` 的全部现有调用方：`scripts/trusted-docker-owner.mjs:10`、`scripts/probe-browser-network.mjs:4`、`scripts/verify-browser-runtime.mjs:12,41`、`scripts/ci-vps-owner.mjs`（archive 清单 :266）、`platform/test/docker-command.ts:2`、`platform/test/ci-vps-worker.ts:9,42,208`（受限通道 checkout `git` 与 Docker 客户端入口，`DSH_TEAM_CI_INVOCATION`→`hostProxyEnvironment` 正是被重构的分支，由 `ci-vps-proxy.integration.test.ts` 守住）、`platform/test/trusted-docker-fixture.ts:70-80`、`platform/test/browser-wrapper-docker-fixture.ts:11,270`、`platform/test/browser-runtime-fixture.ts:9,362`、`platform/test/browser-network-fixture.ts:2,26`、`platform/test/browser-acquisition.docker.test.ts:17,278`。
Evidence (10.1): **现状**：根 `package.json` 没有 `test:stack`；`vitest.config.ts:9-43` 只有 `unit`/`integration`/`docker`/`model` 四个项目；`scripts/docker-proxy-environment.mjs:39-52,55-82` 的 0600 私有文件读取器未导出且绑定 proxy 路径与字段语法（`proxyFields(text)` 自己 `JSON.parse`，:23-24）；`platform/test/docker-cleanup.ts` 已有精确所有权清理：`OWNER_LABEL = 'dsh-team.test-run'`（:8）、`registerCleanupTarget`（:241，向 `DSH_TEAM_CI_RESOURCE_JOURNAL` 账本追加后入栈）、`cleanupTargets`（:222，容器→网络→卷→镜像逐个 `removeOwned` 标签核对）、`readCleanupJournal`/`retireCleanupJournal`（:293,:366，固定平台名的 run 先 `acquireLock` 再排水，拿锁失败则该 run 不删任何资源，:332-348）、`acquireDeploymentLock`（:186-200，用固定 PATH spawn `flock`，本机 `/usr/local/bin`、`/usr/bin`、`/bin`、`/opt/homebrew/bin` 均无 `flock`）；`platform/test/docker-command.ts:103-108` `createDockerCommands(repositoryRoot, config, bounded, injectedCommand?)`，其 `processOptions`（:40-56）固定 `PATH: /usr/local/bin:/usr/bin:/bin`、`DOCKER_CONFIG: config`、`...dockerProxyEnvironment()`，`bounded` 时非 build 命令 `maxBuffer` 64 KiB；私有空 `DOCKER_CONFIG` 不含 `currentContext`，Docker CLI 回落到 `/var/run/docker.sock`（本机是 Docker Desktop「允许默认 socket」选项创建的符号链接，`docker context ls` 当前为 `desktop-linux`）；`scripts/trusted-docker-retirement.mjs:2-8` 已证明 `scripts/*.mjs` 可直接导入这些 `.ts` 助手。**事实**（本机只读核实）：RAGFlow `v1.0.0-rc2` 是 Go 重写，`internal/router/router.go:153-158` 在无鉴权组 `/api/v1` 注册 `GET /system/version`；`internal/handler/system.go:114-122` 经 `common.SuccessWithData` 返回 `{"code":0,"data":"<version>","message":"success"}`，`data` 是字符串；版本串来自镜像构建时 `git describe --tags --match=v* --first-parent --always` 写入的 `/ragflow/VERSION`（`Dockerfile:170-175`），因此官方 `infiniflow/ragflow:v1.0.0-rc2` 镜像应报告恰好 `v1.0.0-rc2`——这一点与信封形状在本机没有运行中的测试栈，留给 10.3 的真实运行确认；本机 `docker info`：OSType linux、Architecture aarch64、MemTotal 16747859968、Docker Desktop 29.1.3。**改动点**（只改 `package.json`、`vitest.config.ts`、`scripts/docker-proxy-environment.mjs`，新建 `scripts/test-stack.mjs`、`scripts/test-stack-prerequisites.mjs`、`platform/test/test-stack.integration.test.ts`；不新建共享模块，不改任何闭包清单、Dockerfile 或 `docker-cleanup.ts`/`docker-command.ts`）：(1) `scripts/docker-proxy-environment.mjs` 把 `readProxyFields`+`hostProxyEnvironment` 的打开/`fstat`/有界读取/UTF-8 fatal 解码/`JSON.parse`/关闭逻辑收拢为新导出 `readPrivateJsonFile(path, uid)`：返回 `{ present: false }`（仅 ENOENT）或 `{ present: true, value: unknown }`，其余任何失败（打开失败、非普通文件、uid/mode/大小不符、UTF-8/JSON 非法、关闭失败）抛固定 `new Error('Private configuration file invalid')`，不保留路径、内容或原始错误；`proxyFields` 改为接收已解析的 `unknown`（去掉自己的 `JSON.parse`，其余校验逐字不动）；`hostProxyEnvironment(uid)` 变成 `readPrivateJsonFile(join(homedir(), '.config/dsh-team/docker-proxy.json'), uid)` 后把 `present:false`→`{}`、`present:true`→`proxyFields(value)`、任何抛错→`INVALID`，等价性：字段校验从关闭描述符之前挪到之后，可观察结果不变。模块不新增 import。(2) `scripts/test-stack-prerequisites.mjs` 导出纯函数 `assessStackPrerequisites(facts)` 与常量 `MIN_DOCKER_MEM_TOTAL = 15032385536`、`EXPECTED_RAGFLOW_VERSION = 'v1.0.0-rc2'`、`STACK_CONFIG_RELATIVE_PATH = '.config/dsh-team/stack.json'`：`facts = { dockerHost, dockerContext, platform, arch, config: ReturnType<readPrivateJsonFile> | 'invalid', dockerInfo: { status, stdout } | undefined, version: { status, body } | 'unreachable' | undefined }`（`'invalid'` 表示读取器抛错），按固定顺序返回第一条失败 `{ ok: false, reason }`、全部通过 `{ ok: true, ragflowUrl }`，或在前面各条都通过而下一条事实尚未采集时返回 `{ ok: undefined, ragflowUrl? }`，入口据此逐条采集：① `DOCKER_HOST`/`DOCKER_CONTEXT` 非空 → `local default Docker daemon required`；② `platform !== 'darwin' || arch !== 'arm64'` → `macOS arm64 host required`；③ 配置缺失 → `private configuration missing`，无效 → `private configuration invalid`（键集/地址规则见 Risk packs）；④ `docker info --format '{{json .}}'` 非零或 JSON 非对象 → `local Docker daemon unavailable`，`OSType !== 'linux'` 或 `typeof MemTotal !== 'number'` → 同上，`MemTotal < 15032385536`（14 GiB；13.9 GiB ≈ 14925011353 必须拒绝，恰好 15032385536 通过）→ `docker info MemTotal below 14 GiB`；⑤ 版本探测 `GET <ragflowUrl 去尾斜线>/api/v1/system/version` 不可达/超时/重定向/非 200/超 64 KiB → `RAGFlow test stack unreachable`，JSON 不是 `{code: 0, data: string}` → `RAGFlow test stack version response malformed`，`data !== 'v1.0.0-rc2'` → `RAGFlow test stack version is <服务端串或 unparseable>, expected v1.0.0-rc2`。入口 `scripts/test-stack.mjs` 导出 `runTestStack({ env, platform, arch, repositoryRoot, dockerCommands: (repositoryRoot, config) => DockerCommands, probeVersion, spawnCases: (env, repositoryRoot) => Promise<{code, signal}>, retire, stderr })`、`probeRagflowVersion(url, deadline = 5000)` 与 `spawnCases(env, cwd, launch?)`，并在 `process.argv[1]` 命中时执行 `main`；默认实现：`process.env`、`node:os` 的 `platform()`/`arch()`（测试经参数注入主机事实，不 mock `node:os`）、`createDockerCommands(repositoryRoot, <runDir>/docker-config, true)`（`docker info` 和清理经同一个 `command`，同一套固定 PATH/私有 `DOCKER_CONFIG`/proxy 环境；测试通过它的第 4 个参数 `injectedCommand` 注入受控结果，不 shim `selectDockerExecution`）、`fetch`、`spawn(process.execPath, [<repo>/node_modules/vitest/vitest.mjs, 'run', '--project', 'stack'], { stdio: 'inherit' })`——不经 pnpm 中转，因为只发给 pnpm 的信号不是子进程结算证据（AGENTS.md「Trusted Docker verification」）：转发的 SIGINT/SIGTERM 直接到达 vitest，结算用的是 vitest 自己的 `close`——以及 `retireCleanupJournal`。入口先 `mkdtemp(join(tmpdir(), 'dsh-team-stack-'))` 得到 0700 运行目录并在其中创建 0700 `docker-config/`（空）与 0600 空 `cleanup.journal`——这是私有临时目录，不是 Docker 资源；事实按 ①→⑤ 的顺序懒求值，前一条失败后不再采集后一条（测试用计数器证明：`DOCKER_HOST` 非空时 `docker info` 和探测都未被调用，配置缺失时探测未被调用）；前提失败时删除运行目录再退出 1。(3) 前提全部通过后：设置子进程 `DSH_TEAM_CI_RESOURCE_JOURNAL=<runDir>/cleanup.journal`（`DOCKER_CONFIG` 不传给子进程），以 `stdio: 'inherit'` 直接运行 vitest 项目 `stack`，SIGINT/SIGTERM 转发给 vitest 子进程并等待它自己的 `close`；无论子进程如何结束，都用同一个 `dockerCommands` 构造 `JournalRetirement`：`command`/`commandAsync` 取自它，`requireSettled: () => undefined`（本机通道不设 `DSH_TEAM_VERIFICATION_SUBMISSIONS`，没有 submission 账本），`acquireLock: () => Promise.reject(new Error('deployment lock unavailable in the local lane'))`——`acquireDeploymentLock` 依赖 macOS 没有的 `flock`，而账本只有固定名 `dsh-team-platform` 的 run 才会取锁；10.1 的账本为空，10.3 用交付的 compose 拉起该固定名之前必须先交付一个 macOS 可用的锁（例如 `openSync(path, 'wx')` 独占文件锁）并把这条替换掉，否则 10.3 的 run 一个资源都删不掉：这是 10.3 的前置阻塞项，在 10.3 的 Evidence 里核销。同为 10.3 前置阻塞项的还有 Risk packs 里 Concurrency 条写明的进程组级结算。调用 `retireCleanupJournal(readCleanupJournal(journal), retirement, failures)`；`failures` 为空才删除运行目录，否则保留并在 stderr 写 `test:stack cleanup failed (<n>); journal retained at <dir>`，退出码取子进程码、信号映射 130/143、清理失败 1 三者的非零优先。`vitest.config.ts` 新增 `{ name: 'stack', include: ['platform/test/**/*.stack.test.ts'], fileParallelism: false, testTimeout: 900_000 }`；本任务不交付任何 `*.stack.test.ts`，所以前提齐全的真实运行以 vitest「No test files found」非零结束，账本为空、`retireCleanupJournal` 不发出任何 Docker 命令——这是预期结果，不是绿色空跑。(4) `package.json` 增加 `"test:stack": "node scripts/test-stack.mjs"`。**测试**（`platform/test/test-stack.integration.test.ts`，Docker-free，主机 `platform`/`arch` 经 `runTestStack` 参数注入，`docker info` 结果经 `createDockerCommands` 的 `injectedCommand` 注入并断言 args 恰为 `['info','--format','{{json .}}']`，`HOME` 指向临时目录，版本接口由测试自有的本地 `node:http` 服务提供，探测超时经 `probeRagflowVersion` 的 `deadline` 参数缩短）逐条覆盖：`DOCKER_HOST` 非空、`DOCKER_CONTEXT` 非空、linux/x64、darwin/x64、linux/arm64；配置缺失、0644、0640、符号链接、超 16384 字节、非法 JSON、非对象、未知键、缺键、空字符串、含控制字符、`ragflowUrl` 为 `localhost`/非 loopback IP/带 userinfo/带 query/带路径；`docker info` 非零、非 JSON、OSType 非 linux、MemTotal 缺失、13.9 GiB 拒绝、恰 14 GiB 通过；探测端口关闭、超时（注入缩短的 deadline）、302、500、超 64 KiB、非 JSON、`code !== 0`、`data` 非字符串、`data` 为 `v1.0.0-rc2-3-gabcdef`（拒绝并回显）、`data` 含非可打印字符（回显 `unparseable`）、恰好 `v1.0.0-rc2` 通过（并断言探测请求不带 Authorization）；`[::1]` 字面地址通过；`uid` 不符直接在 `readPrivateJsonFile(path, uid + 1)` 上验证（与 0644/符号链接走同一条抛错→`'invalid'` 分支）；懒求值顺序计数；哨兵断言：每个拒绝路径的 stderr、返回值与抛出的 message 都不包含种下的 `ragflowUrl` 唯一路径段和两把 `uuid` 密钥；前提齐全路径用注入的 `spawnCases`（返回 `{ code: 1 }` 并断言收到的 env 带 0600 空账本、`DOCKER_CONFIG` 未泄给子进程之外）与注入的 `retire`（断言收到空 entries、运行目录随后被删除）验证编排，另一例让注入 `retire` 推入一个失败并断言运行目录保留、stderr 一行、退出码 1；一例在账本里预写一条 `runId` 不合法的行并断言 `readCleanupJournal` 的拒绝被计入 failures 而不是吞掉；一例在账本里预写一条该 run 自己的 `dsh-team-platform` 容器登记，用真实 `retireCleanupJournal` 加注入的 `command` 断言 `acquireLock` 的固定错误进入 failures 且 `command` 没收到任何 `rm`；信号映射两例（SIGINT→130、SIGTERM→143）同时断言运行目录已删除；一例用 `spawnCases` 的 `launch` 参数启动一个收到 SIGTERM 后延迟 300ms 再向账本追加一条合法登记才退出的 `node -e` 子进程，就绪后 `process.emit('SIGTERM', 'SIGTERM')`，断言退出码 143、注入的 `retire` 恰好收到那条晚到的登记、运行目录已删除、SIGTERM 监听器数量恢复——证明退休只在真实子进程 `close` 之后开始（该用例在 `pnpm exec` 中转启动下失败：pnpm 先关闭，空账本被退休并删除，孤儿孙进程随后才追加）。`readPrivateJsonFile` 本身由现有 `docker-proxy-config.integration.test.ts` 的 23 个拒绝模式、2 个接受模式和 `root-entry` 用例（:179-189）守住（它在 `openSync` 层按路径字符串识别描述符并注入 close-failure/growing/foreign-owner），`docker-proxy.integration.test.ts`、`ci-vps-proxy.integration.test.ts` 原样通过。进程级一例：`spawn(process.execPath, ['scripts/test-stack.mjs'], { env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1' } })` 在任意主机上都以退出码 1 和恰好一行 `test:stack prerequisite failed: local default Docker daemon required` 结束。**本机真实运行**：在 macOS arm64 开发机上以空临时 `HOME` 运行 `node scripts/test-stack.mjs`（pnpm 自管版本按 `$HOME/Library/pnpm` 找自己，临时 `HOME` 下 `pnpm --silent test:stack` 在进脚本前就失败，需另设 `PNPM_HOME`；真实使用时 `HOME` 不变，`pnpm test:stack` 照常）退出 1 且 stderr 为 `test:stack prerequisite failed: private configuration missing`；放一个指向未监听端口 `http://127.0.0.1:1` 的 0600 配置后为 `RAGFlow test stack unreachable`——这一例已经真实走过 ④，证明私有 `DOCKER_CONFIG` 传输路径在本机连得上 Desktop 的默认 socket；均不创建 Docker 资源（前后 `docker ps -a`/`network ls`/`volume ls` 的 `dsh-team` 过滤结果相同）。本机没有运行中的 RAGFlow 测试栈，前提齐全的正向路径只有注入测试与「No test files found」的推理，10.3 补真实证据。`pnpm lint:shell` 不受影响（无新增 `.sh`），仍随 `pnpm check` 运行并通过。**exact-head Docker 证据（合入必需）**：仓库树里的集成测试证明不了 proxy 模块在按文件名发运的闭包里还能加载——浏览器镜像（`images/browser-verification/Dockerfile:17`，镜像内 `scripts/probe-browser-network.mjs:4` 导入）和 VPS archive（`scripts/ci-vps-owner.mjs:266`，`platform/test/ci-vps-worker.ts:9,208` 消费）只有真实 Docker 运行能证明；因此按 `tasks.md` 组内共同约定，PR 最终 head 在 giap-vps 上跑完整发现的 `pnpm test:docker`（含 `deployment.docker.test.ts`）与 `pnpm test:deploy`，两者通过且 cleanup confirmed，发布 `dsh-team/docker` 状态并把证据贴到 PR；`docker-evidence` job（`.github/workflows/ci.yml:182-204`）据此通过。**不做**：不写种子脚本、用例、Playwright 运行时、AGENTS.md 矩阵行或 `constraints.yaml`；不新增 CI 必需检查；不改 workflow、Dockerfile 或任何闭包清单。
Risk packs (10.2，#400): selected - Public API（新增根脚本 `seed:stack` → `node scripts/seed-stack.mjs`，可选一个位置参数 `<ragflowUrl>`；`scripts/seed-stack.mjs` 导出 `SEED_DATASETS`（供 10.3「种子数据可读」与后续知识库用例引用）、`runSeedStack(options)`；`scripts/test-stack-prerequisites.mjs` 新增导出 `configuredStack(config)` 与 `assessSeedPrerequisites(facts)`，`assessStackPrerequisites` 的可观察行为不变）、Config（私有配置仍是 10.1 的 `~/.config/dsh-team/stack.json`，同一个 `readPrivateJsonFile` 读取、同一套封闭键集与字面 loopback 规则；种子脚本只消费 `ragflowUrl` 与 `ragflowApiKey`，`embeddingApiKey` 仍由共享校验要求存在但不被读取、不被发送；嵌入模型不写死——建库请求不带 `embedding_model`，由 RAGFlow 租户默认决定，脚本只检查返回的 `embedding_model` 为非空字符串）、Auth（密钥只出现在 `Authorization: Bearer` 请求头；不进 argv、环境变量、stdout、stderr、异常 message；HTTP 401/403 映射为固定一行，不回显响应体）、File IO（只读仓库内 `scripts/seed-stack/<dataset>/<file>` 的种子文件，不写任何本地文件；文件内容不打印）、Error handling（任何失败以退出码 1 和 stderr 恰好一行固定词汇结束，词汇见 Evidence；不重试、不删除、不调用 stop-parse；解析失败只报库名与文件名，不回显 `progress_msg`——它可能携带提供商错误文本和地址）、Resource limits（每个请求 `redirect: 'error'`、`AbortSignal.timeout(30000)`、响应体上限 1 MiB；列表请求 `page_size=100`；轮询间隔 2s、总时限 600s，超时非零退出；种子数据固定 3 库 × 2 文件，每个文件 ≤ 2048 字节纯文本）、Concurrency / shared state（幂等由「先列后写」保证：每次运行只取一次不带 `name` 过滤的完整数据集列表（`?name=` 对不存在的库返回 HTTP 200 `code 102`「The dataset doesn't exist」，首跑空栈会被它打断），数据集与文档都在客户端按返回列表中的 `name` 严格相等匹配；RAGFlow 的库名不区分大小写且重名时自动追加 `(1)` 后缀而不是报错，所以在任何建库/上传之前，列表里出现只在大小写上相同的名字即以固定错误拒绝、零 POST——否则每次重跑都会多造一个孤儿库，而脚本没有删除路径；列表长度达到 `page_size`（100）时同样拒绝、零 POST，因为满页不能证明缺席；建库后仍核对返回 `name` 等于请求名，作为最后一道防线；只向 `POST /datasets/{id}/chunks` 发送 `ingestion_status` 为 UNSTART/FAILED/STOPPED 的文档 id，COMPLETED 永不进入解析请求体，CREATED/SCHEDULED/RUNNING/STOPPING 只等待不重触发）、Legacy compatibility（10.1 的 `assessStackPrerequisites`、`runTestStack`、`probeRagflowVersion` 与 `platform/test/test-stack.integration.test.ts` 全部用例不改；`scripts/docker-proxy-environment.mjs` 不动，闭包清单不变；RAGFlow 1.0 返回体 `code` 与 HTTP 状态分别判定——HTTP 200 且 `code === 0` 才算成功，F34 教训）；not selected - Schema（无 HTTP 契约、数据库、迁移变化）、Release（无打包、依赖、版本面变化；不新增依赖，上传用 Node 24 全局 `fetch`/`FormData`/`Blob`）、Documentation（10.5 负责部署步骤、AGENTS.md 矩阵行与 `constraints.yaml`；本任务不改 AGENTS.md、DEPLOY.md）。无关键路径文件。Governing invariant：任何写请求（建库、上传、解析）之前，目标地址都已经等于私有配置里经同一读取器与同一校验得到的 `ragflowUrl`，且每一个进入解析请求体的文档 id 当时的 `ingestion_status` 都属于 UNSTART/FAILED/STOPPED；第二次运行在同一状态上不发出任何 POST。Sibling surfaces：`scripts/test-stack.mjs` 的 `assess`（③/⑤ 两条前提与本脚本共用 `configuredStack`/版本判定，错误词汇相同）；`platform/test/test-stack.integration.test.ts:101` 的 `vi.stubEnv('HOME', …)` 私有配置夹具模式（本任务的测试沿用，不 mock `node:os`）；`probeRagflowVersion`（`scripts/test-stack.mjs:35-57`，本脚本直接复用，不复制）；10.3 的首个 `*.stack.test.ts` 将按 `SEED_DATASETS` 的库名与文件名核对「种子数据可读」。
Evidence (10.2，#400): **现状**：根 `package.json` 没有 `seed:stack`；`scripts/test-stack-prerequisites.mjs:29-43` 的 `configuredOrigin(config)` 未导出，只返回去尾斜线的 origin，不返回密钥；`assessStackPrerequisites` 把 ①`DOCKER_HOST`/`DOCKER_CONTEXT`、②darwin/arm64、③配置、④`docker info`、⑤版本串成一条链，种子脚本不创建 Docker 资源，①②④ 对它不适用，直接复用会迫使调用方伪造 `dockerInfo` 事实；`scripts/test-stack.mjs:35-57` 的 `probeRagflowVersion(url, deadline)` 可直接复用（该模块的 `main` 守卫只在 `argv[1]` 命中自身时执行，导入安全）。**事实**（本机只读核实，2026-11-01）：`~/.config/dsh-team/stack.json` 存在，`stat` 为普通文件、0600、属主 uid 501、151 字节（内容未读）；`GET http://127.0.0.1:19380/api/v1/system/version` → `{"code":0,"data":"v1.0.0-rc2","message":"success"}`；`GET /api/v1/datasets` 无头 → HTTP 401 `{"code":401,"data":null,"message":"Missing Authorization header"}`，错误 Bearer → HTTP 401 `{"code":401,...,"message":"Invalid access token"}`；镜像内无 Go 源码，`?name=` 过滤语义无法核实，且参考文档写明它对不存在的库返回 `code 102`，所以不用它，客户端严格相等匹配；RAGFlow 1.0 HTTP API（参考文档 `http_api_reference.md`）：`POST /api/v1/datasets` 只有 `name` 必填，`embedding_model` 可选、格式 `model@factory`、省略时沿用租户默认，`chunk_count > 0` 后不可改嵌入模型；`GET /api/v1/datasets?page_size=&include_parsing_status=true`（或 `?id=`）的数据集对象带 `id`、`name`、`embedding_model`、`document_count`、`chunk_count` 与 `unstart_count/running_count/cancel_count/done_count/fail_count`；`POST /api/v1/datasets/{id}/documents` multipart 多个 `file` 字段，返回 `data[]`（`id`、`name`、`run`）；`GET /api/v1/datasets/{id}/documents?page_size=` 返回 `data.docs[]`（`id`、`name`、`run`、`chunk_count`、`progress`、`process_begin_at`、`update_time`；旁边的 `total_datasets` 不读），`run` 文本取值 `UNSTART/RUNNING/CANCEL/DONE/FAIL/SCHEDULE`，数字 `0..5` 同义；`POST /api/v1/datasets/{id}/chunks` body `{document_ids}` 解析指定文档，重复提交 DONE 的 id 会重新解析（这就是嵌入调用量的来源）；用户已在 RAGFlow 界面把 `text-embedding-3-small` 设为租户默认嵌入模型。**改动点**（只改 `package.json`、`scripts/test-stack-prerequisites.mjs`，新建 `scripts/seed-stack.mjs`、`scripts/seed-stack/<dataset>/<file>.txt` 六个种子文件、`platform/test/seed-stack.integration.test.ts`；不改 `scripts/test-stack.mjs`、`scripts/docker-proxy-environment.mjs`、`vitest.config.ts`、AGENTS.md、DEPLOY.md）：(1) `scripts/test-stack-prerequisites.mjs`：`configuredOrigin` 改为导出的 `configuredStack(config)`，返回 `{ ragflowUrl, ragflowApiKey } | undefined`（`ragflowUrl` 已去尾斜线，校验逐字不变），`assessStackPrerequisites` 改为取 `configuredStack(...)?.ragflowUrl`，返回值与错误词汇不变；新增导出 `assessSeedPrerequisites({ config, version })`：`config` 缺失 → `{ ok: false, reason: 'private configuration missing' }`，无效 → `'private configuration invalid'`；`version` 未采集 → `{ ok: undefined, stack }`；⑤ 的三个版本错误词汇与 10.1 完全相同；全部通过 → `{ ok: true, stack: { ragflowUrl, ragflowApiKey } }`。(2) `scripts/seed-stack.mjs` 导出常量 `SEED_DATASETS = [{ name: 'dsh-team-seed-policies', files: ['attendance-policy.txt', 'expense-policy.txt'] }, { name: 'dsh-team-seed-products', files: ['product-catalog.txt', 'after-sales-terms.txt'] }, { name: 'dsh-team-seed-minutes', files: ['weekly-minutes-01.txt', 'weekly-minutes-02.txt'] }]`（库名就是 `scripts/seed-stack/` 下的目录名）与 `runSeedStack({ argv, home, uid, sleep, now, parseDeadline, stdout, stderr })`→`Promise<number>`，`process.argv[1]` 命中自身时执行 `main`（`argv: process.argv.slice(2)`、`home: homedir()`、`uid: process.getuid()`、真实 `setTimeout`/`performance.now`、600 000ms、`process.stdout.write`/`process.stderr.write`；不用 `console`）。执行顺序，每一步失败都以退出码 1 加 stderr 恰好一行结束：(a) `argv.length > 1` → `seed:stack usage: pnpm seed:stack [<ragflowUrl>]`；(b) `readPrivateJsonFile(join(home, STACK_CONFIG_RELATIVE_PATH), uid)`（抛错 → `'invalid'`）交给 `assessSeedPrerequisites` → `seed:stack prerequisite failed: <reason>`；(c) 若有位置参数，去掉恰好一个尾斜线后必须与 `stack.ragflowUrl` 字节相等，否则 `seed:stack refused: address does not match the private configuration`——此时还没有发出任何网络请求（包括版本探测）；(d) `probeRagflowVersion(stack.ragflowUrl)` 交给 `assessSeedPrerequisites` → 同 (b) 的前缀；(e) 先取一次完整列表 `GET /api/v1/datasets?page_size=100&include_parsing_status=true`（不带 `name` 过滤：参考文档「List datasets」对不存在的库给 HTTP 200 `{"code":102,"message":"The dataset doesn't exist"}`，首跑空栈会被它打断），`data` 不是数组 → `response malformed`，`data.length >= 100` → `seed:stack failed: RAGFlow list datasets listing is full`（满页不能证明缺席，零 POST）；然后先对三个库名一次性做名字检查，任何 POST 之前完成：列表里有 `name.toLowerCase() === <name>.toLowerCase()` 且 `name !== <name>` 的项 → `seed:stack failed: dataset <name> collides with an existing name`（RAGFlow 库名不区分大小写、重名自动加后缀，建了就是删不掉的孤儿），`name === <name>` 的项 ≥2 → `seed:stack failed: dataset <name> is ambiguous`；两种都零 POST、按 `SEED_DATASETS` 顺序报第一个。再对 `SEED_DATASETS` 逐库顺序执行：取 `name === <name>` 的项：0 个 → `POST /api/v1/datasets` body `{ "name": <name> }`（不带 `embedding_model`、`parser_id`、`chunk_method`），返回 `data.name` 必须等于请求名否则 `seed:stack failed: dataset <name> was created as a different name`；1 个 → 复用其 `id`；随后 `embedding_model` 不是非空字符串 → `seed:stack failed: dataset <name> has no embedding model; set the tenant default in the RAGFlow UI`（在任何上传之前）；`GET /api/v1/datasets/{id}/documents?page_size=100`（只读 `data.docs[]`，不读也不校验旁边的 `total_datasets`），`docs.length >= 100` → `seed:stack failed: RAGFlow list documents listing is full`（零 POST）；按 `name` 严格相等匹配每个种子文件，先查只在大小写上相同的名字 → `seed:stack failed: document <file> in <name> collides with an existing name`，同名 ≥2 → `seed:stack failed: document <file> in <name> is duplicated`；缺失的文件读取 `scripts/seed-stack/<name>/<file>` 后以一个 multipart `POST /api/v1/datasets/{id}/documents`（每个文件一个 `file` 字段，`filename` 为文件名）上传，返回 `data[]` 的 `name` 集合必须等于上传集合，否则 `response malformed`；解析集合 = 本库全部种子文档中 `run` 归一化后为 `UNSTART`/`FAIL`/`CANCEL`（含数字 `0`/`4`/`2`）的 id，非空时一个 `POST /api/v1/datasets/{id}/chunks` body `{ "document_ids": [...] }`；`RUNNING`/`SCHEDULE` 不触发只等待，`DONE` 永不进入请求体。(f) 轮询：每 `sleep(2000)` 重新 `GET .../documents?page_size=100`，直到本库全部种子文档 `DONE`；任一 `FAIL` → `seed:stack failed: parsing failed for <name>/<file>`，解析请求之后出现 `CANCEL`（界面里被人取消）→ `seed:stack failed: parsing was cancelled for <name>/<file>`（两者都不打印 `progress_msg`、id、响应体，指向 RAGFlow 界面查看解析日志）；`now()` 超过 `parseDeadline` → `seed:stack failed: parsing did not finish within 600s`（不调用 stop-parse，不删除）。(g) 每库完成后再 `GET /api/v1/datasets?id=<id>&include_parsing_status=true` 一次（按已知存在的 id 过滤，不用 `name`），stdout 写一行 `<name>: created|existing; uploaded <n>; parsed <n>; documents <document_count>; chunks <chunk_count>; done <done_count>; failed <fail_count>; embedding <embedding_model>`；三库都完成后写 `seed:stack complete`，退出 0。传输：所有请求带 `Authorization: Bearer <ragflowApiKey>`、`redirect: 'error'`、`AbortSignal.timeout(30000)`，响应体读取上限 1 MiB（超限视为 malformed）；网络错误 → `seed:stack failed: RAGFlow <op> request unreachable`；HTTP 401/403 → `seed:stack failed: RAGFlow rejected the configured key`；其他非 200 或 `code !== 0` → `seed:stack failed: RAGFlow <op> request failed (HTTP <status>, code <code|none>)`；JSON 或字段形状不符 → `seed:stack failed: RAGFlow <op> response malformed`；`<op>` 取固定词汇 `list datasets`/`create dataset`/`list documents`/`upload documents`/`parse documents`。stdout/stderr/异常 message 任何路径都不含 `ragflowUrl`、两把密钥、响应体、文档或库 id。(3) 种子文件：`scripts/seed-stack/<库名>/<文件名>.txt`，UTF-8 中文纯文本，每个 ≤ 2048 字节、6–10 行，首行是唯一编号（`文档编号：SEED-POL-01`、`SEED-POL-02`、`SEED-PRD-01`、`SEED-PRD-02`、`SEED-MIN-01`、`SEED-MIN-02`），内容分别是考勤制度、报销流程、产品目录、售后条款、第一周周会纪要、第二周周会纪要，每个文件带 2–3 个只在该文件出现的名词，供后续检索用例区分来源；不含任何真实人名、地址或密钥。(4) `package.json` 增加 `"seed:stack": "node scripts/seed-stack.mjs"`。**测试**（`platform/test/seed-stack.integration.test.ts`，Docker-free；`vi.stubEnv('HOME', <临时目录>)` 下写 0600 配置，`ragflowUrl` 指向测试自有的 `node:http` 假 RAGFlow，它在内存里维护数据集/文档状态并记录每个请求的方法、路径、`Authorization` 头与 JSON/multipart 请求体；`sleep`、`now`、`parseDeadline` 经 `runSeedStack` 注入）：首次运行——假服务初始为空（它对带 `name` 查询的列表请求返回 HTTP 200 `code 102`，对不带 `name` 的返回空 `data: []`，所以用了 `name` 过滤的实现必然失败），断言恰好一个不带 `name` 的 `GET /api/v1/datasets`、3 个 `POST /api/v1/datasets`（body 只有 `name`，无 `embedding_model`）、3 个上传 POST（每个两个 `file` 部分，`filename` 与种子文件名一致，内容字节等于仓库文件）、3 个解析 POST（`document_ids` 恰为该库两个新文档 id），假服务把 `run` 从 `UNSTART` 经两次列表后翻成 `DONE`，stdout 三行 `created; uploaded 2; parsed 2; … done 2; failed 0` 加 `seed:stack complete`，退出 0；第二次运行同一假服务状态——请求日志里没有任何 POST，stdout 三行 `existing; uploaded 0; parsed 0`，`documents`/`chunks`/`done` 与第一次相同；部分状态——某库已存在且一个文件 `DONE`、另一个缺失：只上传缺失的一个、解析请求体只含它的 id，`DONE` 的 id 不在任何解析请求体里；`FAIL` 残留——预置 `run: 'FAIL'` 的种子文档被重新解析（请求体含它），假服务再次给出 `FAIL` → 退出 1、stderr 恰好 `seed:stack failed: parsing failed for <name>/<file>`，日志里没有 DELETE 或 stop 请求；`RUNNING` 残留——不发解析请求，等到 `DONE` 后成功；解析后假服务翻成 `CANCEL` → 退出 1、`… parsing was cancelled for …`；数字 `run`（`'0'`）视同 `UNSTART`；地址一致（含带尾斜线的变体）通过，`http://localhost:<port>`、大小写不同、不同端口三种不一致 → 退出 1、stderr 恰好 `seed:stack refused: …`、假服务连接计数为 0；两个位置参数 → usage 行、连接计数 0；配置缺失/0644 → `seed:stack prerequisite failed: private configuration missing|invalid`、连接计数 0；版本串 `v1.0.0-rc3` → `seed:stack prerequisite failed: RAGFlow test stack version is v1.0.0-rc3, expected v1.0.0-rc2`，日志里只有版本 GET；401 → `seed:stack failed: RAGFlow rejected the configured key`；HTTP 200 且 `code: 102` → `… request failed (HTTP 200, code 102)`；两个同名库 → `… is ambiguous`，无 POST；预置 `DSH-Team-Seed-Minutes`（第三个库名，只差大小写）→ `… collides with an existing name`，整个运行没有任何 POST（钉住名字检查在循环之前）；预置文档 `Attendance-Policy.txt` → `document … collides …`，无上传；假服务返回恰好 100 个库 / 某库 100 个文档 → `… listing is full`，无 POST；建库返回 `name: '<name>(1)'` → `… was created as a different name`，无上传；`embedding_model: ''` → `… has no embedding model …`，无上传；`parseDeadline` 注入 1ms 且假服务一直 `RUNNING` → `… did not finish within 600s`（文案固定 600s，与注入值无关）字样的固定行；哨兵断言：每个拒绝/失败路径的 stdout、stderr 与返回值都不含假服务的 origin 字符串、两把 `randomUUID()` 密钥、任何文档/库 id；每个成功路径的请求都带 `Authorization: Bearer <密钥>` 且版本探测请求不带；`SEED_DATASETS` 恰好 3 库 × 2 文件，每个文件存在、UTF-8 可解码、≤ 2048 字节、首行含对应编号；`configuredStack`/`assessSeedPrerequisites` 的单元断言（缺失、无效、版本未采集、通过返回密钥）；进程级一例：`spawn(process.execPath, ['scripts/seed-stack.mjs', 'a', 'b'])` 在任意主机以退出码 1 和恰好一行 usage 结束；另一例在临时 `HOME` 下带配置、以不一致地址启动真实进程，断言退出码 1、恰好一行 refused、假服务连接计数 0。现有 `test-stack.integration.test.ts`、`docker-proxy-config.integration.test.ts` 原样通过。**本机真实运行**（合入前必做，由编排者在最终 head 上执行并贴入 PR；实现者在集成测试全部通过之前不得对真实测试栈运行脚本，真实运行出现异常时只报告不清理——脚本本身没有删除路径）：`pnpm seed:stack` 第一次输出三行 `created; uploaded 2; parsed 2; …` 与 `seed:stack complete`、退出 0；紧接着第二次输出三行 `existing; uploaded 0; parsed 0`，`documents`/`chunks`/`done` 与第一次逐字相同、退出 0——两次输出原样贴入证据（只含库名、计数与模型名）；`pnpm seed:stack http://127.0.0.1:1` 与 `pnpm seed:stack http://localhost:19380`（后者经解析器确实指向活着的测试栈，证明拒绝不依赖目标是否应答）都退出 1、stderr 恰好一行 refused；之后在 RAGFlow 界面（http://127.0.0.1:19080）目视三个库各 2 个文档且解析完成。**脚本之外的观察**（AGENTS.md「verify the world, not the self-report」；`uploaded 0; parsed 0` 只是自报，`chunks`/`done` 相同也排除不了结果相同的重解析）：RAGFlow Go 服务只在 warn 级记录非 2xx 请求（本机 `docker logs` 里 401 有记录、200 的版本探测没有），请求日志用不上；改用测试栈自己的 MySQL 做只读观察——在第二次运行前后各执行一次，SELECT 经 stdin 送入、口令经 `MYSQL_PWD` 在容器内传递（不进任何进程的 argv，不出现在主机命令行、输出或证据里；只 SELECT，不写）：`docker exec -i ragflow-rc2-mysql-1 sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N rag_flow' <<'SQL'` 换行 `select kb.name, d.name, d.progress, d.process_begin_at, d.process_duration, d.update_time, d.chunk_num from document d join knowledgebase kb on kb.id = d.kb_id where kb.name like 'dsh-team-seed-%' order by 1, 2;` 换行 `SQL`（`document` 表没有 `run` 列，API 的 `run` 由 `progress` 推出：已在本机只读试跑，返回 0 行、无语法错误），要求 6 行逐字相同（`process_begin_at`、`process_duration`、`update_time` 不变即没有重解析），第一次运行前（0 行）与运行后（6 行）的差异是正向对照；三次查询结果原样贴入证据（只有库名、文件名、状态、时间戳、chunk 数）。该观察由编排者在最终 head 上执行，实现者不做。**exact-head VPS 证据（合入必需，组内共同约定）**：PR 最终 head 在 giap-vps 上跑完整发现的 `pnpm test:docker` 与 `pnpm test:deploy`，两者通过且 cleanup confirmed，发布 `dsh-team/docker` 状态并把证据贴到 PR；本任务不改任何 Docker 用例，预期与 #510 的结果一致。**`pnpm test:stack` exact-head 证据评论**：本机前提 ①–⑤ 首次全部可满足，脚本会进入 vitest 项目 `stack`，而 10.3 之前没有任何 `*.stack.test.ts`，所以以 vitest「No test files found」非零结束、账本为空、无 Docker 命令；评论如实贴出该命令、退出码与这一行原因，不加 `passWithNoTests`、不放占位用例。**PR 体量**：目标 ≤ 400 行；若只因 `seed-stack.integration.test.ts` 超出，按 #496（10.1，752 行）的先例加 `diff-limit-exempt` 标签并在 PR 正文写明「超出部分全部是 Docker-free 集成测试」。**已接受的残余**：嵌入模型由租户默认决定，三个库建成且 `chunk_count > 0` 后 RAGFlow 不允许改模型——换模型需先在界面删除这三个库再重跑脚本；不用 `?name=` 过滤，服务端过滤语义不再相关；大小写折叠按 `toLowerCase()` 比较，与 RAGFlow 的折叠规则可能有差异，差异只会让脚本多拒绝不会多建库；列表满页（≥100 个库或某库 ≥100 个文档）时脚本拒绝而不是猜测，本机测试栈远不到这个量。**rc2 实测更正（2026-11-02，修复轮）**：首次真实运行在建库处失败（`RAGFlow create dataset request failed (HTTP 200, code 102)`，零上传零解析，MySQL 里 0 个种子库）。逐行核对 `infiniflow/ragflow` 标签 `v1.0.0-rc2`（`ac29b4b2`）的 Go 源码后，上面引自参考文档的几条事实对本机 Go 服务不成立，以下更正**取代**上文对应条目，其余合同不变：(i) 建库：`internal/service/parser_mode.go` 的 `FromRequest` 要求 `parse_type`（缺失 → `parse_type is required`，code 102），`parse_type: 1`（BuiltIn）还要求 `parser_id`；`internal/handler/dataset.go` 的 `createDatasetAllowedFields` 只收 `name/embedding_model/parser_config/language/permission/parser_id/pipeline_id/parse_type`，其他键报 `Extra inputs are not permitted`。所以建库 body 改为恰好 `{ "name": <name>, "parse_type": 1, "parser_id": "general" }`（`general` 是服务端 `entity.ParserTypeGeneral` 的默认值，与上游 `TestCreateDataset_BuiltinSucceedsWithParseType` 一致），仍不带 `embedding_model`。(ii) 文档状态：上传响应（`mapDocKeysWithRunStatus`）与文档列表（`mapDocumentListItem`）都不再有 `run`，状态字段是字符串 `ingestion_status`，取值来自最新 ingestion task：`UNSTART`（无任务）、`CREATED`、`SCHEDULED`、`RUNNING`、`STOPPING`、`STOPPED`、`COMPLETED`、`FAILED`（`internal/common/constants.go`；`internal/dao/document.go` 的 `buildDocumentListIngestionStatusExpression`）。映射：可解析 = `UNSTART`/`FAILED`/`STOPPED`；只等待 = `CREATED`/`SCHEDULED`/`RUNNING`/`STOPPING`；完成 = `COMPLETED`；轮询中 `FAILED` → `parsing failed for <name>/<file>`，`STOPPED` → `parsing was cancelled for <name>/<file>`；其他任何值或缺失 → `response malformed`。旧的 `run` 文本与数字同义词全部删除（版本前提已钉死 rc2，不留兼容分支）。上传响应 `data[]` 每项校验 `id`、`name`、`ingestion_status`。文档列表的计数键是 `total`（旁边的计数仍不读）。(iii) 解析计数：`GET /api/v1/datasets` 的 `include_parsing_status` 在允许参数表里，但 rc2 的 `ListDatasets` 不读它，返回项没有 `unstart_count…fail_count`（这些计数只在 `/datasets/{id}/ingestions/summary`）。所以两个数据集列表请求都去掉 `include_parsing_status`；(g) 的摘要改为：`documents`/`chunks`/`embedding` 仍取自 `GET /api/v1/datasets?id=<id>` 返回项的 `document_count`/`chunk_count`/`embedding_model`，`done`/`failed` 改为该库最后一次文档列表里 `ingestion_status` 为 `COMPLETED`/`FAILED` 的文档数（整库计数，不只种子文件）。stdout 行格式不变。(iv) 解析接口不变：`POST /api/v1/datasets/{id}/chunks` body `{document_ids}`（`service.ParseFileRequest`），成功 `code 0`；它对每个 id 以 `RerunWithDelete: true` 启动，并在任何 id 处于 RUNNING/STOPPING 时整批拒绝——这再次说明 COMPLETED 绝不能进入请求体。测试更正：假 RAGFlow 按 rc2 建模——建库缺 `parse_type` 返回 HTTP 200 `code 102`，`parse_type: 1` 缺 `parser_id` 同样 102，body 出现允许表外的键返回 `code 101`；断言 3 个建库 body 恰好是上述三键；文档与上传响应只给 `ingestion_status`（不给 `run`），状态推进 `UNSTART → RUNNING → COMPLETED`；数据集列表永不返回解析计数（脚本若依赖它们就会 malformed）；原有 `run` 相关用例（数字同义、`SCHEDULE`、`CANCEL`、`FAIL`、`DONE`）改为对应的 rc2 取值（`CREATED`/`SCHEDULED`/`STOPPING` 只等待、`STOPPED`、`FAILED`、`COMPLETED`），并新增：未知 `ingestion_status`（例如 `DONE`）→ `list documents response malformed`、零解析 POST；上传响应项缺 `ingestion_status` → `upload documents response malformed`；摘要 `done`/`failed` 由文档列表计数（假服务对某库预置一个非种子的 `FAILED` 文档时 `failed 1` 仍成功退出 0——解析失败只针对种子文档）。MySQL 观察命令不变（`document` 表的 `progress`/`process_begin_at`/`process_duration`/`update_time`/`chunk_num` 仍在）。**不做**：不写 `*.stack.test.ts`、Playwright 运行时、AGENTS.md 矩阵行、DEPLOY/`constraints.yaml`（10.3/10.4/10.5）；不删除、不更新任何数据集、文档或 chunk；不调用 stop-parse；不配置模型提供商；不新增 CI 必需检查；不改 workflow。

Risk packs (10.3，#401): fixture level expanded（与 issue 建议一致）。selected - Public API（① `platform/test/docker-cleanup.ts` 的 `acquireDeploymentLock` 保持签名与返回形状（`Promise<() => Promise<void>>`，即 release 函数，`JournalRetirement.acquireLock` `:328` 的类型；两条既有错误文案；锁文件 `/tmp/dsh-team-deployment.lock` 永不 unlink；stdin EOF 释放；`locked\n` 握手）不变，平台分支用 `node:os` 的 `platform()`（与 `withDeployment` 同一个 seam，`deployment-setup-lifecycle.integration.test.ts:29-32` mock 的就是它，不用 `process.platform`），锁路径可注入（默认不变）：`platform() === 'linux'` 时 spawn 参数、环境与现在逐字节相同；`darwin` 时改由 `/usr/bin/python3 -I -c <固定脚本> /tmp/dsh-team-deployment.lock`（env 恰为 `{ PATH: '/usr/bin:/bin' }`）持锁：脚本以 `os.open(path, O_RDWR|O_CREAT, 0o600)` 打开，`fcntl.flock(fd, LOCK_EX|LOCK_NB)`，取不到时静默以非零退出，取到后写 `locked\n` 并 flush、读 stdin 直到 EOF 后退出——内核锁、EOF 释放、持锁进程死亡即释放，语义与 `flock --nonblock` 相同；其他平台在 spawn 之前抛 `Deployment verification lock unavailable`。macOS 上运行既有集成测试（`pnpm check` 含 `test:integration`）不得拿宿主真实锁：`trusted-docker-fake-preload.mjs` 增加按 basename `python3` 且 argv 含持锁脚本标记的拦截，路由到与 `flock` 相同的假锁行为；`trusted-docker-retirement.integration.test.ts:143-150` 的断言改为按 `platform()` 断言对应持锁程序的 argv，锁路径断言不变；`deployment-setup-lifecycle` 继续经 mock 的 `platform()` 走 Linux 分支，不改。② `scripts/test-stack.mjs` 的退休 `acquireLock` 由占位拒绝改为可注入的 `options.acquireLock`（入口默认 `acquireDeploymentLock`），`test-stack.integration.test.ts:326` 改用注入的假锁，任何测试都不碰真实锁文件。③ `spawnCases` 以 `detached: true` 启动 vitest，`SIGINT`/`SIGTERM` 转发给 `-pid`（`ESRCH` 忽略），转发处理器一直保留到进程组结算结束（不在 vitest `close` 时撤掉），子进程 `close` 后调用 `scripts/trusted-docker-record.mjs` 已导出的 `groupSettlesAfterClose(pid)`（2000ms/20ms、只有 `ESRCH` 算不在，复用，不另写）；`CaseOutcome` 增加 `settled: boolean`；未结算（返回 false 或抛出）时 `runTestStack` 不读账本、不退休、保留运行目录，stderr 只写 `test:stack case processes unsettled; journal retained at <dir>`，退出非零；`spawnCases` 或 `groupSettlesAfterClose` 抛出时同样处理。运行目录在启动用例之前就以 `test:stack run directory <dir>` 写到 stderr，入口被 SIGKILL 时运维仍知道账本在哪。三条中断路径（SIGINT 转发到整组；持锁进程——Linux 的 `flock`、darwin 的 python3——由 vitest worker 以非 detached 方式 spawn，在同一组里随组信号退出并释放锁）：构建中被打断——已登记的镜像目标由外层退休按精确所有权删除，daemon 侧晚落地的镜像由退休后的标签清单兜底；`compose up` 中被打断——外层 `retireCleanupJournal` 经注入的 `acquireDeploymentLock` 重新取锁，对已核实 ID 的固定名平台先 SIGTERM 排空再删除，晚落地的容器或网络由标签清单兜底；排空中被打断——同上由外层重新取锁、重新排空后才删除，排空不成功（非 0 退出、OOM、超时）则不删除、保留账本、非零。精确退休之后再按账本里每个 `dsh-team.test-run` 标签做一次只读清单（容器、网络、卷、镜像），非空即非零并保留账本——本机通道没有 submission 账本，被杀的 CLI 对应的 daemon 侧创建可能晚于退休落地。④ Docker Desktop 的 CLI 插件：私有空 `DOCKER_CONFIG` 下 `docker compose`/`docker buildx` 找不到（编排者实测：插件只在 `~/.docker/cli-plugins`，是指向 Docker.app 内 `Contents/Resources/cli-plugins` 的符号链接）；由 `platform/test/docker-command.ts` 的 `createDockerCommands` 在 `platform() === 'darwin'` 时向它收到的私有配置目录幂等写入 `config.json` `{"cliPluginsExtraDirs":[<dir>]}`（0600，内容相同则不变），`<dir>` 为 `realpath('/usr/local/bin/docker')` 的 `../cli-plugins`；分支用 `node:os` 的 `platform()`；realpath 或写入失败时不写、不抛（构造 `createDockerCommands` 永不因此失败，宿主没有 Docker Desktop 的 macOS 上既有注入假命令的测试不受影响），由随后的 `compose`/`buildx` 前提以对应原因在创建资源前失败，运行目录照常删除；这样 `test-stack.mjs`、用例自己的传输以及 `runImageLifecycle` 内部 `mkdtempSync` 的配置目录（`user-image-fixture.ts:~515`）全部覆盖，一处实现；Linux 不写任何文件、行为不变。10.1 的前提检查在 `docker info` 之后经同一传输追加 `compose version --short`（可解析且 ≥ 2.33.1）与 `buildx version`（退出 0），darwin 上再追加 `/usr/bin/python3 -I -c 'import fcntl'`（退出 0），任一不满足即以对应原因（`compose`/`buildx`/`python3`）在创建资源前失败。⑤ `scripts/seed-stack.mjs` 新增导出 `readSeedDatasets(stack)`：只发 GET，复用既有 `listDatasets`/`namedDataset`/`listDocuments`/`exactlyNamed`（不复制），返回 `SEED_DATASETS` 顺序的 `{ name, files: [{ name, status }] }`；某库缺失、文档集合与种子文件名不等时抛 `SeedFailure`（文案只含库名/文件名）；`runSeedStack` 行为与输出不变）、Auth / permissions（凭据：用例经 `readPrivateJsonFile` + 既有校验取得 `{ ragflowUrl, ragflowApiKey }`，只用于对本机 loopback RAGFlow 的只读 GET；密钥不进命令参数、环境、日志、断言消息与报告；平台以 uid1000 运行，`DEPLOY_DOCKER_GID` 不写死：用本次自有的平台镜像起一个登记过的 `--rm` 探测容器，以与 compose 相同的源/目标绑定套接字后 `stat -c %g` 取组号（Docker Desktop 实测为 0），解析为非负整数后传入）、Legacy compatibility（Linux 上 `acquireDeploymentLock`、`deployment-fixture.ts` 的 compose 参数与 env 文件内容、`pnpm test:deploy` 完全不变；从 `deployment-fixture.ts` 抽出可移植部分——平台镜像构建、`.env.example` 解析加覆盖生成 0600 env 文件、JSON override、compose argv、健康轮询——成共享函数，两条通道调用同一实现，不复制（jscpd 3% 不放宽）；Linux 专属的主机准入、观察器、`/var/run/docker.sock` 的 `stat` 组号留在 `deployment-fixture.ts`；抽取后 `deploymentSetupStep` 的阶段名与顺序 `resource-registration`、`platform-build`、`platform-image-identity`、`local-configuration`、`compose-creation` 不变（`deployment-setup-lifecycle.integration.test.ts:~272` 断言），Linux compose 参数逐字保留，含观察器 override 文件）、Resource limits（全部资源 `dsh-team` 前缀与 `dsh-team.test-run` 标签，先登记后创建：两个镜像、探测容器、固定名 `dsh-team-platform`、compose 网络；用例在准入固定名之前取得部署锁并持有到拆除结束；数据与受管配置目录取 `realpath` 后的 `mkdtemp`（`/private/var/folders/…`），0700，拆除时删除；构建各 600s、健康 60s；`vitest.config.ts` 的 `stack` 项目 `testTimeout` 由 900_000 提到 1_800_000（两次冷构建 1200s + compose、健康、排空），冷启动实测构建时长记入证据；固定名已存在时拒绝且不收养、不删除）、Error handling（任一步失败：先按 AGENTS.md 的部署约定对本次核实过的平台 ID 做 SIGTERM 排空，再按精确所有权清理，原始错误保留、清理失败追加；RAGFlow 不可读或种子不完整时用例失败，提示先运行 `pnpm seed:stack`，不自动播种）、Documentation（AGENTS.md 由编排者同 PR 更新：部署锁段落补「macOS 上由 `/usr/bin/python3` 的 `fcntl` 持锁，语义同 flock」；`test:stack` 的验证矩阵行与部署文档留给 10.5）；not selected - Schema（无持久化/HTTP 形状变化）、Concurrency（单用例串行，部署锁已覆盖）、Config（`.env.example` 不变；JWT 注入属 #422/16.1，它依赖本 issue）、Release（无新依赖）。关键路径：不改 `platform/src/orchestrator/`、`images/`。Governing invariant：本机通道只在持有部署锁时创建固定名平台，结束时（成功、失败、中断）要么本次全部自有资源都已精确退休，要么账本与运行目录保留并以非零结束；RAGFlow 测试栈只被 GET。Sibling surfaces：`platform/test/docker-cleanup.ts`、`deployment-fixture.ts`、`deployment-account-fixture.ts`（健康轮询）、`user-image-fixture.ts`（用户镜像构建）、`docker-command.ts`、`scripts/test-stack.mjs`、`scripts/test-stack-prerequisites.mjs`、`scripts/seed-stack.mjs`、`scripts/trusted-docker-retirement.mjs`（同一锁的调用者）、`vitest.config.ts:44-52`（去掉「No case exists until task 10.3」注释）。

Evidence (10.3，#401): **现状**：`scripts/test-stack.mjs` 的退休 `acquireLock` 是占位拒绝（约 `:158-159`），`spawnCases`（`:187-211`）不分离进程组、只结算 vitest 自己的 `close`，其文档注释写明 10.3 前必须补进程组结算；`acquireDeploymentLock`（`platform/test/docker-cleanup.ts:186-218`）spawn `flock`，macOS 没有；`deployment-fixture.ts` 的 `withDeployment`（`:189-279`）只准入 Linux x64 非 root，平台镜像构建（`:78-97`）、env 合成（`:101-138`）与 compose argv（`:139-163`）焊在 `startDeployment` 里；`waitForDeployment`（`deployment-account-fixture.ts:12-29`）绑定观察器；`platform/src/ragflow-proxy/` 尚不存在，没有平台路由读 RAGFlow；`seed-stack.mjs` 只导出 `SEED_DATASETS`/`runSeedStack`；`vitest.config.ts:44-52` 的 `stack` 项目还没有用例。编排者在本机（Docker Desktop 29.1.3、aarch64、MemTotal 16.7 GB、Compose v2.40.3、`/usr/bin/python3` 3.9.6 含 `fcntl`）只读与自有探测实测：私有空 `DOCKER_CONFIG` 下 `docker compose` 报 unknown command，`config.json` 写 `cliPluginsExtraDirs` 指向 `/Applications/Docker.app/Contents/Resources/cli-plugins` 后 compose 与 buildx 都可用；`/var/run/docker.sock` 是指向 `~/.docker/run/docker.sock` 的符号链接，compose 长语法绑定（`create_host_path: false`）在容器内得到 gid 0、0660，uid1000 加组 0 后可写；宿主 0700 临时目录绑定后 uid1000 可写。**改动点**（实现者）：`platform/test/docker-cleanup.ts`（darwin 持锁分支）、`platform/test/docker-command.ts`（`createDockerCommands` 内的 darwin 插件目录配置写入，唯一实现）、`scripts/test-stack.mjs`（锁、进程组结算、私有配置）、`scripts/test-stack-prerequisites.mjs`（compose 版本前提）、`scripts/seed-stack.mjs`（`readSeedDatasets`）、`platform/test/deployment-fixture.ts`（抽出共享函数，Linux 行为不变）与新的共享夹具文件、`platform/test/platform-stack.stack.test.ts`（首个用例：构建两镜像 → 探测组号 → 持锁准入固定名 → compose up → `/healthz` 200 `{status:'ok'}` → 种子三库六文件全部 `COMPLETED` 且用例前后 `readSeedDatasets` 快照相同 → 排空、退休）、`vitest.config.ts`（注释）。测试：`platform/test/test-stack.integration.test.ts`（进程组：一个 vitest 替身派生的孙进程在替身退出后仍存活 → 未结算、账本保留、退出非零、无退休调用；孙进程及时退出 → 结算后退休；`SIGTERM` 转发到整组；`:326` 改为注入假锁，断言固定名平台在取锁后才被退休；`spawnCases` 或 `groupSettlesAfterClose` 抛出时不读账本、不退休、保留运行目录、退出非零；退休后标签清单非空时退出非零并保留账本；运行目录行先于用例输出；信号转发处理器在组结算前仍在；compose 缺失或版本过低时前提失败且未创建资源）、`platform/test/docker-cleanup.integration.test.ts`（经 mock 的 `platform()` 与注入的测试自有临时锁路径，在 Linux CI 与 macOS 上都执行 darwin 分支的完整接线：spawn 程序、参数与 env 恰为规定值，`locked\n` 握手，取锁失败映射为 `Deployment verification lock unavailable`，不支持的平台在 spawn 之前抛错；持锁脚本由真实 `/usr/bin/python3` 运行：第二个获取者在持锁期间得到 `unavailable`；stdin EOF 后可再取；持锁进程被 SIGKILL 后可再取；锁文件不被删除。Linux 分支 spawn 参数不变，由既有假守护进程断言保证。不得用 `skip` 或平台条件让任何用例在 CI 上不运行）、`createDockerCommands` 的 darwin 配置写入（经 mock 的 `platform()`，Linux CI 上运行：darwin 写 0600 `config.json` 且内容等于由 realpath 推出的 `cli-plugins` 目录；内容相同时重复调用不改文件；linux 不写任何文件；realpath 失败时不写不抛）、前提检查（`buildx version` 非零以 `buildx` 原因失败；darwin 上 python3 `fcntl` 探测失败以 `python3` 原因失败；都没有创建资源）、`platform/test/seed-stack.integration.test.ts`（`readSeedDatasets` 只发 GET、缺库/缺文件/多文件失败且文案不含 id 与密钥）。**测试与验证**：`pnpm check`；本机 exact-head `pnpm test:stack`（干净检出，编排者运行），证据含提交 SHA、命令、退出码、用例计数、清理结果，以及编排者在运行前后对 RAGFlow 测试栈容器 ID/StartedAt 与数据卷的只读清单（不变）和 `dsh-team` 前缀资源清单（运行后为空）；实现者可在本机运行 `pnpm test:stack` 开发，但不得读取或打印私有配置内容；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（部署夹具抽取后的回归，清理确认）。**PR 体量**：预计超过 400 行，主要是测试与夹具，加 `diff-limit-exempt`。不沿「锁、结算、传输」与「用例」的接缝拆：design 13 要求前者先于首个用例交付，而前者在 macOS 上唯一的真实验收就是本用例的 `pnpm test:stack`（真实 Docker Desktop 插件、真实持锁、真实进程组），单独合入的基础设施在本机没有任何用例运行它，等于合入未经真实验证的代码；先例 #512/#513/#514。**已接受残余**：未结算或清理失败而保留账本后，`test:stack` 没有重新进入的退休入口：运维先确认运行目录里记录的进程组已不存在，确认没有其他部署入口持有部署锁，对带本次 `dsh-team.test-run` 标签且 ID 已核实的 `dsh-team-platform` 先 `docker stop`（SIGTERM）并确认正常退出（`ExitCode 0`、未 OOM），然后按容器、网络、卷、镜像的顺序只删除账本列出且带本次标签的精确名，最后删除运行目录；在此之前遗留的固定名 `dsh-team-platform` 会让下一次运行在准入时被拒绝（不收养、不删除）；本机 arm64 结果不代表 amd64 生产；Docker Desktop 的套接字组号为 0（root 组，不是 root 用户），只在本机通道使用；`cliPluginsExtraDirs` 依赖 Docker Desktop 的安装布局，缺失时前提检查失败而不是降级。**不做**：Document Server 与 JWT 注入（#422/16.1）、浏览器与确定性模型（10.4）、AGENTS.md 验证矩阵和部署文档（10.5）、任何平台源码改动。

Risk packs (10.4，#402): fixture level expanded（与 issue 建议一致）。**provider 的取舍**（编排者裁定）：第 3 组与 `office-delegation` 的确定性适配器（`permission-browser-provider.mjs:192`、`office-delegation-host.mjs`）是装进员工 home 的 DSH 插件，通过覆盖层 `agent-default-model` 直接选用，完全绕过管理员 model-config 与 `llm-pi-ai`，与本任务「管理员模型配置在用例中指向这个 provider」及 spec「对话模型 MUST 是测试自有的确定性 provider」的真实路径不符；仓库里唯一走「管理员 model-config → `llm-pi-ai`（`openai-completions`，`generate.ts:295-305`）→ HTTP」的确定性 provider 是 `platform/test/deployment-model-wire.ts`（隐私用例在平台容器内运行它，员工实例经实例网桥按名访问 `dsh-team-platform:3099`，`deployment-privacy-fixture.ts:170-196,268-276`）。因此本任务扩展这个已有 provider，复用两类适配器的脚本约定（工具名 `write`、参数 `{ file_path, content }`、见到工具结果后回文本，`permission-browser-provider.mjs:178-186`、`office-delegation-host.mjs:147-148`），不复制它们的代码，也不往员工 home 装插件。selected - Public API（① `deployment-model-wire.ts` 的配置在现有四键之外接受可选 `script: { path: string; content: string }`（封闭键集，`path` 为 `/data/work/` 下的绝对路径，否则配置被拒）与可选 argv 端口（默认 3099 不变）；没有 `script` 时请求与响应逐字节不变（隐私用例零改动）；有 `script` 时：只有请求的 `tools` 里含名为 `write` 的函数、且 `messages` 中没有 `role: 'tool'` 消息时，流式返回一个 assistant 增量 `tool_calls: [{ index: 0, id: 'owned-write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path, content }) } }]` 后 `finish_reason: 'tool_calls'`，非流式返回等价的 `message.tool_calls`；其他请求（含工具消息的请求，以及不带 `tools` 的请求——`dsh-base` `cordis.patch.yml:62-63` 加载的 `session-title-llm` 用同一路由请求标题，带着员工消息里的标记但没有 `tools`，回复中出现工具调用会抛 `title output must contain text only`）一律按现有方式返回 `reply` 与 `stop`；实现者对已安装的 0.2.1-rc.2 包核实标题请求的形状（本地 `resource/` 的标签止于 0.2.0-rc.2，见 AGENTS.md 第 1 条）；`/health` 在 `ready`、`markedRequests` 之外增加 `requests`（通过鉴权的 POST 总数）与 `toolResults`（含工具消息的请求数）；增量形状以 OpenAI chat completions 流式规范为准，若真实 DSH 0.2.1-rc.2 的 pi-ai 解析需要别的字段，实现者在规范之内调整并在证据中写明实际形状。② 把 `deployment-account-fixture.ts` 的 `configureDeployment` 拆出与平台通道无关的账号准备：对 `{ base, request, directory, dataDir, compose }` 目标执行管理员 PTY 创建（`cli-process-fixture.ts:168` 给子进程的 PATH 是 `${dirname(process.execPath)}:/usr/bin:/bin`，`cli-pty.py:49-51` 只在其中查找命令，而 Docker Desktop 的 `docker` 只在 `/usr/local/bin/docker`；darwin 调用经 `runPty` 的 `options.env` 传入与 `createDockerCommands` 相同的固定 PATH `/usr/local/bin:/usr/bin:/bin`，Linux 子进程 PATH 逐字节不变）、登录、model-config PUT（设置可参数化）、员工注册与员工资源登记；Linux 调用的阶段名 `account-configuration`、`administrator-terminal`、`administrator-login`、`model-configuration`、`employee-registration` 与顺序、默认模型设置（`MODEL_CONFIG` 与 `deployment-acceptance-key`）、`waitForDeployment` 的观察器就绪都不变。③ `instance-gateway-docker-fixture.ts` 的就绪轮询上限可参数化（默认 90s 不变），本机通道用 180s。真正决定启动成败的是平台自己的 60s 上限（启动 `platform/src/orchestrator/start.ts:54`、就绪 `readiness.ts:15`、凭据 `credentials.ts:37`），180s 只覆盖它们之和加 API 延迟；任一步触及 60s 上限时实例落到 `error`，本运行按阻塞上报，不改平台超时、不靠测试超时掩盖。④ 把 `preparePrivacyModel`（`deployment-privacy-fixture.ts:160-193`）里写 0600 provider 配置与只读挂载 compose 覆盖文件的部分抽成一个共享助手：输入是可移植的仓库根、目录与 provider 配置，返回覆盖文件路径（不依赖 Linux 专属的 `Deployment` 类型）；隐私用例自己 `push('--file', path)`，本机用例在 `compose up` 之前把路径放进 `writeComposeConfiguration({ overrides })`（运行中的平台无法再加绑定挂载）；两条通道都调用它（隐私用例的覆盖文件内容不变，含 `PLATFORM_LOG_LEVEL: 'info'`），不复制第二份。 ⑤ 前提检查（`scripts/test-stack-prerequisites.mjs`）在 python3 之后、RAGFlow 版本探测之前增加：钉定的 Playwright Chromium 可执行文件存在（经 `@playwright/test` 的 `chromium.executablePath()` 取得路径后检查存在），不存在时以固定原因 `playwright chromium not installed; run pnpm test:ui:install` 在创建任何资源前失败，原因文本不含路径；`test-stack.integration.test.ts` 增加对应用例。）、Auth / permissions（管理员密码每次随机，只经 PTY 的 `secrets` 输入，不进日志与截图；模型密钥是本次运行随机生成的非机密值，只写进 0600 的 provider 配置与 model-config PUT 请求体；会话 cookie 不打印；登录页截图在填写之前截取；默认权限档 `yolo`（`platform/src/db/settings.ts:44`）使脚本化 `write` 不触发审批，本任务不改运行时配置）、Legacy compatibility（隐私用例与部署夹具的 Linux 行为、阶段名、模型设置不变；`deployment-model-wire.ts` 无 `script` 时逐字节不变；10.3 的健康与种子断言不变）、Resource limits（员工资源 `dsh-team-u-<id>`、`dsh-team-home-<id>`、`dsh-team-work-<id>`、`dsh-team-net-<id>` 经既有 `registerDeploymentEmployee` 在 `instance/start` 之前登记，标签 `dsh-team.user`；退休沿用 `retireDeploymentRun` 的先排空平台再删除；Playwright 浏览器在 `finally` 中关闭，浏览器不是 Docker 资源；provider 进程随平台容器退休；`stack` 项目 `testTimeout` 1_800_000 不变）、Error handling（arm64 上员工实例起不来时用例失败并保留有界证据（实例状态与安全的错误原因，不含日志里的令牌），不得放宽 seccomp、`systempaths` 或任何安全选项——AGENTS.md 第 4 条记录 phase0 arm64 Docker Desktop 的 shell 沙箱需要放宽，本用例的写文件走 DSH 内置 `write` 工具而不是 `bash`/`run_code`，若这一前提在真实运行中不成立，按阻塞上报，不绕过）、Observability（截图与控制台：截图写到 `reports/stack/<runId>/`（登录页、工作台、回复后）；收集 `console` 的 error、`pageerror` 与 `requestfailed`，零意外——任何放行项必须是精确文本并在证据中逐条说明；浏览器发出的每个请求（含 WebSocket）的 origin 必须等于平台对外地址，没有任何外部 origin 请求；模型侧：provider `/health` 的 `requests ≥ 3`（工具调用轮、工具结果轮、标题请求）、`toolResults ≥ 1`，且员工消息里的唯一标记被计入 `markedRequests`）；not selected - Schema（无持久化/HTTP 形状变化）、Concurrency（单用例串行）、Config（`.env.example` 与 compose 不变；provider 只经测试 compose 覆盖文件只读挂载）、Documentation（AGENTS.md 验证矩阵与部署文档留给 10.5）、Release（无新依赖：`@playwright/test` 1.63.0 已在根依赖中）。关键路径：不改 `platform/src/orchestrator/`、`images/`。Governing invariant：本机通道里所有模型请求只到达测试自有 provider，浏览器只访问平台对外 origin；员工实例经真实网关、真实 model-config 与真实 DSH 完成一次带工具调用的对话，并在 `/data/work` 写出恰为脚本内容的文件。Sibling surfaces：`platform/test/deployment-model-wire.ts`（隐私用例 `deployment-privacy-fixture.ts`）、`deployment-account-fixture.ts`（`deployment.docker.test.ts` 等 Linux 调用者）、`instance-gateway-docker-fixture.ts`、`local-model-readiness.ts`、`instance-fixture.ts`、`cli-process-fixture.ts`（PTY，需 Python3 `pty`）、`platform-stack.stack.test.ts`、`deployment-compose-fixture.ts`（`overrides`）、`scripts/probe-dsh-api-ui.mjs`（选择器来源）、`vitest.config.ts`（`stack` 项目）。

Evidence (10.4，#402): **现状**：`deployment-model-wire.ts`（89 行）只回固定文本，没有工具调用，固定监听 `0.0.0.0:3099`，`/health` 只有 `ready`/`markedRequests`；`configureDeployment`（`deployment-account-fixture.ts:43-123`）依赖 `Deployment`（含观察器），在 darwin 上经 `withDeployment` 的 Linux 准入不可达；`instanceGatewayFixture(...).state(cookie, true)` 发 `POST /_platform/api/instance/start`、`.ready(cookie)` 轮询到 `{ status: 'running', reason: null }`，上限 90s；`@playwright/test` 1.63.0 只由 `playwright.config.ts` 的 `*.ui.test.ts` 使用，`stack` 是 vitest 项目，需要在用例里直接 `chromium.launch()`；`account-ui-fixture.ts` 的观察器为平台自有页设计，不能原样用于 DSH 工作台；DSH 工作台选择器来源 `scripts/probe-dsh-api-ui.mjs`：新建会话 `button[aria-label="New session"],button[aria-label="新建会话"]`（`:6`）、发送 `button[aria-label="Send message"],button[aria-label="发送消息"]`（`:7`）、首次的「Continue/继续」（`:14`）、输入框 `[contenteditable="true"]` 且不在 `[inert]` 内（`:203-205`）、回合结束为停止按钮消失且发送按钮出现（`:231-236`）；实例网桥 `Internal: false`（`platform/src/orchestrator/networks.ts:255-256`），平台在 network 模式下接入每个实例网桥，按名 `dsh-team-platform` 可达（VPS 先例；Docker Desktop 上待本任务实测）；平台的子网分配只用 Docker IPAM（`networks.ts:243-246`），不读 `/proc/net/route`。**改动点**（实现者）：`platform/test/deployment-model-wire.ts`（脚本模式、端口参数、计数）与新的 Docker-free 集成测试（以子进程在空闲端口运行它：无 `script` 时流式与非流式响应与改动前逐字节相同；有 `script` 且 `tools` 含 `write`、无工具消息的请求得到 `write` 工具调用增量；含工具消息的请求得到 `reply`；带标记但不带 `tools` 的请求（标题请求的形状）得到 `reply`；非法 `script`（多余键、非 `/data/work/` 路径、非字符串）被拒；错误密钥 403；`/health` 计数正确）；`platform/test/deployment-account-fixture.ts`（拆出可移植账号准备，Linux 行为不变）；`platform/test/instance-gateway-docker-fixture.ts`（就绪上限参数）；`platform/test/deployment-privacy-fixture.ts` 与共享助手所在文件（④）；`scripts/test-stack-prerequisites.mjs`（⑤ Chromium 事实与在 python3 之后的检查）与 `platform/test/test-stack.integration.test.ts`（Chromium 缺失时以固定原因失败且没有创建资源）；`platform/test/platform-stack.stack.test.ts`（provider 覆盖文件在 `compose up` 之前经 `overrides` 传入；以下步骤在 `composeScenario` 内 `pollHealth` 之后、`drainDeploymentPlatform` 之前执行，用例结束后的种子快照位置不变：`docker exec --detach dsh-team-platform node /verification/model.ts /verification/model.json`、`awaitLocalModelReady`；管理员 PTY 创建与登录；PUT model-config 为 `{ baseURL: 'http://dsh-team-platform:3099/v1', models: [{ name }], defaultModel: name, apiKey }`；注册员工并登记资源；Playwright 以平台对外地址登录员工、落到 `/`、进入真实 DSH 工作台、必要时点「继续」、在输入框输入含唯一标记的消息并发送、等到回复文本出现且回合结束；`docker exec --user 1001 dsh-team-u-<id>` 读取 `/data/work/<文件>` 与脚本内容逐字节相同；provider 计数与浏览器 origin、控制台断言；截图）；如需 Playwright 的小型观察助手，放在新的 `platform/test/stack-browser-fixture.ts`。**测试与验证**：`pnpm check`；本机 exact-head `pnpm test:stack`（编排者运行，证据含提交 SHA、命令、退出码、用例计数、清理结果、RAGFlow 栈前后清单、截图文件名与控制台/外部请求计数、provider 计数）；VPS exact-head `pnpm test:docker`（隐私用例覆盖 provider 无脚本路径与账号准备拆分后的 Linux 路径）与 `pnpm test:deploy`，清理确认。**PR 体量**：预计超过 400 行（provider 测试与浏览器用例为主），加 `diff-limit-exempt`；issue 声明 10.4 不可再拆。**已接受残余**：本机 arm64 结果不代表 amd64 生产；浏览器是 Playwright Chromium 而非隔离 CfT，不提供隔离证据（spec「不作为隔离证据」）；provider 的 `tool_calls` 形状由真实运行验证，单元测试只钉住 provider 自身的输出；本任务不覆盖子 Agent 委派：spec「由它驱动…子 Agent 委派」由任务 15.4 承接（其验证已要求「本机通道用例由确定性 provider 驱动综合办公委派给子 Agent 并调用检索」），届时同一 provider 需扩展 `subagent` 工具调用（参数形状见 `permission-browser-provider.mjs:152-176`）与子 Session 的请求脚本。**不做**：Document Server 与 JWT（#422）、知识库与 Office 用例（后续第 10 组之后的任务）、AGENTS.md 验证矩阵与文档（10.5）、任何平台源码或镜像改动。

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

- [ ] 11.4b 员工插件页强制状态的锁定显示（#509）：覆盖层把强制项的有效状态随 `platform-nav` 行的 `config` 发布；`platform-nav` 客户端半边据此在 DSH 插件页把强制项显示为锁定的开或关并标明「由管理员设定」，员工点不到原生开关。验证：platform-nav 单元测试覆盖三态与无状态；`pnpm test:docker` 的 first-use 插件页用例断言三张必启项卡片锁定开启、办公 bundle 在 `employee` 下仍可切换，截图留存。

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

Risk packs (11.1): selected - Schema（`images/dsh-user/catalog.json` 形状钉死：`{ "version": 1, "entries": [...] }`，每项恰好五个键 `id`（稳定 kebab-case 标识：仓库插件取 `plugins/<id>` 目录名，也是兼容性检查报错用的名字；将来第三方全局包取去掉 scope 的包名）、`package`（npm 包名）、`name`（非空中文名）、`category`（闭集 `required` | `manageable`，对应受管必启项/可管理项）、`imageDefaultEnabled`（布尔，镜像自身不经覆盖层时该项是否已激活，即三态 `employee` 下员工拿到的默认值）；`id`、`package` 各自唯一；未知键、重复、空名、非闭集类别一律让构建失败并点名条目）、Config（目录是用户镜像预装内容与后台条目的唯一来源；本任务四项：`platform-nav`/`@dsh-team/platform-nav`/「平台入口」/`required`/`false`，`permission-tiers`/`@dsh-team/permission-tiers`/「权限档」/`required`/`false`，`zh-locale`/`@dsh-team/zh-locale`/「中文界面」/`required`/`false`，`office-agents`/`@dsh-team/office-agents`/「办公 Agent」/`manageable`/`true`——前三项只由覆盖层激活（Dockerfile 注释「Delivery does not activate the plugin」「the overlay enables it」），办公 bundle 由 profile 清单登记即启用；`office-hints` 在第 17 组登记，本任务不列）、Release（用户镜像构建新增一个必过的一致性门：枚举镜像实际预装项并与目录按包名集合双向比较；枚举来源四个——① `/usr/local/lib/node_modules` 顶层包（含 `@scope/*`，按 `package.json` 的 `name` 从文件系统枚举，不用 `npm ls`，因为多余目录会让 `npm ls` 非零且离线变异只能对文件系统生效）减去「只装 DSH 的构建阶段」记录的基线——基线在第 7 行那条 `RUN npm install -g pnpm@… @deepseek-ai/dsh@…` 之后立即记录，所以工具链（node 基础镜像的 `npm`/`corepack`、`pnpm`）和 DSH 本体都是基线，`pnpm` 不是预装项（它不是插件页上能开关的东西；issue 的「只装 DSH 的阶段」按工具链层解读，写入 design 12）；② `/opt/dsh-team/<dir>/package.json` 的直接子目录；③ profile 初始副本 `${DSH_HOME}/profiles/web/node_modules/@*/*` 与非 scoped 顶层包（issue 原枚举清单漏了 `zh-locale`——它既不是全局包、不在 `/opt`、也未登记为 bundle，只交付在 profile `node_modules`，不补这一来源则目录必然多出一项；作为 spec/design 澄清写入）；④ profile 清单 `dsh.profile.bundles` 中不能从 DSH 自己的包树 `createRequire(/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json)` 解析到的 bundle 必须已在 ①–③ 中出现，否则报「registered bundle not preinstalled」；能从 DSH 包树解析到的（web profile 默认 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`，dsh-app-boot `lib/index.js:553`）是 DSH 发行包自带 bundle，不计入、不报错）、Error handling（任一方向差异都以退出码 1 结束构建，stderr 两行 `catalog entries not preinstalled: <包名…>` / `preinstalled packages not in catalog: <包名…>`，缺失侧为空时不打印该行；目录形状错误单独一行点名字段/条目；基线文件缺失或不可解析也失败，不默认空集）、Legacy compatibility（现有 `engines.dsh` 兼容性检查（Dockerfile `:77-98` 的内联 `node -e`，含硬编码四个插件目录的映射）并入同一脚本、对同一份枚举出的插件目录逐个检查，消除「目录之外的第二份已交付插件清单」，输出逐字保留 `DSH plugin compatibility failed: <id> engines.dsh=<json> peer=<json> installed=<version>`，`platform/test/user-image-rejection.integration.test.ts` 与 `user-image.docker.test.ts:229-240` 的现有期望不变；`/opt/dsh-team` 没有精确条目断言（`user-image.docker.test.ts:116-153` 只断言 `platform-nav`/`credentials` 子项，`permission-tiers.docker.test.ts:24-25` 同理，`profile-seed-fixture.ts:91-106` 只看 `/opt`、`/opt/dsh-team` 的属主/写位和 `profile-seed` 子树），新增三个 root 0444 文件不破坏它们；profile 下不新增任何文件，profile 初始副本字节相等不受影响；`userImageBuildArgs` 的四个命名上下文与主上下文路径不变，`buildUserImageExpectingFailure` 的既有调用方签名兼容）、Security（脚本只读取 `package.json` 的 `name`/`engines`/`peerDependencies` 与 profile 清单的 `bundles`，输出只含包名/字段名/版本号；三文件 root:root 0444，`/opt/dsh-team` 仍 0555 且不被 uid1001 写；不新增网络访问、构建参数或代理）、Documentation（AGENTS.md「Trusted Docker verification」用户镜像构建段补一句目录门，由 orchestrator 改；design 12 补枚举澄清与字段语义）、Public API（`catalog-check.mjs` 是新的脚本入口 `record <baseline> [--root <prefix>]` / `verify <catalog> <baseline> [--root <prefix>]`：未知子命令、缺参数、未知选项都以退出码 1 在 stderr 打印一行用法；模块同时导出 `recordBaseline(root)`、`verifyCatalog(root, catalogPath, baselinePath)`（返回 `{ problems: string[] }`）和 `main(argv, stderr)`，只在 `process.argv[1]` 命中时执行——这样它能被同目录单元测试直接导入并计入覆盖率）、Resource limits/发现规则（枚举只看目录项：`.` 开头的条目（npm 隐藏 lockfile、将来 11.2 的 `.pnpm`/`.modules.yaml`）跳过；非目录跳过；符号链接按目标 `statSync` 判定；全局根下的 `@scope` 目录逐个进入其子目录；没有 `package.json` 的目录跳过（`/opt/dsh-team/credentials`、`profile-seed` 由此排除，记录为接受的规则）；`package.json` 不可解析、无 `name`、或 `name` 与路径不一致（非 scoped 目录名≠`name`，scoped 目录 `@s/n`≠`name`）→ `package name mismatch: <相对路径> declares <name>` 并失败；每条规则有 Docker-free 用例）、机器门覆盖（`images/dsh-user/*.mjs` 原本不在任何门内：`scripts/check-test-pairing.sh:16-21` 只扫 `platform/src`、`platform/web/src`、`plugins/*`，`vitest.config.ts` 覆盖率 include 不含 `images/`，`knip.json` 不含 `images/`；本任务做四处精确改动：`scripts/check-test-pairing.sh` 把 `images/dsh-user` 加入 `roots` 并在 `:39` 的 `find` 表达式加一条只对该根生效的 `-path 'images/dsh-user/*.mjs'`（只加根不加子句会零命中、门空过），`:31` 的跳过列表加 `*.test.mjs`（否则测试文件被当源文件要求 `catalog-check.test.test.mjs`）；`vitest.config.ts` unit 项目 `include`（`:15-19`）只加 `images/dsh-user/*.test.mjs`（非测试 `.mjs` 进 include 会报 no test suite），覆盖率 `include`（`:55-61`）加 `images/dsh-user/*.mjs`，覆盖率 `exclude`（`:63-69`）加 `images/dsh-user/*.test.mjs`；`knip.json` 根 workspace 的 `entry` 与 `project` 都加 `images/dsh-user/*.mjs`；`scripts/test-guardrails.sh` 新增拒绝用例：种一个没有同名测试的 `images/dsh-user/orphan.mjs` 必须被 `check-test-pairing.sh` 拒绝（与 `:235-245` 的 `orphan.ts`/`orphan.tsx`/`plugins/office-agents/orphan.js` 同款，否则新扫描子句从未被证明有效）；`eslint.config.mjs:72` 的 `max-lines-per-function` 测试豁免 glob 扩到 `**/*.test.mjs`；不写 `constraints.yaml` 豁免）；not selected - Auth、File IO（除上述 0444 文件外无运行时读写）、Concurrency。关键路径：`images/dsh-user/`（Dockerfile、`catalog.json`、`catalog-check.mjs`、`catalog-check.test.mjs` 每一行需人工白盒审查，PR 写明并延期到 Epic #380 完成）。Governing invariant：目录是唯一来源——镜像实际预装项集合（按包名）恒等于目录条目集合，由构建期门强制，任一方向差异构建失败；两张镜像携带的目录字节相同；本任务不改变任何运行行为（无覆盖层/后台/插件页变化）。Sibling surfaces：Dockerfile 兼容性检查映射（并入）；`userImageBuildArgs`/`buildUserImageExpectingFailure` 的调用方（`user-image.docker.test.ts:229`、`user-image-rejection.integration.test.ts`、三个生产探针构建器与 seccomp/部署文档示例——主上下文与命名上下文不变，不需改）；上传镜像验收路径（`prepareVerificationImage`：上传的层只能代表未改上下文，两个拒绝构建必须原生构建）；`platform/Dockerfile.dockerignore` 允许清单与 `platform/Dockerfile` 的 COPY；`platform-image.docker.test.ts:24-48,107` 的 `artifactProbe` 哈希模式。
Evidence (11.1): **现状**：`images/dsh-user/` 只有 `Dockerfile` 与 `workspace.json`；Dockerfile `:7` 一条 `RUN` 同时装 `pnpm@10.34.6` 与 `@deepseek-ai/dsh@0.2.1-rc.2`，`:39-50` 把 `zh-locale`、`office-agents` 交付进 profile `node_modules`，`:52-62` 把 `@dsh-team/office-agents` 推进 profile 清单 `dsh.profile.bundles` 并用 `--dump-default-config` 的 stderr 守门，`:66-72` 把 `permission-tiers`、`platform-nav` 交付到 `/opt/dsh-team/`，`:77-98` 内联 `node -e` 对硬编码的四个目录做 `engines.dsh` 检查，`:103-108` 复制 profile 初始副本并收紧 `/opt`；`platform/Dockerfile:30` 只 COPY `images/seccomp/dsh-user.json`，`platform/Dockerfile.dockerignore` 只放行 `images/seccomp/dsh-user.json`；`platform/test/user-image-fixture.ts:356-376` `userImageBuildArgs(runId, image, replaced?, root)` 以 `join(root,'images/dsh-user')` 为主上下文，`:390-443` `buildUserImageExpectingFailure(plugin, enginesDsh, injectedCommand?)` 只替换一个命名上下文；`platform/test/platform-image.docker.test.ts:24-48` 的 `artifactProbe` 用 sha256 比对镜像内 seccomp 与仓库文件。DSH 0.2.1 web profile 默认 bundles 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（dsh-app-boot `lib/index.js:553`），它们从 DSH 自身包树解析。**改动点**（只改 `images/dsh-user/Dockerfile`、新建 `images/dsh-user/catalog.json`、`images/dsh-user/catalog-check.mjs`、`images/dsh-user/catalog-check.test.mjs`、`platform/Dockerfile`、`platform/Dockerfile.dockerignore`、`platform/test/user-image-fixture.ts`、`platform/test/user-image.docker.test.ts`、`platform/test/user-image-rejection.integration.test.ts`、`platform/test/platform-image.docker.test.ts`，以及门配置 `scripts/check-test-pairing.sh`、`scripts/test-guardrails.sh`、`vitest.config.ts`、`knip.json`、`eslint.config.mjs`；AGENTS.md 由 orchestrator 改）：(1) `catalog.json` 按 Risk packs 的形状列四项。(2) `catalog-check.mjs`（ESM，无依赖，`no-console`：用 `process.stderr.write`）两个子命令：`record <baseline.json>` 把 `<root>/usr/local/lib/node_modules` 顶层包名（含 `@scope/<name>`，读 `package.json.name`）排序写成 `{ "globals": [...] }`，文件以 `mode: 0o444` 写出（root `RUN` 的默认 umask 会给 0644；`:106` 的 `chmod -R a-w` 只盖 `profile-seed`，`:108` 只盖两个目录）；`verify <catalog.json> <baseline.json>` 枚举四个来源（见 Risk packs），对枚举出的每个插件目录（`/opt/dsh-team/*` 与 profile `node_modules/@*/*`）做并入的 `engines.dsh` 检查（`semver` 经 `createRequire(dsh package.json).resolve('@deepseek-ai/dsh-app-boot/package.json')` 再 `createRequire(boot)('semver')`，`includePrerelease: true`，无 `@deepseek-ai/dsh` peer），再做目录形状校验与双向集合比较，全部问题收集后一次性写 stderr、`exit(1)`。所有绝对路径都挂在可选的 `--root <prefix>`（默认 `/`）下，Docker-free 测试用临时目录伪造 `usr/local/lib/node_modules`、`opt/dsh-team`、`data/home/profiles/web` 子树与一个带 `node_modules/@deepseek-ai/dsh-app-boot`（内含最小 `semver` 替身或真实 `semver` 复制）的伪 DSH 包。(3) Dockerfile：`:7` 之后紧接 `COPY --chmod=0444 catalog-check.mjs /opt/dsh-team/catalog-check.mjs` 与 `RUN node /opt/dsh-team/catalog-check.mjs record /opt/dsh-team/npm-baseline.json`（此时全局只有工具链与 DSH）；把 `:73-98` 的内联兼容性检查替换为 `COPY --chmod=0444 catalog.json /opt/dsh-team/catalog.json` + `RUN node /opt/dsh-team/catalog-check.mjs verify /opt/dsh-team/catalog.json /opt/dsh-team/npm-baseline.json`，放在所有安装层与四个插件 COPY 之后、`mkdir credentials`/`chmod 0555` 之前，使拒绝构建与现有 `engines.dsh` 拒绝构建共享全部重层；`:100` 的 chmod 列表不变（三文件由后面的 `chown -R root:root /opt/dsh-team` 与 0444 COPY 覆盖，`chmod go-w` 保持）。(4) `platform/Dockerfile` 在 `:30` 后加 `COPY images/dsh-user/catalog.json ./images/dsh-user/catalog.json`；`.dockerignore` 加 `!images/dsh-user/` 与 `!images/dsh-user/catalog.json`，沿用现有 `!images/seccomp/…` 的写法；按 moby/BuildKit 的父目录匹配规则，既有的 `!images/` 本来就把整个 `images/` 树送进了构建上下文，所以这两行只是声明意图、不改变上下文范围，镜像内容由 `platform/Dockerfile` 的显式 COPY 决定（#499 跟进真正的按文件允许清单）。(5) `user-image-fixture.ts`：`userImageBuildArgs(runId, image, replaced?, root?, primary?)` 增加可选 `primary` 目录，同时覆盖主上下文**和** `--file`（`:368-369` 现在硬编码 `join(root,'images/dsh-user/Dockerfile')`，不改则 Dockerfile 副本里插入的 `RUN` 永远不会被构建看到）；`platform/test/volume-upgrade.docker.test.ts:36,71,90` 以位置参数 `userImageBuildArgs(runId, tag, undefined, sources)` 调用并导入 `PLUGIN_CONTEXTS`，保持兼容。`buildUserImageExpectingFailure(options, injectedCommand?)` 的第一个参数改为 `{ plugin, enginesDsh } | { primary: (directory: string) => void, expect: string }`，第二个参数 `injectedCommand` 原位保留（`user-image-rejection.integration.test.ts:65,96` 依赖它）；前者保持现有行为（两处调用改成对象形式，期望不变），后者把 `images/dsh-user` 复制到自有临时目录、调用 `primary(copy)` 变异后以该目录为主上下文与 `--file` 构建，要求退出 1 且 stderr 含 `expect`，成功或失败但 stderr 不含 `expect` 都抛错，副本目录与自有 tag 在任何结果下都清理。**测试**：Docker-free 单元测试 `images/dsh-user/catalog-check.test.mjs`（unit 项目，直接导入模块，按文件 80% 覆盖率；`main` 用注入的 `stderr` 收集输出）：`record` 输出排序包名含 scoped、写出文件 mode 0444；未知子命令/缺参数/未知选项 → 1 且一行用法；发现规则逐条（`.` 开头跳过、非目录跳过、无 `package.json` 目录跳过、`@scope` 进入子目录、`name` 与路径不一致失败、不可解析失败）；`verify` 全一致通过且 stderr 为空；目录缺一项（删 `platform-nav`）→ 1 且 `preinstalled packages not in catalog: @dsh-team/platform-nav`；全局多一个包（伪 `usr/local/lib/node_modules/dsh-team-extra/package.json`）→ 1 且 `catalog entries not preinstalled` 不出现、`preinstalled packages not in catalog: dsh-team-extra`——两个方向同时存在时两行都出现；目录多一项镜像没有 → `catalog entries not preinstalled: <包名>`；profile 清单登记 `@deepseek-ai/dsh-base`/`@deepseek-ai/dsh-web-app`（可从伪 DSH 包树解析）→ 通过；登记一个既不可解析也未预装的 bundle → 1 且 `registered bundle not preinstalled: <名>`；目录形状：重复 `id`、未知键、`category` 非闭集、空 `name`、`imageDefaultEnabled` 非布尔 → 各自 1 且点名；基线缺失 → 1；`engines.dsh` 不满足某枚举目录 → 1 且逐字 `DSH plugin compatibility failed: <id> engines.dsh=…`；仓库真实 `catalog.json` 通过形状校验，`plugins/*/package.json` 的 `name` 集合是目录 `package` 集合的子集，且这些仓库插件条目的 `id` 等于其 `plugins/` 目录名（第三方条目将来另算）。`user-image-rejection.integration.test.ts` 现有伪 daemon 用例不改期望，并新增主上下文副本模式的 Docker-free 用例：构建参数的主上下文与 `--file` 都指向自有副本、仓库 `images/dsh-user` 未被改动、副本目录与自有 tag 在成功/失败后都被清理、退出 0 或 stderr 不含期望文本的构建被拒绝。Docker（`user-image.docker.test.ts`）：现有构建用例追加读取镜像内 `/opt/dsh-team/catalog.json` 的 sha256 等于仓库文件、`/opt/dsh-team/npm-baseline.json` 的 `globals` 恰等于 `['@deepseek-ai/dsh','corepack','npm','pnpm']`（digest 钉死的 `node:24.22.0-bookworm-slim` 自带 `npm`/`corepack`；精确集合防止第 7 行那条 `RUN` 日后多装的包被基线悄悄吸收；若镜像实际基线不同，以 VPS 首次运行观察为准修正该常量并说明）、profile 清单 `dsh.profile.bundles` 含 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 而目录不含它们（正向对照：DSH 自带 bundle 存在且构建通过）、三文件 root:root 0444；新增两个原生拒绝构建：主上下文副本的 `catalog.json` 删去 `platform-nav` 条目 → 退出 1 且 stderr 含 `preinstalled packages not in catalog: @dsh-team/platform-nav`；主上下文副本的 Dockerfile 在 `verify` 那条 `RUN` 之前插入 `RUN mkdir -p /usr/local/lib/node_modules/dsh-team-extra && printf '{"name":"dsh-team-extra","version":"0.0.0"}' > /usr/local/lib/node_modules/dsh-team-extra/package.json`（离线，不碰网络）→ 退出 1 且 stderr 含 `preinstalled packages not in catalog: dsh-team-extra`；现有 `engines.dsh` 拒绝用例不变。`platform-image.docker.test.ts` 的 `artifactProbe` 增加读取 `/app/images/dsh-user/catalog.json` 的 sha256 并与仓库文件比对（与 seccomp 同模式）。**交付偏离（已采纳）**：(a) 「第一个构建用例」的容器命令写死为 `dsh --version`，镜像内断言（目录 sha256、精确基线、`dsh.profile.bundles` 正向对照、三文件 root:root 0444）放在紧随其后新增的 `managed-policy`+`execScript` 用例里；(b) `--root` 只给四个内置镜像路径加前缀，命令行传入的 `<catalog.json>`/`<baseline.json>` 原样使用（Dockerfile 里 root 为 `/`，无差别）；(c) `engines.dsh` 检查按合同只覆盖 `/opt/dsh-team/*` 与 profile `node_modules/@*/*`，不扩到非 scoped profile 包或第三方全局包；(d) 合同未定的提示文字：无 `name` → `package name mismatch: <path> declares no name`，解析失败 → `unparseable package.json: <path>`，枚举根缺失 → `enumeration root missing: <path>` 并判失败（不当空集），形状错误统一 `catalog entry <i> (<id>) has invalid|unknown key|duplicates …`；(e) `record` 以 `flag: 'wx'` 写出，目标已存在 → `baseline not written: <path>`、退出 1；(f) DSH 自带判定仿 DSH 自己的 `packageDirFromAnchor`：`createRequire(dsh/package.json).resolve.paths(name)` + `existsSync`，不依赖包导出 `./package.json`。单元用例「删掉 `dsh-web-app` 登记后报错」依赖测试主机解析不到该包（pnpm 会扩展 `NODE_PATH`），仓库将来若安装这两个包该用例会翻转；镜像构建无 `NODE_PATH`，门本身不受影响。`verify` 在 `:103` 的 profile 初始副本复制之前读取的是 live `${DSH_HOME}/profiles/web/node_modules`，此时与随后复制出的初始副本字节相同，spec 里的「profile 初始副本」指的就是这份内容。**本机**：`pnpm check` 通过（含新加入配对/覆盖率/knip 门的 `images/dsh-user/*.mjs`）；Docker 用例只能在 giap-vps 跑。**exact-head Docker 证据（合入必需）**：最终 head 在 giap-vps 上完整发现的 `pnpm test:docker`（含三个用户镜像拒绝构建与 `deployment.docker.test.ts`）与 `pnpm test:deploy` 通过、cleanup confirmed、`dsh-team/docker` 状态发布。**spec 缺口（只记录）**：plugin-catalog spec 把「Office 提示」列为受管必启项，本任务按 tasks 11.1 只登记三项必启 + 办公 bundle，`office-hints` 在第 17 组登记时加入目录。**不做**：不改覆盖层、后台接口、插件页、profile 初始副本登记形式（11.2）；不加构建参数/代理；不改命名上下文。**diff 预算**：脚本约 150 行、夹具扩展约 60 行、单元测试约 180 行、Docker 用例约 70 行、Dockerfile/目录/平台/门配置约 60 行，预计超过 issue 的 400 行边界；orchestrator 决定沿用 AGENTS.md 允许的 `diff-limit-exempt` 并在 PR 写明理由（issue 的最小可合入片就是 11.1 整体，再切没有可独立合入的子集）。
Risk packs (11.2): selected - Config（登记形式钉死，按 0.2.1 `listBundles` 核实：dsh-plugin-manager `lib/index.js:1681-1796` 只把 profile `package.json` 的 `dependencies` 键视为「已安装」（`installed = dependencies.includes(name)`），卡片列表过滤器 client `lib/client.js:3879` 只列 `installed || official || error` 的包，`@dsh-team/*` 不是 official，所以 `dependencies` 成员资格就是登记形式；`enabled` 恰等于 `dsh.profile.bundles` 成员资格，卡片状态 `packageStatus`（`:2504`）为 `enabled ? running : disabled`，有 `error` 时为 `problem`。两种错误形态必须区分：(a) 在 `dependencies` 里但不能从 `profiles/web/node_modules` 解析 → `resolveBundleDir` 抛错 → 带 `error` 的 problem 卡片；(b) 能解析但包没有 `dsh.bundle.patch` → `bundleManifest` 返回 undefined → 未选中时根本没有卡片（`:1735`）。因此登记形式钉为：四个仓库插件的规范交付位置统一为 `/opt/dsh-team/<id>/`（root 0555 目录、0444 文件；`zh-locale`、`office-agents` 新增这一规范副本），profile 初始副本 `node_modules/<package>/` 是该目录的完整登记副本（uid1001，文件 0644、目录 0755，与今天 `zh-locale`/`office-agents` 的 profile 副本同形），`dependencies[<package>] = "file:/opt/dsh-team/<id>"`（pnpm 对目录 `file:` 规格的安装结果就是一份副本，所以初始布局等于日后 pnpm 重新解析会产出的布局；精确版本号规格会让任何后续 `pnpm add` 去源上解析这个未发布的私有 scope 而失败；`link:` 会把 profile 副本变成指向只读目录的符号链接，破坏 `managed-policy-fixture.ts:62,276` 的 live 篡改用例并让 `profile-seed-fixture.ts` 的 Python 清点拒绝符号链接），`dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...目录中 imageDefaultEnabled 为 true 的 package（目录顺序）]`，本任务即 `@dsh-team/office-agents`；三项必启项只进 `dependencies`，卡片初始为未勾选的 `disabled`）、Legacy compatibility（`plugins/platform-nav/package.json` 与 `plugins/permission-tiers/package.json` 现在不声明 `dsh.bundle`，按形态 (b) 永远没有卡片；两者各加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（platform-nav 并入现有 `dsh` 对象）和一份只含注释与 `[]` 的 `cordis.patch.yml`，`files` 列表同步，Dockerfile 的两处 COPY 文件清单加上它——这是 `plugins/` 下的改动，超出 issue 的「只改 images/dsh-user/」边界，作为偏离 (a) 记录；拒绝替代方案「镜像生成一份声明了 bundle 的替身 manifest」：那是与真实包不一致的第二份 manifest，目录门的 `compatibility()` 也会读到它。空层的含义：激活仍只属于覆盖层（`generate.ts:210-222` 以绝对路径插入 `/opt/dsh-team/<id>/index.js`），员工在 profile 里选中它不会增加任何行；员工若选中 `zh-locale` bundle，其 patch 会与覆盖层插入同 id 的行，cordis-plugin-loader `update`（`lib/index.js:80-91`）按 id 建 `newMap`、`tree.store[id] ??=` 复用同一 Entry，后到的覆盖层行胜出，不崩溃——记录，不在本任务里演练；阶段 1 已存在的 home 卷只在空卷首次挂载时复制镜像内容，不会得到登记，管理员重置（`profile-restore.ts:21-37` 整体删除并从 `/opt/dsh-team/profile-seed` 重新复制）之后才有卡片，写入文档）、Release（构建门扩展：`verifyCatalog` 读同一份 profile 清单，新增三行固定输出——`catalog entries not registered: <package…>`（`dependencies` 缺键或值不等于 `file:/opt/dsh-team/<id>`）、`catalog default state mismatch: <package> expected enabled|disabled`（`bundles` 成员资格与 `imageDefaultEnabled` 不一致，两个方向）、`profile copy differs: <package>`（profile 副本与 `/opt/dsh-team/<id>` 的递归相对路径与字节不等，不比较属主与权限位）；新增 `register <catalog.json> [--root <prefix>]` 子命令负责登记：按目录条目把 `/opt/dsh-team/<id>` 递归复制到 `<profile>/node_modules/<package>`（复制后把文件改为 0644、目录 0755），再整文件改写 profile `package.json`：保留既有键顺序，`dependencies` 按包名排序写入，`dsh.profile.bundles` 在既有列表末尾按目录顺序追加 `imageDefaultEnabled` 为 true 的 package，序列化与 DSH `saveManifest` 相同（`JSON.stringify(manifest, null, 2) + "\n"`）；目标副本已存在或依赖键已存在 → `registration target exists: <path|package>`、不写任何文件、退出 1；目录形状错误仍先报错不登记。`compatibility()` 对同名插件只检查一次（`/opt` 与 profile 副本现在同名），`plugins()`/`modules()` 的枚举规则不变）、File IO（register 以 uid1001 在 Dockerfile 中运行，只写 profile 目录；verify 只读）、Public API（`ARITY` 表加 `register` 1 个路径参数，用法行同步；模块新增导出 `registerCatalog(root, catalogPath)` 返回 `{ problems }`，同目录单元测试直接导入）、Error handling（所有问题收集后一次写 stderr、退出 1；register 对部分复制失败不回滚但报错退出，构建层随之作废）、Security（无网络、无构建参数；profile 里的 permission-tiers/platform-nav 副本是惰性的——覆盖层只按绝对路径加载 `/opt`，`permission-tiers-fixture.ts:26-28` 现有用例写入同一路径证明员工副本不会被加载，改动后它覆盖的是登记副本，断言不变；三个 0444 文件与 `/opt/dsh-team` 0555 不变）、Documentation（`plugins/platform-nav/README.md`、`plugins/permission-tiers/README.md` 说明 bundle 声明与空层的目的；`plugins/zh-locale/README.md:32-41`、`plugins/office-agents/README.md:56-58,192` 改写交付位置：规范副本在 `/opt/dsh-team/<id>`、profile 登记副本仍可写；AGENTS.md「Trusted Docker verification」用户镜像段由 orchestrator 补登记门与登记形式；design 12「员工插件页」与「枚举来源」两条改写）；not selected - Auth（没有新的身份或会话面）、Concurrency（register 是构建期单进程一次性写入，运行期无共享状态）、Resource limits（复制的是镜像内已有的四个小目录，无新预算）、Schema（目录形状不变）；发现规则无新增：`/opt/dsh-team/*` 与 profile 副本现在同名，目录比较按包名集合天然去重，只有 `compatibility()` 要显式去重。`register` 只支持仓库插件条目（源目录 `/opt/dsh-team/<id>` 必须存在，否则 `registration source missing: <id>`、退出 1）；将来第三方全局包条目的登记形式另定。关键路径：`images/dsh-user/`（Dockerfile、`catalog-check.mjs`、`catalog-check.test.mjs` 每一行需人工白盒审查，PR 写明并延期到 Epic #380 完成）。Governing invariant：目录的每个条目在 profile 初始副本里恰好以上述一种形式登记，且登记状态等于 `imageDefaultEnabled`，由构建门强制；覆盖层与后台行为不变，插件页新增的是四张卡片及 DSH 原生的开关与卸载入口（必启项的卸载与关闭仍可操作，见交给后续任务的证明）。Sibling surfaces：`first-use.docker.test.ts:124-170,470-510` 的手工 `ADD_DEPENDENCY`/`removeDependency`/`editProfile` 正是本任务替换的替身，必须删除而不是保留；`scripts/probe-plugin-page.mjs` 的单包常量；`probe-plugin-page.integration.test.ts` 的假页面；`user-image.docker.test.ts:40-60` 的目录用例读 profile-seed 清单；`profile-seed-fixture.ts` 的 seed/live 等价与 zh-locale 字节检查（路径不变、无符号链接，不需改）；`managed-policy-fixture.ts` 的 live 篡改（不需改）；`volume-upgrade.docker.test.ts` 用阶段 1 提交构建旧镜像（不受影响）。交给后续任务的证明：`file:` 规格下员工 `pnpm add <pkg>` 重新解析四个依赖必须成功，归 11.6 的「联网部署可以安装插件」「从管理员配置的源安装」用例；必启项「显示为开启且锁定」与「员工不能关闭/卸载」——`enabled` 是员工 profile 清单的状态，覆盖层写不了它；`listBundles:1727-1733` 对四张卡片都给出 `removable`（`owned = installed && !shipped`，`protectsManager` 为假），`removeBundle:2135-2152` 对空层的 platform-nav/permission-tiers 会直接执行 `pnpm remove`（惰性副本被删、卡片消失，直到管理员重置），对 zh-locale 则因覆盖层同 id 同 name 的行在运行而以 `bundle-in-use`/`stop-profile` 拒绝；11.4/11.5 必须选定锁定机制（客户端装饰或启动时改写清单）并覆盖卸载入口，本任务按目录默认值交付未勾选的 `disabled` 卡片，这是 plugin-catalog spec「必启项在员工侧锁定开启」尚未被 11.2 满足的部分，记为 spec 缺口。办公 bundle 被员工关闭后的实例启动不受影响：dsh-web-app 的 bundle 声明四个 preset 层（`dsh-web-app/package.json` `dsh.bundle.patch`：`presets/standard|ptc|minimal|cordis.patch.yml`），关闭 `@dsh-team/office-agents` 后组合里仍有这四个 `@deepseek-ai/dsh-agent-preset` 行，`read.ts:130` 的「零 preset 拒绝」不会触发，`agent-preset-registry` 回到 web-app 的 `default: standard`；这由 Evidence 的「关闭后重启」浏览器用例实证，不是推断。
Evidence (11.2): **现状**：`images/dsh-user/Dockerfile:34-36` 初始化 Web profile 并预建 `zh-locale`、`office-agents/skills/official-writing` 目录，`:44-55` 把两者 COPY 进 profile `node_modules`，`:57-67` 用内联 `node -e` 把 `@dsh-team/office-agents` 推进 `dsh.profile.bundles` 并以 `--dump-default-config` 的 stderr 守门，`:69-77` 以 root 把 `permission-tiers`、`platform-nav` 交付到 `/opt/dsh-team/`，`:82-88` 跑目录门并建 `credentials`，`:90-95` 复制 profile 初始副本；profile 清单由 `initProfile`（dsh-app-boot `lib/index.js:611-622`）写出空的 `dependencies: {}`（`profile-seed.integration.test.ts:16` 也以此为准），所以今天只有 `first-use.docker.test.ts:132-141` 手工加进依赖的 office bundle 才有卡片，三项必启项没有卡片。`images/dsh-user/catalog-check.mjs:23,165-180,255-284` 已读 profile 清单的 `bundles`。**改动点**（只改 `images/dsh-user/Dockerfile`、`images/dsh-user/catalog-check.mjs`、`images/dsh-user/catalog-check.test.mjs`、`plugins/platform-nav/{package.json,cordis.patch.yml,README.md}`、`plugins/permission-tiers/{package.json,cordis.patch.yml,README.md}`、`plugins/zh-locale/README.md`、`plugins/office-agents/README.md`、`scripts/probe-plugin-page.mjs`、`scripts/probe-plugin-page.d.mts`、`scripts/probe-mapped-host.mjs`（只改 `pluginPageEvidence` `:626-636` 的透传）、`scripts/probe-mapped-host.d.mts`（`:37` 的 `pluginPage` 选项与 `:71` 起的结果类型）、`platform/test/probe-plugin-page.integration.test.ts`、`platform/test/first-use.docker.test.ts`、`platform/test/user-image.docker.test.ts`；AGENTS.md 由 orchestrator 改）：(1) Dockerfile 重排：`record` 之后、`useradd` 之前以 root 把四个命名上下文 COPY 到 `/opt/dsh-team/<id>/`（zh-locale：`package.json index.js client.js cordis.patch.yml`；office-agents：`package.json docx-construction.js cordis.patch.yml` 与 `skills/official-writing/SKILL.md`；permission-tiers：`package.json index.js review.js cordis.patch.yml`；platform-nav：`package.json index.js client.js cordis.patch.yml`，均 `--chown=root:root --chmod=0444`），`COPY --chmod=0444 catalog.json` 一并前移；`USER dsh` 段改为 `dsh --profile web --dump-default-config` 初始化（保留 `mkdir -p "${DSH_HOME}/storages"`：`:40` 的 `workspace.json` COPY 依赖这个 uid1001 目录）→ `node /opt/dsh-team/catalog-check.mjs register /opt/dsh-team/catalog.json` → 原有 `--dump-default-config` stderr 守门（`skipping profile bundle|disabling profile plugin`）；删除 `:35-36` 中两个插件目录的 mkdir、`:44-55` 的 profile COPY 和 `:57-63` 的内联登记；root 段保留 `verify`、`mkdir credentials`、`chmod 0555` 扩到 `/opt/dsh-team/zh-locale`、`/opt/dsh-team/office-agents`、`/opt/dsh-team/office-agents/skills`、`/opt/dsh-team/office-agents/skills/official-writing`，seed 复制与 `chown -R root:root /opt/dsh-team` 不变。(2) `catalog-check.mjs`：新增 `registerCatalog(root, catalogPath)` 与 `register` 子命令（见 Risk packs；`dependencies` 在既有的空对象上就地填充，不新建键），`verifyCatalog` 新增三项检查与三行固定输出，`compatibility()` 按包名去重；用法行更新为三个子命令。(3) `plugins/platform-nav`、`plugins/permission-tiers`：manifest 加 `dsh.bundle.patch`，新建空层 `cordis.patch.yml`（首行注释写明「激活由受管覆盖层负责，本层为空只为让插件页列出该插件」），`files` 加入该文件；README 补一段。(4) `scripts/probe-plugin-page.mjs`：`verifyPluginPage` 接受 `expected: { package, enabled }[]`（`probe-mapped-host.mjs` 的 `pluginPageEvidence` 把 `pluginPage` 选项对象原样透传，`pluginPage: true` 不再支持；两个 `.d.mts` 同步）（调用方从仓库 `images/dsh-user/catalog.json` 读出，`enabled = imageDefaultEnabled`）与 `roundTrip`（仍为 `@dsh-team/office-agents`）；OBSERVE 对每个 package 返回 `{ present, group, status, checked }`，列表阶段要求每项 `present`、`group === 'bundles'`、`status` 为 `enabled ? 'running' : 'disabled'`（任一 `problem` 或缺卡片 → `fail('plugin-page-list', 'catalog-card', observed)`，observed 只含包名与这四个字段）；现有 office 详情/关/开/重载往返与四张截图不变（`add`/`uninstall` 计数仍是全页按钮计数：列表视图恰有 1 个「添加插件」、0 个卸载按钮，详情视图恰有 1 个卸载按钮，四张卡片不改变这两个数），返回值新增 `cards: { package, status, checked }[]`。(5) `probe-plugin-page.integration.test.ts`：假页面渲染目录四张卡片，新增用例：某项缺卡片、某项 `problem`、必启项误为 `running`、办公 bundle 误为 `disabled` 各自以 `catalog-card` 失败；现有用例改为传入期望表。(6) `first-use.docker.test.ts`：删除 `OFFICE_AGENTS`/`PROFILE_MANIFEST`/`ADD_DEPENDENCY`/`removeDependency`/`editProfile` 及 `:470-510` 的手工登记与还原；改为在浏览器前用现有只读 `exec` 读 live profile 清单并断言 `dependencies` 恰等于目录四项的 `file:/opt/dsh-team/<id>`、`bundles` 恰为 `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@dsh-team/office-agents']`；`acceptObservation({ pluginPage: { expected, roundTrip } })` 透传；`expectPluginPage` 断言 `cards` 与目录一致、往返结果不变、截图 4 张；往返结束后再读一次 live `package.json` 字节并断言等于 `/opt/dsh-team/profile-seed/web/package.json`（证明镜像序列化与 DSH `saveManifest` 一致，关再开后 bundles 顺序不变）；随后映射 spec 场景「开关状态持久」：浏览器把办公 bundle 关掉（不再打开）→ `retire` 该实例 → `start` 同一员工（必须成功：组合里仍有 web-app 的四个 preset 行）→ 再次 `acceptObservation` 的列表阶段要求 office 卡片 `disabled`/未勾选、其余三张不变 → 浏览器重新打开 → `retire`+`start` → 列表阶段 office 恢复 `running`；为此 `verifyPluginPage` 的往返由 `roundTrip: { package, leaveEnabled: boolean }` 控制结束状态；`expectedRoster: MANAGED_BOOT_ROSTER` 不变——若 roster 变化是发现，不是要改的常量。(7) `user-image.docker.test.ts`：`:189-193` 的 platform-nav 精确目录清单改为 `['client.js','cordis.patch.yml','index.js','package.json']`，0444 检查覆盖新文件；目录用例追加：profile-seed 清单 `dependencies` 与 `bundles` 精确值；四个 profile 副本与 `/opt/dsh-team/<id>` 递归 sha256 相等且 uid1001、文件 0644；`/opt/dsh-team/zh-locale`、`/opt/dsh-team/office-agents`（含 skills 子目录）root:root、目录 0555、文件 0444；新增一个原生拒绝构建：主上下文副本的 Dockerfile 在 `register` 之后、`verify` 之前插入一条 `RUN node -e` 从 profile 清单 `dependencies` 删除 `@dsh-team/platform-nav` → 退出 1 且 stderr 含 `catalog entries not registered: @dsh-team/platform-nav`。**测试**：Docker-free 单元测试 `catalog-check.test.mjs`（伪 `--root` 树扩展：`opt/dsh-team/<id>` 四个带 `dsh.bundle` 的伪插件、空 profile 清单）：`register` 后 `dependencies` 恰为四个 `file:` 规格且排序、`bundles` 为 base/web-app/office-agents、副本递归相等、文件 0644 目录 0755、清单以两空格缩进加换行结尾、既有未知键保留；目标已存在/依赖已存在 → 1 且 `registration target exists` 且清单字节不变；`verify` 全一致通过；删一个依赖键 → `catalog entries not registered: <pkg>`；值改为 `0.3.0` 或 `link:` → 同一行；office 从 `bundles` 移除 → `catalog default state mismatch: @dsh-team/office-agents expected enabled`；把 `@dsh-team/zh-locale` 加进 `bundles` → `… expected disabled`；篡改副本一个字节/多一个文件 → `profile copy differs: <pkg>`；同名插件兼容性只报一次；用法行覆盖 `register` 缺参数；仓库真实 `plugins/*/package.json` 全部声明 `dsh.bundle.patch` 且文件存在、以 `[]` 为唯一非注释内容（platform-nav、permission-tiers）。`probe-plugin-page.integration.test.ts` 如 (5)。Docker 与浏览器如 (6)(7)。**本机**：`pnpm check`。**exact-head Docker 证据（合入必需）**：giap-vps 完整 `pnpm test:docker`（含新拒绝构建与首次使用四卡片截图）与 `pnpm test:deploy` 通过、cleanup confirmed、`dsh-team/docker` 状态发布。**偏离记录**：(a) `plugins/platform-nav`、`plugins/permission-tiers` 的 manifest 与空层 patch 超出 issue 的目录边界，原因见 Risk packs；(b) `zh-locale`、`office-agents` 新增 `/opt/dsh-team/<id>` 规范副本，profile 副本保留为登记副本——`read.ts` 的 `CANONICAL_LOCALE_PATCH` 继续指向 seed 路径，不在本任务改；(c) 登记用 `file:` 规格而非 DSH 自己安装目录时写的 `link:`，原因见 Risk packs。**不做**：不改覆盖层（`generate.ts`/`read.ts`）、后台接口、插件页 UI、`workspace.json`、命名上下文与 `userImageBuildArgs`；不在镜像里运行 pnpm；不生成 lockfile。**diff 预算**：Dockerfile 约 40 行净变化、脚本约 90、单元测试约 120、插件文件约 15、探针与其测试约 70、Docker 用例约 70、文档约 60，预计超过 400 行；沿用 `diff-limit-exempt` 并在 PR 写明理由（任务是原子的：登记形式、构建门与浏览器证据缺一不可）。
Risk packs (11.3): fixture level expanded（与 issue 建议一致）。selected - Schema（三处形状钉死。① settings 新增四个键，值为 JSON：`pluginCatalog`（对象，键为目录 `id`，值为闭集 `employee` | `forced-on` | `forced-off`；只存可管理项，必启项永不写入）、`pluginRegistries`（非空字符串数组，每项匹配 DSH 的 `REGISTRY_URL = /^https?:\/\/\S+$/`，第一项是安装源 `registry`、其余是 `fallbackRegistries`）、`registryProbeEnabled`（布尔）、`webToolsEnabled`（布尔）；`readSettings`/`writeSettings` 的 `parseOwned` 对这四个键做与现有键同级的无强制转换校验，非法值抛 `SettingsValidationError`。② 迁移 `platform/src/db/migrations/5-plugin-settings.sql` 用 `INSERT OR IGNORE INTO settings (key, value)` 写入四行初始值：`pluginCatalog` = `{}`，`pluginRegistries` = `["https://registry.npmjs.org/","https://registry.npmmirror.com/"]`，`registryProbeEnabled` = `true`，`webToolsEnabled` = `false`；账本变为 1..5。③ 接口：GET `/_platform/api/admin/plugin-catalog` 返回 `{ entries: [{ id, package, name, category, imageDefaultEnabled, state }] }`，按目录文件顺序；PUT body 恰为 `{ entries: [{ id, state }] }`——`entries` 必须恰好覆盖目录中的每个 `id` 一次（缺、多、重复、未知 id 都拒）、`state` 为闭集、`category` 为 `required` 的条目必须是 `forced-on`，对象层禁止多余键；成功响应 = GET 形状加共用提交边界附加的 `runningInstances`；任何不合法都返回 400 固定文案、不回显输入、设置与审计不变）、Config（安装源与探测的初始值取 DSH 0.2.1-rc.2 默认：dsh-plugin-manager `lib/index.js:1580-1581` 的 `registry` 为可选（未设时走 pnpm 自身配置，`registryPlan` `:971-972` 只在它是 `https://registry.npmjs.org/` 时视为公共源）、`fallbackRegistries` 默认 `[NPMMIRROR_REGISTRY]` = `https://registry.npmmirror.com/`（`:938`）；dsh-client-ui-plugin-manager `lib/index.js:72` 的 `registryProbeEnabled` 默认 `true`；由单元测试钉住迁移后的四行字面值）、Auth / permissions（沿用 `registerConfigRoute` 的提交边界：body 读完后在同一事务里用 `getSessionUser(…, false)` 重核当前活动管理员，401/403 时不写不审计；`adminRoutes` 的 `onRequest` 钩子仍先挡匿名与员工）、Error handling / rollback（校验失败与审计失败都在事务内抛出整体回滚；存储损坏走 500 固定文案）、Public API（新增模块 `platform/src/plugin-catalog/`，`index.ts` 只导出 `readPluginCatalog`、`catalogStates`、`CATALOG_STATES` 及类型；目录文件位置像 `db` 模块定位 `migrations` 那样相对本模块文件解析：`../../../images/dsh-user/catalog.json`，源码树与平台镜像 `/app/platform/dist/plugin-catalog/` 下都落在 `images/dsh-user/catalog.json`，不新增环境变量和 `AppConfig` 字段；文件缺失或形状不合 11.1 在 `buildApp` 构造时抛错，启动失败而非降级）、Legacy compatibility（现有部署只多四行 settings，既有键和行为不变；`model-config`/`runtime-config` 路由不变；`schemas/openapi.json` 用 `pnpm contract:write` 重生成）、File IO / path safety（目录文件以模块相对路径读取，必须在源码树 `platform/src/plugin-catalog/`、构建产物 `platform/dist/plugin-catalog/` 与镜像 `/app/platform/dist/plugin-catalog/` 三处都解析到 `images/dsh-user/catalog.json`：由 `catalog.test.ts` 的临时文件用例、`pnpm build` 产出 `dist/plugin-catalog/`、以及现有 `pnpm test:deploy`/平台镜像启动（镜像已含该文件，`platform/Dockerfile:31`）证明；错误只点名路径或条目，不回显文件内容）、Documentation（AGENTS.md 验证矩阵「exact migration ledger versions 1 to 4」改为 1 to 5，并在 Environment 段记录新接口与设置键）。not selected - Concurrency（与现有配置保存相同的单事务，无新共享状态）、Release / packaging（不改镜像；平台镜像已含 `images/dsh-user/catalog.json`）、Performance / Resource limits（目录文件只在 `buildApp` 构造时读一次，四项、几 KiB；settings 多四行）。**不变量**：`pluginCatalog` 只存可管理项的 id 与三态闭集之一；必启项的状态永远来自目录类别、从不入库；GET 报告的 `state` 就是 11.4 覆盖层将写入的状态。**Must preserve**：`model-config`/`runtime-config` 路由的请求、响应与审计不变；既有部署的九个 settings 键与行为不变（迁移只追加四行）；`registerConfigRoute` 的提交边界语义不变（body 读完后重核管理员、同事务审计、`runningInstances` 快照）；`buildApp` 的失败路径（`app.ts` 注册失败即关闭并抛出）不变。**同级面**：`settings.ts`（`parseOwned`、`readSettings` 键白名单、`DEFAULT_SETTINGS`）与迁移 5 字面值互为镜像；`config-route.ts` 的 `name`/`auditType` 联合；`record.ts` 封闭事件集与 `record.test.ts`；`platform/web/src/audit-page.tsx` `EVENT_NAMES`（11.5）；受管覆盖层生成器（11.4，经 `plugin-catalog/index.ts` 取条目与包名，不另写读取器）；#444/#445 路由；下文列出的账本与 settings 快照断言点。**宽度**：按证据段清单估算 550–700 行（多为测试），本 PR 打 `diff-limit-exempt`，理由：迁移、设置键、目录模块与接口共用同一条验证路径（集成测试），拆成「先迁移后接口」会让第一刀没有可验收的行为。
Evidence (11.3): **现状**：`platform/src/db/settings.ts` 的 `Settings` 有九个键，`DEFAULT_SETTINGS` 在代码里给默认值、`readSettings` 只认这九个键；迁移目录到 `4-instance-token-hash.sql`，`platform/test/db.integration.test.ts:344,433` 断言账本 `[1,2,3,4]`；`platform/src/admin/config-route.ts:14-16` 的 `ConfigDescriptor.name`/`auditType` 是二元联合；`platform/src/audit/record.ts:34-54` 的 `EVENT_DETAIL_FIELDS` 是封闭事件集，没有三个新事件；`platform/src/admin/routes.ts:199-202` 注册 `modelConfigRoutes`/`runtimeConfigRoutes`；平台源码里没有读 `images/dsh-user/catalog.json` 的代码（只有 Docker/集成测试读它）；`platform/web/src/audit-page.tsx:16` 的事件中文名表属于后台页面，本任务不改。**改动点**（只改 `platform/src/db/{settings.ts,settings.test.ts,migrate.test.ts,schema.test.ts,migrations/5-plugin-settings.sql}`、`platform/src/audit/{record.ts,record.test.ts}`、`platform/src/admin/{config-route.ts,config-route.test.ts,model-config.test.ts,model-probe.test.ts,runtime-config.test.ts,plugin-catalog.ts,plugin-catalog.test.ts,routes.ts,routes.test.ts}`、新模块 `platform/src/plugin-catalog/{index.ts,catalog.ts,catalog.test.ts}`、`platform/src/managed-config/model-settings.test.ts`（仅补 `Settings` 字面量的四键）、`platform/test/admin-plugin-catalog.integration.test.ts`、`platform/test/admin-model-config.integration.test.ts`、`platform/test/db.integration.test.ts`、`scripts/e2e-scenario.sh:107`（账本精确值改为五个版本；在 issue 边界之外，明示）、`schemas/openapi.json`；AGENTS.md 由 orchestrator 改）。迁移 5 的播种让每个读 `settings` 表的既有断言从「空/不变」变为「迁移后基线」：`config-route.test.ts:60,89,159,200`、`runtime-config.test.ts:154`、`model-config.test.ts:85`、`admin-model-config.integration.test.ts:212,237`、`settings.test.ts:53`（「returns defaults without persisting rows」改为「迁移后恰有四行播种且 `readSettings` 等于默认」）、`db.integration.test.ts:375-410` 的历史 `settings` 快照——统一改成与迁移后四行（按 key 排序）比较，不删断言；`schema.test.ts:264-269` 与 `db.integration.test.ts:344,433` 的账本改为 `[1,2,3,4,5]`。`catalog-check.mjs:212-262` 已有同形状校验，但它随 `images/dsh-user/` 进用户镜像、面向镜像文件系统且在关键路径上，平台镜像只带 `catalog.json`，所以平台侧另写 TS 校验（措辞与结构不照抄，jscpd 3% 门由 `pnpm duplicate-code` 兜底）。`registerConfigRoute` 的 `validatorCompiler` 是空操作，PUT 的 `bodySchema` 只记录契约，每一条 400 都在 `patch()` 里实现。(1) settings：`Settings` 增四键，`DEFAULT_SETTINGS` 取 Risk packs 里的 DSH 默认值（与迁移字面值一致，二者由同一个单元测试互相钉住），`parseOwned` 校验四键，`readSettings` 的键白名单加四键。(2) 迁移 5 如 Risk packs；`migrate.test.ts` 的文件清单与 `db.integration.test.ts` 两处账本改为 `[1,2,3,4,5]`。(3) 审计：`EVENT_DETAIL_FIELDS` 加 `plugin-catalog.updated`、`plugin-sources.updated`、`web-tools.updated`（均无细节字段）；`record.test.ts` 的事件遍历从十九种增到二十二种（其余三种属第 13、16 组）。(4) `plugin-catalog` 模块：`readPluginCatalog(path = 默认路径)` 读文件并按 11.1 形状校验（`version` 为 1、每项恰五键、`id`/`package` 各唯一、`name` 非空、`category` 闭集、`imageDefaultEnabled` 布尔），错误信息只点名条目 id 或键名、不回显文件内容；`catalogStates(catalog, settings)` 返回 `entries` 并补 `state`（`required` → `forced-on`；`manageable` → `settings.pluginCatalog[id] ?? 'employee'`）；`CATALOG_STATES` 冻结数组。(5) 路由 `platform/src/admin/plugin-catalog.ts`：`pluginCatalogRoutes`（Fastify plugin，options = `AdminConfigOptions & { catalog }`）经 `registerConfigRoute` 注册，`name: 'plugin-catalog'`、`auditType: 'plugin-catalog.updated'`，`bodySchema`/`responseSchema` 按 Risk packs ③，`patch(body)` 做信封与目录校验（返回 `{ pluginCatalog: { <每个可管理 id>: state } }`，必启项不入 patch），`project(settings)` = `{ entries: catalogStates(...) }`；`config-route.ts` 把 `name`/`auditType` 联合扩为三元；`routes.ts` 在 `runtimeConfigRoutes` 之后注册，`catalog` 由 `routes.ts` 在插件构造时 `readPluginCatalog()` 一次得到（`buildApp` 因而在目录缺失/损坏时构造失败）。(6) 契约：`pnpm contract:write` 重生成 `schemas/openapi.json`。**测试**：单元——`settings.test.ts` 钉住 `applyMigrations` 后 `SELECT key, value FROM settings` 中四行的字面值与 `readSettings` 的解析值，并覆盖四键的非法值（非对象/非闭集状态/空数组/非 http(s) 源/非布尔）；`record.test.ts` 三个新事件各写一行、细节为 `{}`；`catalog.test.ts` 读仓库真实目录文件得到四项，并用临时文件覆盖缺文件、非 JSON、`version` 错、缺键/多键、重复 `id`、空名、非闭集类别各一例（断言错误信息不含文件内容）；`plugin-catalog.test.ts` 经 `withApp` 覆盖 GET 初始状态（三项 `forced-on`、办公 `employee`、字段齐全且按目录顺序）、PUT 成功（存储只含 `pluginCatalog: { 'office-agents': 'forced-off' }`、审计一行 actor/source、响应含 `runningInstances`）、库里残留的不在目录中的 id 在 GET 被忽略、下一次 PUT 整体替换后消失，以及 400 清单：必启项设 `employee`/`forced-off`、未知 id、缺一项、重复 id、非闭集状态、多余键、`entries` 非数组、空对象——每例后 settings 与审计不变、响应不含输入（重复 id 用例保持四条、以重复项顶替另一 id，使其走到 Map 去重分支而非条数检查）；存储故障参数化用例 `audit`/`write`（`BEFORE INSERT` 触发器）→ 500 固定体、settings 等于播种基线、审计不变、随后 GET 200 为初始状态，`corrupt-json`/`corrupt-type`（改坏已存 `pluginCatalog` 行）→ GET 与 PUT 均 500，四例均断言 secret/SQLITE/触发器名不进响应与日志；`routes.test.ts`/`config-route.test.ts` 按需补联合类型分支。集成——`platform/test/admin-plugin-catalog.integration.test.ts` 经 `withListeningApp` 真实 TCP：匿名 401、员工 403、管理员 GET/PUT 往返、`delayedConfigBody` 在 body 已被接收后撤销会话/降级为员工 → 401/403 且无写入无审计、两次各只违反一条规则的 400（仅必启项 `forced-off`；仅办公状态非闭集）均返回完整固定提示且快照（含已保存的非默认 `office-agents: forced-on`）不变、迁移账本 `[1,2,3,4,5]`。**命令**：`pnpm test`（覆盖率逐文件 80%）、`pnpm test:integration platform/test/admin-plugin-catalog.integration.test.ts platform/test/db.integration.test.ts`、`pnpm contract:check`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（现有用例，无新 Docker 用例）。**交接**：后台页面与审计页事件中文名（11.5）；覆盖层消费四键（11.4）；`plugin-sources`、`web-tools` 接口（#444、#445）只读写本任务的键，不再加迁移。

Risk packs (11.3 安装源，#444): fixture level expanded（与 issue 建议一致）。selected - Schema（接口形状钉死：GET `/_platform/api/admin/plugin-sources` 返回 `{ pluginRegistries: string[], registryProbeEnabled: boolean }`，即 settings 同名两键的投影（字段名与 settings 键一致，沿用 `runtime-config` 的做法，不另起映射）；PUT body 恰为同形状对象——对象层只允许这两个键、二者都必填，`pluginRegistries` 必须是非空数组且每项是匹配 DSH `REGISTRY_URL = /^https?:\/\/\S+$/` 的字符串，`registryProbeEnabled` 必须是严格布尔（不做类型转换）；非对象、缺键、多键、非数组、空数组、非布尔 → 400 固定文案（不回显输入）；数组中某一项不是字符串或不匹配规则 → 400，文案只点名 `pluginRegistries[<下标>]`（零基，第一个出错项），从不回显该项内容；成功响应 = GET 形状加共用提交边界附加的 `runningInstances`；存储只写这两个键，整值替换）、Config（初始值即迁移 5 播种的 DSH 0.2.1-rc.2 默认：`["https://registry.npmjs.org/","https://registry.npmmirror.com/"]` 与 `true`；首项为 `registry`、其余为 `fallbackRegistries` 的语义见 design 决定 12，本接口不解释也不重排；不去重、不规范化末尾斜杠、不限制条数——DSH 自身也没有这些规则，加规则就要加测试且与 DSH 行为分叉）、Auth / permissions（沿用 `registerConfigRoute`：`adminRoutes` 的 `onRequest` 先挡匿名/员工，body 读完后在同一事务里 `getSessionUser(…, false)` 重核当前活动管理员，401/403 时不写不审计）、Error handling / rollback（点名下标的 400 经既有的 `ClientConfigValidationError` 通道：`config-route.ts:40` 的该类导出，`:107` 的 `descriptor.patch(request.body)` 调用移入紧随其后的 `try`（仍在 `database.transaction` 之前，null → 固定 400 的时序不变），`patch` 抛出该错误即由 `:149-157` 的既有 catch 映射为 400 `{ ...invalid, message }`；`model`/`runtime`/`plugin-catalog` 的 `patch` 从不抛出，行为不变；存储损坏与审计写入失败仍走 500 固定文案、整体回滚）、Public API（`db/settings.ts:10` 的 `REGISTRY_URL` 经 `db/index.ts` 导出，路由与 `parseRegistries` 共用这一个规则实现，不复制正则；`config-route.ts:14,16` 的 `name`/`auditType` 联合扩为四元；审计事件 `plugin-sources.updated` 已由 #406 加入封闭集，本任务不改 `record.ts`）、Legacy compatibility（不新增迁移；既有三条配置路由的请求、响应、审计不变；`schemas/openapi.json` 用 `pnpm contract:write` 重生成）、Documentation（AGENTS.md Environment 段在插件目录接口条目之后记录本接口的形状、校验与「下次启动生效」交接，并把插件目录条目中『the `plugin-sources` and `web-tools` routes … belong to later tasks』改为只剩 `web-tools` 与覆盖层消费）。not selected - File IO（不读文件）、Concurrency（同一单事务）、Release / packaging（不改镜像）、Performance / Resource limits（body 受 Fastify 默认 1 MiB 上限；settings 两行）。**不变量**：存储中的 `pluginRegistries` 永远是非空且每项合规的列表、`registryProbeEnabled` 永远是布尔（`parseOwned` 与路由双重保证）；安装源地址中的 userinfo 凭据（私有源鉴权）被接受、只返回给已鉴权管理员，从不进入日志（路由只记固定 `storageFailure` 文案）与审计（细节 `{}`）；400 文案只含字段名与下标，不含任何输入字节。**Must preserve**：`model-config`/`runtime-config`/`plugin-catalog` 路由的请求、响应与审计不变（含它们的固定 400 文案与 `validationGuidance` 拼接）；`registerConfigRoute` 的提交边界语义不变（`patch` null 仍在事务前返回固定 400；body 读完后重核管理员；同事务审计；`runningInstances` 快照）；`settings.ts` 的 `parseRegistries` 行为不变。**同级面**：`config-route.ts` 联合与 `ClientConfigValidationError` 的导出；`db/index.ts` 导出面；`routes.ts:215` 之后的注册顺序；`platform/web/src/audit-page.tsx` `EVENT_NAMES`（11.5 加中文名）；受管覆盖层生成器（11.4 消费这两键）；#445 `web-tools` 路由（同一模板）。**宽度**：路由约 70 行、单元约 170 行、集成约 110 行、`config-route.ts`/`db` 导出约 10 行，目标 ≤ 400；若测试清单把 PR 推过 400 行，打 `diff-limit-exempt`，理由：一组接口只有一条验证路径（集成测试），拆不出可独立合并的子集。

Evidence (11.3 安装源，#444): **现状**：`platform/src/db/settings.ts:10` 的 `REGISTRY_URL` 是模块私有常量，`:106-115` 的 `parseRegistries` 已校验非空数组与每项规则，`parsePluginSetting` 对 `registryProbeEnabled` 做严格布尔校验；迁移 5 已播种两键；`platform/src/audit/record.ts:48` 已有 `plugin-sources.updated`；`platform/src/admin/config-route.ts:14,16` 的联合为三元、`:40` 的 `ClientConfigValidationError` 未导出、`:107` 的 `patch` 调用在 `try` 之外；`routes.ts:215` 注册 `pluginCatalogRoutes`；`platform/web/src/audit-page.tsx` 没有该事件中文名（11.5）。**改动点**：新文件 `platform/src/admin/plugin-sources.ts`、`platform/src/admin/plugin-sources.test.ts`、`platform/test/admin-plugin-sources.integration.test.ts`；改 `platform/src/admin/config-route.ts`（联合四元、导出 `ClientConfigValidationError`、`patch` 调用移入 `try`）、`platform/src/admin/routes.ts`（`pluginCatalogRoutes` 之后 `app.register(pluginSourcesRoutes, { database, resolveSourceAddress })`）、`platform/src/db/settings.ts`（`export const REGISTRY_URL`）与 `platform/src/db/index.ts`（转出）、`schemas/openapi.json`（`pnpm contract:write`）；AGENTS.md 由 orchestrator 改。`routes.test.ts`/`config-route.test.ts` 只在其现有断言枚举路由或联合时才需补分支。(1) `pluginSourcesRoutes`（Fastify plugin，options = `AdminConfigOptions`）经 `registerConfigRoute` 注册：`name: 'plugin-sources'`、`path: '/_platform/api/admin/plugin-sources'`、`auditType: 'plugin-sources.updated'`、`bodySchema`/`responseSchema` 为两键对象（`additionalProperties: false`，`pluginRegistries` 为 `minItems: 1` 的字符串数组，`registryProbeEnabled` 布尔；schema 只记录契约，校验全在 `patch`）、`invalidMessage` 固定为「Invalid plugin sources; provide exactly { pluginRegistries: [http(s) URL, …], registryProbeEnabled: boolean } with at least one registry」；`patch(body)`：非普通对象或键集合（排序后）不等于 `pluginRegistries,registryProbeEnabled` → null；`registryProbeEnabled` 非布尔 → null；`pluginRegistries` 非数组或空数组 → null；逐项检查，第一个非字符串或不匹配 `REGISTRY_URL` 的项抛 `new ClientConfigValidationError(\`pluginRegistries[${index}] must be an http(s) URL without whitespace\`)`；全部通过返回 `{ pluginRegistries: [...items], registryProbeEnabled }`；`project(settings)`返回`{ pluginRegistries: [...settings.pluginRegistries], registryProbeEnabled: settings.registryProbeEnabled }`。(2) `config-route.ts`：`ConfigDescriptor.name`加`'plugin-sources'`、`auditType`加`'plugin-sources.updated'`；`export class ClientConfigValidationError`；把 `const patch = descriptor.patch(request.body); if (patch === null) return reply.code(400).send(invalid);`移到`try {` 之后、`database.transaction(`之前，其余逐字不变。(3)`db`：`REGISTRY_URL`加`export`并由`db/index.ts` 转出。**测试**：单元——`plugin-sources.test.ts`经`withApp`：GET 初始值恰为 `{ pluginRegistries: ['https://registry.npmjs.org/','https://registry.npmmirror.com/'], registryProbeEnabled: true }`；PUT 成功（内网源一项 + 探测关闭：存储行恰为两键新值且其余播种行不变、审计一行 `plugin-sources.updated`带 actor/source 且细节`{}`、响应 = 新值 + `runningInstances`、随后 GET 等于新值；再 PUT 两项源 + 探测开启证明整值替换）；带 userinfo 的 `https://user:secret@mirror.internal/` 被接受、GET 返回、日志行与审计不含 `secret`；400 清单（每例后 settings 与审计不变、响应与日志不含输入 SENTINEL）：非对象 body、数组 body、缺 `registryProbeEnabled`、多余键、`pluginRegistries` 非数组、空数组、`registryProbeEnabled` 为 `'true'`/`1`/`null` → 固定文案；`pluginRegistries` 第 2 项为 `ftp://…`、含空白的 `https://a b`、裸 `https://`、空字符串 `''`、非字符串 → 文案恰为「…pluginRegistries[1] must be an http(s) URL without whitespace」且不含该项内容；存储故障参数化 `audit`/`write`（`BEFORE INSERT` 触发器）→ 500 固定体、settings 等于触发器建立前快照、审计不变、随后 GET 200，`corrupt-json`/`corrupt-type`（改坏 `pluginRegistries` 或 `registryProbeEnabled` 行）→ GET 与 PUT 均 500，四例断言 secret/`SQLITE`/触发器名不进响应与日志；`config-route.test.ts` 若有联合分支断言则补 `plugin-sources`。集成——`admin-plugin-sources.integration.test.ts` 经 `withListeningApp` 真实 TCP：匿名 401、员工 403（GET/PUT 都不动 settings）；管理员 GET 初始值 → PUT 内网源 + 探测关闭 200 → GET 回读；`delayedConfigBody` 在 body 已被接收后撤销会话/降级 → 401/403 且无写入无审计；两次各只违反一条规则的 400（第 2 项 `ftp://` → 点名 `pluginRegistries[1]`；`registryProbeEnabled: 'off'` → 固定文案），快照（含已保存的非默认值）不变；审计行 actor 为该管理员、对象为空。**命令**：`pnpm test`（逐文件 80%）、`pnpm test:integration platform/test/admin-plugin-sources.integration.test.ts`、`pnpm contract:check`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（现有用例，无新 Docker 用例）。**交接**：覆盖层按这两键写出 `registry`/`fallbackRegistries` 与 `registryProbeEnabled`（11.4）；后台保存区与审计页中文名（11.5）；`web-tools` 接口（#445）复用同一模板与 `ClientConfigValidationError` 通道。

Risk packs (11.3 联网工具，#445): fixture level expanded（与 issue 建议一致）。selected - Schema（接口形状钉死：GET `/_platform/api/admin/web-tools` 返回 `{ webToolsEnabled: boolean }`，即 settings 同名键的投影；PUT body 恰为 `{ webToolsEnabled: boolean }`——对象层只允许这一个键且必填，值必须是严格布尔（不做类型转换：`'true'`、`1`、`null`、缺键、多键、非对象、数组一律 400 固定文案、不回显输入）；成功响应 = GET 形状加共用提交边界附加的 `runningInstances`；存储只写这一个键）、Config（初始值即迁移 5 播种的 `false`：第 2 组的覆盖层目前仍无条件移除 `@deepseek-ai/dsh-tool-web`，开关打开后的实际放行属于 11.4 的生成器改动，本接口只负责存储与审计）、Auth / permissions（沿用 `registerConfigRoute`：`adminRoutes` 的 `onRequest` 先挡匿名/员工，body 读完后同一事务里重核当前活动管理员，401/403 时不写不审计）、Error handling / rollback（`patch` 只返回 null 或补丁、不抛出；存储损坏与审计写入失败走 500 固定文案、整体回滚）、Public API（`config-route.ts` 的 `name`/`auditType` 联合扩为五元；审计事件 `web-tools.updated` 已由 #406 加入封闭集，本任务不改 `record.ts`）、Legacy compatibility（不新增迁移；既有四条配置路由的请求、响应、审计不变；`schemas/openapi.json` 用 `pnpm contract:write` 重生成）、Documentation（AGENTS.md Environment 段在插件安装源条目之后记录本接口，并把插件目录条目中『the `web-tools` route and the overlay consumption belong to later tasks』改为只剩覆盖层消费）。not selected - File IO、Concurrency、Release / packaging、Performance / Resource limits（单布尔）。**不变量**：存储中的 `webToolsEnabled` 永远是布尔（`parseOwned` 与路由双重保证）；400 文案固定、不含任何输入字节。**Must preserve**：`model-config`/`runtime-config`/`plugin-catalog`/`plugin-sources` 路由的请求、响应与审计不变；`registerConfigRoute` 的提交边界语义不变；`managed-config` 生成器对 `@deepseek-ai/dsh-tool-web` 的现有移除行为不变（11.4 再改）。**同级面**：`config-route.ts` 联合；`routes.ts` 注册顺序（`pluginSourcesRoutes` 之后）；`platform/web/src/audit-page.tsx` `EVENT_NAMES`（11.5）；受管覆盖层生成器（11.4 消费本键）。**宽度**：宽度门禁（`ci.yml` diff-size-guard）只排除 `pnpm-lock.yaml` 与 `schemas/openapi.json`，测试计入；路由约 45 行、单元约 180 行、集成约 100 行，连同 `config-route.ts`/`routes.ts`/文档约 340 行，目标 ≤ 400，不需要 `diff-limit-exempt`；若实际超出，按 #444 加该标签并在 PR 描述说明。

Evidence (11.3 联网工具，#445): **现状**：`platform/src/db/settings.ts` 的 `parsePluginSetting` 已对 `webToolsEnabled` 做严格布尔校验，迁移 5 播种 `false`；`platform/src/audit/record.ts:49` 已有 `web-tools.updated`；`platform/src/admin/config-route.ts` 的 `name`/`auditType` 联合为四元（`model`/`runtime`/`plugin-catalog`/`plugin-sources`），`isPlainObject` 与 `ClientConfigValidationError` 已导出；`routes.ts` 在 `pluginCatalogRoutes` 之后注册 `pluginSourcesRoutes`；`platform/src/managed-config/generate.ts` 的 `REMOVED_TOOLS` 仍无条件含 `@deepseek-ai/dsh-tool-web`。**改动点**：新文件 `platform/src/admin/web-tools.ts`、`platform/src/admin/web-tools.test.ts`、`platform/test/admin-web-tools.integration.test.ts`；改 `platform/src/admin/config-route.ts`（联合五元）、`platform/src/admin/routes.ts`（`pluginSourcesRoutes` 之后 `app.register(webToolsRoutes, { database, resolveSourceAddress })`）、`schemas/openapi.json`（`pnpm contract:write`）；AGENTS.md 由 orchestrator 改。(1) `webToolsRoutes`（Fastify plugin，options = `AdminConfigOptions`）经 `registerConfigRoute` 注册：`name: 'web-tools'`、`path: '/_platform/api/admin/web-tools'`、`auditType: 'web-tools.updated'`、`bodySchema`/`responseSchema` 同为 `{ type: 'object', additionalProperties: false, required: ['webToolsEnabled'], properties: { webToolsEnabled: { type: 'boolean' } } }`、`invalidMessage` 固定为「Invalid web tools setting; provide exactly { webToolsEnabled: boolean }」；`patch(body)`：非普通对象或键集合不恰为 `webToolsEnabled` → null；值非布尔 → null；否则返回 `{ webToolsEnabled }`；`project(settings)` 返回 `{ webToolsEnabled: settings.webToolsEnabled }`。(2) `config-route.ts` 联合各加一项。**测试**：单元——`web-tools.test.ts` 经 `withApp`：GET 初始 `{ webToolsEnabled: false }`；PUT `true` 成功（存储行恰为 `webToolsEnabled` = `true` 且其余播种行不变、审计一行 `web-tools.updated` 带 actor/source、`target_email` 为空、细节 `{}`、响应 `{ webToolsEnabled: true, runningInstances }`、随后 GET 为 `true`）；再 PUT `false` 回到初始；400 清单（每例后 settings 与审计不变、响应与日志不含输入 SENTINEL，标签写明各自隔离的规则）：`null` body（对象规则）、数组 body 与字符串 body（信封形状）、空对象（键集合与布尔规则：只删其中一条仍被另一条拒绝）、多余键 `{ webToolsEnabled: true, [SENTINEL]: 1 }`（键集合规则）、`'true'`/`1`/`null` 值（布尔规则，三例）；存储故障参数化 `audit`/`write`（`BEFORE INSERT` 触发器）→ 500 固定体、settings 等于触发器建立前快照、审计不变、随后 GET 200，`corrupt-json`/`corrupt-type`（改坏 `webToolsEnabled` 行为 `{secret` / `"yes"`）→ GET 与 PUT 均 500；四例断言 secret/`SQLITE`/触发器名不进响应与日志。集成——`admin-web-tools.integration.test.ts` 经 `withListeningApp` 真实 TCP：匿名 401、员工 403（GET/PUT 都不动 settings，固定错误体）；管理员 GET `false` → PUT `true` 200 → GET `true`；`delayedConfigBody` 在 body 已被接收后撤销会话/降级 → 401/403 固定错误体且无写入无审计；一次 400（值 `'on'`）快照（含已保存的 `true`）不变；审计行 actor 为该管理员、`target_email` 为空。**命令**：`pnpm test`（逐文件 80%）、`pnpm test:integration platform/test/admin-web-tools.integration.test.ts`、`pnpm contract:check`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（现有用例，无新 Docker 用例）。**交接**：覆盖层按本键决定是否移除 `@deepseek-ai/dsh-tool-web`（11.4）；后台开关保存区与审计页中文名（11.5）。

Risk packs (11.4，#407): fixture level expanded（与 issue 建议一致）。selected - Schema（四处形状钉死。① `ManagedConfigInput` 新增四个必填字段：`webToolsEnabled: boolean`、`pluginRegistries: readonly string[]`（非空，否则 `TypeError`）、`registryProbeEnabled: boolean`、`pluginCatalog: readonly { id: string; category: 'required' | 'manageable'; state: CatalogState }[]`（即 `catalogStates(catalog, settings)` 的投影，按目录文件顺序；类型从 `plugin-catalog/index.ts` 导出，不另造）；`ManagedComposition` 新增 `bundles: readonly { id: string; patch: readonly Json[]; present: boolean }[]`，读取器为每个被请求的目录 id 恰产生一项；调用方只请求处于强制态（`forced-on`/`forced-off`）的可管理 id，`employee` 项不读、不校验。`pluginCatalog` 元素类型是 `catalogStates` 的返回元素：给 `catalog.ts:36` 的 `interface CatalogEntryState` 加 `export` 并从 `plugin-catalog/index.ts` 再导出（`CatalogState` 本身从 `db/index.ts:13` 来），不另造类型。② 安装源与探测两行取代现钉死行的位置（locale 与目录行之后、`auto-review` 之前）：`{ id: 'plugin-manager', config: { registry: pluginRegistries[0], fallbackRegistries: pluginRegistries.slice(1) } }` 与 `{ id: 'ui-plugin-manager', config: { registryProbeEnabled } }`；dsh-base `cordis.patch.yml:20-22` 的 `plugin-manager` 行只有 `disabled: !!js`、没有 `config`，dsh-web-app `cordis.patch.yml:318-319` 的 `ui-plugin-manager` 行没有 `config`，所以整配置替换不丢任何上游值；值原样写出，不做 DSH 自己的 `normalizeRegistry`。③ 联网工具：`webToolsEnabled` 为 false 时保持 `REMOVED_TOOLS` 过滤与根行 `{ id: 'tool-web', disabled: true }`；为 true 时两者都不写（dsh-web-app `cordis.patch.yml:579-580` 自身已把该根行 `disabled: true`，覆盖层不再管它，预设按自身组成保留两类工具）。④ 目录项按 `pluginCatalog` 顺序紧随 `...localePatch` 之后写出：`required` 的 `state` 必须是 `forced-on`，否则 `TypeError`，必启项的激活仍是现有的 `platform-nav`/`managed-permissions` insert 与 locale 行、不随状态变化；`manageable` + `employee` 不写任何行；`manageable` + `forced-on`：该 bundle `present` 时对其规范 patch 每个顶层 `insert` 条目的 id 写 `{ id, disabled: false }`，`present` 为 false 时按原顺序写出规范 patch 的全部行（其中 `name` 为 `@deepseek-ai/dsh-agent-preset` 的 insert 条目经与观测预设相同的联网工具过滤）；`manageable` + `forced-off`：不论 `present`，对规范 patch 每个顶层 insert 条目 id 写 `{ id, disabled: true }`，这些 id 不再经 `...presets` 整行写出，并把规范 patch 中非 insert 的覆盖行还原——只支持 `agent-preset-registry`，写 `{ id: 'agent-preset-registry', config: { default: 'standard' } }`（DSH 发行默认，dsh-web-app `cordis.patch.yml:586-589`；不还原则 `retain()` 对已停用的默认预设抛 `agent-preset/not-found`，dsh-agent-preset-registry `lib/index.js:632-639`，新建 Session 失败），其他目标的覆盖行抛 `TypeError`。不看 `present` 的原因：DSH 在运行中也会重组并追加覆盖层（dsh-plugin-manager `lib/index.js:1657,2363` 经 `readProfilePatches` 重建，dsh-app-boot `lib/index.js:1127-1132` 追加 `--patch` 文件），员工在插件页勾选一个启动时缺席的 forced-off bundle 时，覆盖层里已有的停用行与还原行立即生效；启动时目标不存在只是 `applyEntryPatches` 的告警跳过（`lib/index.js:61-104`），`patch: entry … not found` 不在 credential-priority 用例的失败标记清单里。forced-on 不能同样处理：insert 不幂等。可管理项处于任一强制态而其 `patch` 为空 → `TypeError`：静默忽略管理员的强制设置是误配置）、Config（迁移 5 初始设置下输出 `registry` = `https://registry.npmjs.org/`、`fallbackRegistries` = `["https://registry.npmmirror.com/"]`、`registryProbeEnabled: true`、联网工具仍去除、目录项不多写一行——与 DSH 0.2.1-rc.2 的实际效果一致而非字面一致：DSH 的 `registry` 无 schema 默认，缺省时走 pnpm 自身配置（dsh-plugin-manager `lib/index.js:1580,1617`），覆盖层显式写出后员工 profile 的 `.npmrc` 不再起作用；两个内网源加探测关闭 → 恰好这两个源、顺序不变、探测为 false）、Public API（`readManagedComposition(execute, bundleIds: readonly string[])`：镜像内脚本对每个 id 读 `/opt/dsh-team/<id>/package.json` 的 `dsh.bundle.patch`，用 dsh-app-boot 的 `loadOverlayPatches` 解析，`!!js` 保持为 `{ __jsExpr }` 原样进 JSON，与现有 localePatch 一致——Loader 在实例内以 profile 目录为 `baseUrl` 求值（dsh-app-boot `lib/index.js:4525`），`/data/home/profiles/web/node_modules/@dsh-team/office-agents` 登记副本仍在时可解析；patch 文件路径用 dsh-app-boot 导出的 `bundlePatchPaths` 解析（`dsh.bundle.patch` 可以是字符串或列表，多文件按顺序拼接）；`present` = 顶层 insert 条目 id 全部出现在观测组成的 id 集合（`collectHost` 的 `seen`），部分出现 → `Invalid managed composition`（只对被请求的强制态 id 判定；`patch` 为空数组时 `present` 恒为 false）；目录缺失、无 `package.json`、无 `dsh.bundle.patch` 一律 `Invalid managed composition`。`{ __jsExpr }` 原样进 JSON 的先例是观测预设整行写出时已带的办公预设 `customSkillDirs` 表达式（zh-locale 的 patch 没有 `!!js`）。orchestrator：`createOrchestrator` 构造时 `readPluginCatalog()` 一次存入 owner（与 `routes.ts:212` 同一函数，启动期两次读同一文件，缺失都在监听前失败），经 `start-identity.ts:21` 内部 `StartUserContainerInput` 的新字段 `pluginCatalog` 传入 `startUserContainer`，`orchestrator.ts:32` 对外的 `StartUserContainerInput` 把它与 `client`/`database`/`transport` 一起 `Omit` 掉，公开输入形状不变；`start.ts` 在现有 `readSettings` 处多取四键，`catalogStates(catalog, settings)` 中强制态的可管理 id 传给组成读取器、整个投影传生成器）、Determinism（相同输入逐字节相同；目录数组顺序即输出顺序，不读 settings 记录的键序）、Error handling / rollback（生成器所有拒绝都是同步 `TypeError`，在 `start.ts` 的 `managed overlay` 阶段抛出，走既有回滚路径——此时网桥已创建、容器未创建；读取器拒绝是 `Invalid managed composition`，仍在 `managed composition` 阶段）、Legacy compatibility（观测预设仍整行写出；`agent-default-model`、权限、凭据隔离、`platform-nav` 行与顺序不变；四个输入字段全部必填、无默认、无透传旁路，每个调用方同 PR 更新）、Documentation（AGENTS.md：web-tools bullet 整句「The setting is storage and audit only until the overlay generator (11.4) consumes it; …」、plugin-sources bullet 的「Overlay consumption (11.4) and the admin page (11.5) are later tasks」、plugin-catalog bullet 的「the overlay consumption belongs to a later task」、`tool-plugin-market` 段「still removes only」、用户镜像段「forced-on display and that uninstall entry are owned by tasks 11.4/11.5」都改为实际行为，并新增一条 Environment bullet 描述覆盖层按设置输出；`docs/DEPLOY.md:55`「目前仍关闭插件页的公共仓库探测（`registryProbeEnabled: false`…）」改为管理员配置；spec「纯生成受管覆盖层」的可信输入扩为「canonical 中文插件 patch 与强制态 bundle 的 canonical patch 及其出现情况」）。not selected - Auth / permissions（无 HTTP 面）、Concurrency（无新共享状态）、File IO / path safety（读取器在实例内 root 只读的 `/opt/dsh-team` 读，宿主侧无新文件访问）、Release / packaging（不改镜像）、Performance（读取器多读一个 1 KiB 的 patch 文件）。**不变量**：生成器是纯函数；覆盖层是最后一层，员工 home patch 对预设行 `disabled` 的改写被其后的目录行覆盖；`employee` 项不出现在覆盖层。**Must preserve**：模型/权限/凭据/`platform-nav` 行与相对顺序；模型未配置 → `unconfigured`；观测预设整行写出与（开关关时的）联网工具去除；`writeManagedConfig` 与 `start.ts` 其它阶段不变。**同级面**：`managed-policy-oracle.ts:261`（探测现为管理员值，初始 true：期望值由夹具传入而非写死 false）、`managed-policy.integration.test.ts:67,140`、`generate.test.ts:446-470,839`（钉死行与根 `tool-web` 行用例改为按开关两态）、所有 `generateManagedConfig` 调用方：`credential-priority-fixture.ts`、`model-refusal-fixture.ts`、`managed-policy-fixture.ts`（`collectComposition` 传可管理 id）、`permission-browser-fixture.mjs`、`office-delegation.docker.test.ts`、`permission-tiers.docker.test.ts`、`write.test.ts`、`start-identity.test.ts`，以及 `container-start-fixture.ts` 的 `COMPOSITION`。**残余（只记录）**：forced-on 下员工在运行中重新勾选一个已被覆盖层插入规范行的 bundle 会得到重复 id，直到下次启动（11.6 不覆盖）；forced-on 且启动时在场的 bundle 被员工在运行中取消勾选后，其预设消失直到下次启动（覆盖层的 `disabled: false` 行只告警）；镜像更新改动某 bundle 的 insert id 时，未重置 profile 的强制态员工在 `managed composition` 阶段失败，需管理员重置配置；forced-on 下员工原生卸载 bundle 后登记副本消失，规范行的 `!!js` 技能目录在实例内解析失败、预设 broken（#509/11.6 观测）；员工 `selectedDefault` 指向已停用预设由 DSH 自身报错；forced-off 时覆盖层把 `agent-preset-registry` 整配置改回 `standard`，员工 home patch 或第三方层对注册表默认预设的设定在该状态下失效。**宽度**：按证据段清单估算 450–550 行，本 PR 打 `diff-limit-exempt`，理由：四个输入字段、读取器 `bundles`、生成器规则与全部调用方更新是一条验证路径（生成器、读取器、start 的单元测试加既有 Docker 套件），拆成「先安装源/联网工具、后目录项」会让第二刀的读取器与生成器规则没有独立可验收的切面。

Evidence (11.4，#407): **现状**：`platform/src/managed-config/generate.ts:60` 的 `REMOVED_TOOLS` 无条件生效、`:170` 写根行 `{ id: 'tool-web', disabled: true }`、`:199` 钉死 `{ id: 'ui-plugin-manager', config: { registryProbeEnabled: false } }`，`ManagedConfigInput`（`:35-54`）没有开关、安装源与目录字段；`read.ts:3` 的 `ManagedComposition` 只有 `presets`、`localePatch`，`:15-50` 的镜像内脚本只读 profile 层、home patch 与规范 locale patch；`start.ts:498` 只取 `cpuCores`、`memoryMiB`、`defaultPermissionTier`，`:551` 调 `composition()`，`:567-573` 调 `generateManagedConfig`；`orchestrator.ts:309` 的 `createOrchestrator` 不读目录；`admin/routes.ts:212` 在构造时 `readPluginCatalog()` 一次；`plugin-catalog/catalog.ts:86-96` 的 `catalogStates` 已给出每项的有效 `state`。**改动点**（只改 `platform/src/managed-config/{generate.ts,generate.test.ts,read.ts,read.test.ts,index.ts,write.test.ts}`、`platform/src/orchestrator/{orchestrator.ts,orchestrator.test.ts,start.ts,start.test.ts,start-identity.ts,start-identity.test.ts}`、`platform/src/plugin-catalog/{catalog.ts,index.ts}`（`CatalogEntryState` 加 `export` 并再导出）、`platform/test/{container-start-fixture.ts,managed-policy-oracle.ts,managed-policy.integration.test.ts,managed-policy-fixture.ts,credential-priority-fixture.ts,model-refusal-fixture.ts,permission-browser-fixture.mjs,office-delegation.docker.test.ts,permission-tiers.docker.test.ts}`；AGENTS.md 由 orchestrator 改）。(1) `generate.ts`：输入加四字段；`filterPlugins` 按 `webToolsEnabled` 决定是否过滤，根 `tool-web` 行同条件；`...input.localePatch` 之后按 Risk packs ④ 写目录行，再写 `plugin-manager` 与 `ui-plugin-manager` 两行取代钉死行；`forced-off` 的 bundle insert id 从 `input.presets` 的整行写出中剔除；常量 `RELEASE_DEFAULT_PRESET = 'standard'` 注明来源。(2) `read.ts`：`readManagedComposition(execute, bundleIds)`，脚本中对每个 id 读 `/opt/dsh-team/<id>/package.json`、`loadOverlayPatches` 其 `dsh.bundle.patch`，输出 `bundles: [{ id, patch, present }]`；`projectComposition` 校验每项、`present` 由 `seen` 计算、部分出现即 `invalid()`。(3) `orchestrator.ts`：构造时 `readPluginCatalog()` 存入 owner，经 `start-identity.ts` 内部输入的新字段 `pluginCatalog` 传给 `startUserContainer`，对外类型 `Omit` 掉该字段；`start.ts`：`readSettings` 多取 `pluginRegistries`、`registryProbeEnabled`、`webToolsEnabled`、`pluginCatalog`，`catalogStates(catalog, settings)`，强制态的可管理 id 传 `composition()`、投影与三键传生成器。(4) 每个 `generateManagedConfig` 调用方补四字段（Docker 夹具用迁移默认值：空目录状态、默认源、探测开、联网关），`collectComposition`/`COMPOSITION` 补 `bundles`。(5) `managed-policy-oracle.ts` 的 `assertManagedPolicyRuntime` 期望改为比较夹具给出的探测值，`managed-policy.integration.test.ts:67,140` 随之翻转。(6) AGENTS.md 如 Risk packs Documentation。**测试**：单元——`generate.test.ts` 组合矩阵：联网开关两态（关：现有过滤与根行；开：顶层与嵌套 group 中任意 id 的 `@deepseek-ai/dsh-tool-web` 全部保留、根行不写、输入不变）；安装源（初始设置 → DSH 默认两值与探测 true；两个内网源 + 探测关 → 恰好两源顺序不变、探测 false；空数组 → `TypeError`）；目录：必启项状态非 `forced-on` → `TypeError`；`employee` 不多写一行且观测预设照常写出；`forced-on` + present → 每个 insert id 一行 `disabled: false`；`forced-on` + absent → 规范行按原顺序写出，含 `agent-preset-registry` 覆盖行，开关关时 insert 预设里的联网工具被去除、开关开时保留；`forced-off` + present → 每个 insert id 一行 `disabled: true`、这些预设不再整行出现、`agent-preset-registry` 还原为 `standard`；`forced-off` + absent → 同样的停用行与还原行；单一输入含一个必启项与三个合成可管理 bundle（insert id 互不相同、仅一个覆盖 `agent-preset-registry`，状态分别为 `employee`/`forced-on`/`forced-off`）逐项断言输出行，`employee` 项的预设按观测整行写出不变；强制态 + 空 patch → `TypeError`；规范覆盖行目标不是 `agent-preset-registry` → `TypeError`；相同输入两次逐字节相同；输出顺序 locale → 目录行 → `plugin-manager` → `ui-plugin-manager` → `auto-review`，并保留现有「profile/locale 层试图重开探测被其后行覆盖」用例的语义（改为管理员值）。`read.test.ts`：脚本只请求给定 id、`dsh.bundle.patch` 为字符串与列表两种形式都经 `bundlePatchPaths` 解析；`present` 真/假/部分（部分 → `Invalid managed composition`）；空 patch → `present: false`；缺 `package.json`/缺 `dsh.bundle.patch`/非数组 patch → 拒绝；`{ __jsExpr }` 原样保留。`start.test.ts`：保存的四键到达覆盖层内容（源、探测、开关、`office-agents: forced-off` 产生的停用行与还原行），组成读取脚本只收到强制态的可管理 id（`employee` 时不请求任何 bundle）；`orchestrator.test.ts` 按需补目录读取。集成——`pnpm test:integration platform/test/managed-policy.integration.test.ts` 在新默认（探测 true）下通过。Docker——不新增用例（11.6）；既有 `first-use`、`office-agents`、`managed-policy`、`credential-priority`、`model-refusal`、`permission-tiers`、`office-delegation` 等套件在 VPS exact-head 全量通过即为覆盖层仍可启动真实 DSH 的证据。**命令**：`pnpm test`、`pnpm test:integration platform/test/managed-policy.integration.test.ts`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`。**关键路径**：触及 `platform/src/orchestrator/`，PR 描述写明需要人工逐行审查，推迟到 Epic #380 完成时，不视为已通过。(7) `docs/DEPLOY.md:55` 由 orchestrator 改。**交接**：员工插件页的锁定显示与把目录状态发布到 `platform-nav` 行 `config`（#509，依赖本任务、阻塞 #409）；后台页（#408）；Docker 浏览器与出口观测用例（#409）；知识库、ONLYOFFICE、better-sidebar 等后续可管理项的激活行由各自任务扩展生成器的目录规则（第 12、18 组）。

Risk packs (11.4b，#509): fixture level expanded（与 issue 建议一致）。selected - Schema（三处形状钉死。① 覆盖层 `platform-nav` 行的 `config` 由 `{ admin }` 变为恰好 `{ admin, pluginCatalog }`，`pluginCatalog` 是对象：键为目录项 `package`（npm 包名），值为 `forced-on` | `forced-off`，只含状态为这两者的目录项（必启项恒为 `forced-on`，`employee` 不出现），键序即 `ManagedConfigInput.pluginCatalog` 的目录文件顺序；纯函数、相同输入逐字节相同。② 宿主半边 `plugins/platform-nav/index.js` 发布的页面全局 `__DSH_TEAM_PLATFORM_NAV__` 由 `{ admin }` 变为 `{ admin, pluginCatalog }`；`config.pluginCatalog` 缺省视为 `{}`（兼容只写 `admin` 的旧行），存在时必须是普通对象，每个键匹配 `^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$`、每个值是两态之一，否则 `apply` 抛 `TypeError`（文案不回显输入；生成器保证合法，抛错只会出现在被篡改的行上，且会被既有「插件失败标记」检查发现）。③ 客户端半边的 DOM 契约：对 `pluginCatalog` 中每个包 P，注入**一个** `<style data-dsh-team-plugin-lock>`（放在 `document.head`，整页只一个），规则把 `[data-plugin-package="P"] button[role="switch"]`（列表卡片的 bundle 开关）与 `[data-plugin-detail="P"] > :first-child button[role="switch"]:last-of-type`（详情页顶部操作区 `detailActions` 的最后一个 `<button>` 就是 bundle 开关，client `:2853-2883`；必须用 `:last-of-type` 而不是 `:last-child`，因为锁定标记插在开关之后，`:last-child` 会在插入后失配、让原生开关重新显示；`span` 不改变 `:last-of-type` 的匹配；详情页下方的行级开关不受影响；`plugins.detail.actions` slot 渲染在同一操作区的最前面，直接放在操作区里的 slot 开关之后总有 bundle 开关，永不匹配，只有某插件往该 slot 放一个包在自己容器里、且是该容器最后一个 `<button>` 的 `role="switch"` 时才会误中——目前没有已交付插件往该 slot 放开关，列为残余）设为 `display: none !important`；并用一个 `MutationObserver`（`document.body`，`childList` + `subtree`）只处理每条记录的**新增节点**：新增的元素本身不匹配、子树里也没有 `[data-plugin-package]`/`[data-plugin-detail]` 时直接返回（不做整文档查询），因为必启项恒为 `forced-on`，`pluginCatalog` 在真实部署中永不为空，这个观察器在每个 DSH 页面（含聊天流式输出）上常驻；命中时只在新增子树内查找强制包的两个开关，在每个被隐藏开关之后插入恰好一个 `<span data-dsh-team-plugin-lock="forced-on|forced-off">`，文本 `已开启 · 由管理员设定` 或 `已关闭 · 由管理员设定`；插入幂等（同一父节点已有则不再插），只插入自己的节点，绝不修改、移除 DSH 渲染的任何节点或属性（含 `data-plugin-status`、`aria-checked`）；全局缺失、无效或为空时不注入样式、不建观察器）、Public API（DSH 原生「添加插件」、更新、卸载入口全部保留，样式只命中两个 `role="switch"` 选择器；不注册任何新的 DSH slot，不改 `package.json` 的 `dsh.client.inject`；侧栏「账号设置」「管理后台」入口行为不变）、Auth / permissions（原生开关被隐藏后不可点击、不可聚焦，锁定标记是不可交互的 `span`，因此强制项卡片上没有能发出 `pluginManager.setBundleEnabled` 的控件；客户端没有任何 Remote/网络访问，单元测试继续断言不调用 `fetch`、不写 `console`）、Legacy compatibility（`employee` 项与非目录包的卡片、开关、详情页完全不变；只写 `admin` 的旧覆盖层行仍可用）、Documentation（`plugins/platform-nav/README.md` 由实现者更新：页面全局的新字段、锁定显示机制与 DOM 契约、已接受残余；`openspec/changes/stage-2-dsh-ragflow-office/specs/managed-config/spec.md` 由编排者以 MODIFIED「受管覆盖层启用平台入口插件」同步（主规格 `openspec/specs/managed-config/spec.md:314-320` 只写了 `config.admin`，归档时由该 delta 更新）；AGENTS.md 由编排者同 PR 改写三处：第 162 行附近「registers one `sidebar.footer.action` entry … published by its host half as the `__DSH_TEAM_PLATFORM_NAV__` page global」一句补上 `pluginCatalog` 与锁定装饰，以及第 196 行末句「The overlay still cannot change the plugin page's `enabled` checkbox … #509 owns the locked display.」与第 301 行「Required-item cards are therefore initially unchecked … forced-on display and that uninstall entry are owned by #509 …」改为实际机制）；Error handling（宿主半边对非法 `config.pluginCatalog` 抛 `TypeError` 时，整个 platform-nav 插件加载失败：该实例侧栏的「账号设置」「管理后台」入口也随之消失，不只是锁定显示失效——这是有意的大声失败，生成器保证合法，只有被篡改的行会走到这里，且既有「插件失败标记」检查会让 Docker 用例失败；客户端遇到非法全局只是不装饰，不抛错；证据：`index.test.js` 每类非法输入一例、`client.test.js` 非法全局一例）、Resource limits（常驻观察器的每次回调只看新增节点、无关变更零整文档查询零插入；证据：`client.test.js` 一例在聊天式大量无关节点追加下断言 `querySelectorAll` 只在新增子树上调用、没有插入）；not selected - Concurrency（只读页面全局、同步装饰）、File IO（不读写文件）、Release（无新依赖、无新运行时文件：装饰代码留在既有 `client.js`，`images/dsh-user/Dockerfile` 的 platform-nav 文件清单不变）、Config（无新设置；数据来源是 #406/#407 已交付的目录状态）。关键路径：`platform/src/orchestrator/start.test.ts` 只同步 `platform-nav` 行断言（测试文件）；`plugins/platform-nav/` 随镜像交付进 `images/dsh-user/` 产物——PR 写明关键路径人工逐行审查推迟到 Epic #380 完成，未通过。Governing invariant：员工插件页上每个强制项的 bundle 开关都不可交互，且锁定标记的开/关恰等于覆盖层里该包的强制状态；非强制项的 DSH 原生行为一字不变。Sibling surfaces：`platform/src/managed-config/generate.ts`（`platform-nav` 行）、`platform/test/admin-config-activation.docker.test.ts:263-291`（对 `platform-nav` 插入行做精确 `toEqual`）、`plugins/platform-nav/{index.js,client.js}` 与其测试、`scripts/probe-plugin-page.mjs`（`requireCards`/`switchSettled`）与 `platform/test/probe-plugin-page.integration.test.ts`、`platform/test/first-use.docker.test.ts`（`pluginExpectations`/`expectPluginPage`/`observePlugins`），以及依赖本任务的 #409（11.6）。

Evidence (11.4b，#509): **现状**（DSH 发行版 0.2.1-rc.2，编排者从本地构建的用户镜像只读提取 `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`，sha256 `b4efaa441258a547a0d7b3cab559fe073c69e69fe2bbb617c710ded134e7c4f9`，与 `@deepseek-ai/dsh-plugin-manager/lib/index.js`）：卡片 `PackageCard`（client `:2618-2665`）是 `<li data-plugin-package={pkg.name} data-plugin-status=…>`，唯一的 `role="switch"` 是 `EnableSwitch`（`:2493-2499`，`checked: pkg.enabled`、`label: 启用 {title}`、`disabled: busy || readOnlyReason…`），状态只体现在开关上，卡片没有可见状态文字（只有 `problem`/缺文件/有更新的标签）；详情页根 `<div data-plugin-detail={pkg.name}>`（`:2843-2845`），第一个子元素是 `DetailTop`，其操作区依次是 `plugins.detail.actions` slot、更新按钮、卸载按钮、`EnableSwitch`（`:2853-2883`），行级开关在后面的主体里；插件管理器声明的 slot 只有 `plugins.item`、`plugins.bundle.activation`、`plugins.bundle.config`、`plugins.row.config`、`plugins.detail.{actions,badge,section}`（`:4432-4448`），没有卡片级 slot，也没有开关装饰点；原生锁定形态 `readOnlyReason` 只由宿主 `protectsManager`（host `:2312-2323`）对含插件管理模块的 bundle 设置，不可配置。切换走 `ctx.remote.pluginManager.setBundleEnabled`（client `:1157`）。`plugins/platform-nav/index.js:7-18` 只发布 `{ admin }`，`client.js` 只注册 `sidebar.footer.action`；`generate.ts:327-335` 写 `config: { admin: input.admin }`，行形状断言在 `generate.test.ts:671` 与 `platform/src/orchestrator/start.test.ts:253`；`images/dsh-user/catalog.json` 4 项（`office-agents` manageable、`imageDefaultEnabled: true`；`permission-tiers`、`platform-nav`、`zh-locale` required）；规格里的第四个必启项「Office 提示」尚未进目录，随其任务加入后自动被同一机制覆盖。`scripts/probe-plugin-page.mjs:138-148` 的 `requireCards` 目前要求三张必启项卡片 `checked:"false"`、`status:"disabled"`，`switchSettled`（`:98`）要求开关可用。**改动点**（实现者）：`platform/src/managed-config/generate.ts` 与 `generate.test.ts`、`generate-catalog.test.ts`（新增：默认设置 → `pluginCatalog` 恰为三项必启 `forced-on`、键序 `@dsh-team/permission-tiers`、`@dsh-team/platform-nav`、`@dsh-team/zh-locale`；`office-agents` 为 `forced-off`/`forced-on` 时它以目录顺序排在最前；`employee` 不出现；逐字节确定）、`platform/src/orchestrator/start.test.ts`（只同步行断言）、`platform/test/admin-config-activation.docker.test.ts:263-291`（两处期望改为 `{ admin: false|true, pluginCatalog: { "@dsh-team/permission-tiers": "forced-on", "@dsh-team/platform-nav": "forced-on", "@dsh-team/zh-locale": "forced-on" } }`，否则 exact-head `pnpm test:docker` 必然失败）；`plugins/platform-nav/index.js`、`index.test.js`（缺省 `{}`、合法发布、每类非法输入抛 `TypeError` 且文案不含输入）、`client.js`、`client.test.js`（改为 `// @vitest-environment jsdom`，保留既有 `react-test-renderer` 用例；新增：无全局/空/非法全局 → 无样式无观察器；大量无关节点追加时观察器回调不做整文档查询、不插入；合法全局 → 恰一个样式元素且只含对应包的两条规则；先渲染后到达与先装饰后渲染两种顺序下，卡片与详情页开关之后都恰有一个锁定标记、文本对应两态；重复变更不重复插入；详情页插入锁定标记之后原生开关的计算样式仍是 `display: none`、锁定标记是它的后继兄弟；行级开关、非强制包卡片、添加/卸载按钮不受影响；DSH 节点属性不被改写；仍不调用 `fetch`/`console`）、`types.d.ts`/`client.types.d.ts`（类型同步）、`README.md`；`scripts/probe-plugin-page.mjs` 与 `platform/test/probe-plugin-page.integration.test.ts`（期望里新增 `locked` 映射，锁定包的 CDP DOM 事实：原生开关元素存在且 `getComputedStyle(sw).display === 'none'`、`sw.getClientRects().length === 0`，用 CDP 按 Tab 遍历卡片区域时 `document.activeElement` 从不等于该开关，恰一个锁定标记且 `data-dsh-team-plugin-lock` 与文本匹配状态；`switchSettled` 只用于非锁定包；新增断言：以 CDP `Input.dispatchMouseEvent` 在一个必启项卡片锁定标记的中心做真实指针点击、再按一次 Enter 与空格，然后重载，锁定标记不变、原生开关 `aria-checked` 不变——禁止对隐藏的原生按钮调用 `.click()` 或派发合成事件，`display:none` 挡不住程序派发的点击，那会真的发出 `setBundleEnabled`；打开一个必启项详情页，在锁定标记已插入之后，顶部 bundle 开关满足同样的未渲染事实、锁定标记是它的后继兄弟、卸载入口仍在）、`platform/test/first-use.docker.test.ts`（`pluginExpectations` 改为三张必启项卡片锁定开启、办公 bundle 按 `employee` 与镜像默认可切换，原有往返与重启持久断言不变，截图数按实际 legs 更新）。编排者：AGENTS.md 三处（见 Documentation）。**测试与验证**：`pnpm check`（含 `typecheck` 的 platform-nav tsconfig、逐文件覆盖率 80%、`duplicate-code`、`dead-code`）；VPS exact-head `pnpm test:docker`（first-use 插件页用例跑在真实 DSH 0.2.1-rc.2 上，是 DOM 契约的唯一真实证据）与 `pnpm test:deploy`，清理确认；截图留存（列表、详情、锁定后重载）。实现者不跑 Docker。**PR 体量**：目标 ≤ 400 行，超出只因测试时按先例加 `diff-limit-exempt`。**规格对应**：强制项卡片仍是一张「带开关的卡片」——开关位置换成平台的锁定标记，它以「已开启/已关闭」标明当前状态并写明「由管理员设定」，满足 plugin-catalog「员工插件页每个预装项都有开关」与 user-image「预装项在插件页都有开关」对强制项的要求；非强制项保留原生可用开关。场景到证据：「必启项在员工侧锁定开启」（四张中的三张，Office 提示待其任务加入目录）与「员工自选的项可以切换」由本任务的 first-use Docker 用例证明；「强制关的项员工打不开」「强制开的项员工关不掉」在本任务只有 jsdom 单元测试，真实 Docker 证据归 #409。**已接受残余**：安装向导的 `enableInstalled`（client `:1789-1797`）与更新的重装路径会调用 `setBundleEnabled(name, true)`——员工先用保留的原生卸载入口卸掉强制项、再经「添加插件」装回时会走到，实际生效状态仍由覆盖层强制，只改变显示与 profile 清单；强制 bundle 详情页下方的行级开关仍可切换（覆盖层在下次启动与运行中重组时都排在最后，员工改动不生效，只是显示可动）；原生卸载入口对强制项保留（卸载 forced-on 项的 profile 副本不影响其由覆盖层激活，见 AGENTS.md 已列残余）；卡片的 `data-plugin-status` 仍反映 profile 清单成员资格而非实际生效状态；DOM 契约绑定 DSH 0.2.1-rc.2 的属性与结构，DSH 升级时由 first-use Docker 用例重新验证。**不做**：#409 的全部用例（强制关/强制开组合、出口观测、员工改写后重启）、ONLYOFFICE（#436）、任何 DSH 源码或构建期补丁、新增 slot 注册。

Risk packs (11.5，#408): fixture level expanded（与 issue 建议一致）。selected - Public API（新页面地址 `/_platform/admin/plugins`，导航名「插件目录」；`platform/src/web/routes.ts` 的静态页面清单加这一项，与既有页面同样只答 GET/HEAD、`sendFile('index.html')`，尾斜线、子路径、`%00`、`%2f` 仍 404；`account-page.tsx` 的路径分派加一支；`AdminNavigation` 的 `page` 联合加 `'plugins'`，链接排在「运行参数」之后、「账号设置」之前；不新增、不改任何 HTTP 接口，`schemas/openapi.json` 不变）、Auth / permissions（页面进入时并发发出三个已交付接口的 GET——`/_platform/api/admin/plugin-catalog`、`/plugin-sources`、`/web-tools`——作为当前权限探测，**等三个请求全部结算、响应体全部读完之后**才按优先级决定：任一 401 → `window.location.assign('/_platform/login')`（只此一次导航）＞ 任一 403 → 只显示 `无权限`（`role="alert"`），不渲染任何目录行、地址、开关或保存按钮 ＞ 其他任一失败 → 整页失败态 ＞ 三个都 200 → 就绪；不得在兄弟请求仍在途时导航（否则产生 `net::ERR_ABORTED`，见 AGENTS.md 开发笔记 9）。保存时的 401/403 与 `runtime-page.tsx:127-131` 相同：PUT 401 → `assign('/_platform/login')`，PUT 403 → 页面只剩 `无权限`、三个表单全部移除；两者都不写设置、不写审计（服务端已保证）。页面只调用这三个接口，不调其他 `/_platform/api/`）、Concurrency / shared state（三个保存区共用**一个**页面级 pending 锁（同 `runtime-page.tsx:112-164` 的 `owner` ref 与 `current()` 失效判定）：加载或任一保存进行中，三个表单的 `fieldset` 都 `disabled`、所有保存按钮不可点，杜绝重复与交叉提交；离开页面中止在途请求；每个响应体在结算前读完（含 400/500），过期响应不覆盖当前状态；保存成功只用该保存区自己的响应更新该区草稿，另两区草稿不动）、Error handling（加载中：只显示 `加载中…`（状态行），不渲染任何表单；加载：三个 GET 都 200 才进入就绪；任一非 401/403 的失败 → 整页失败态 `插件目录加载失败，请重试。` 加「重试」按钮（重新发三个 GET），不显示任何部分数据；保存 400：插件目录 → `插件目录状态无效，请刷新后重试。`；安装源 → 若服务端文案匹配 `/^pluginRegistries\[(\d+)\]/` 则显示 `第 <下标+1> 行的安装源地址无效：须以 http:// 或 https:// 开头且不含空白。`，否则 `至少填写一个安装源。`（空列表与信封错误；文本框为空时发送 `pluginRegistries: []`，得到信封 400 与这一行，而不是 `[""]`）；联网工具 → `联网工具设置无效，请刷新后重试。`；其他非 200 → 该区 `保存失败，请重试。`；页面从不显示服务端 message 或响应体原文，只显示上述固定中文）、Config（三个保存区，各自一个 `<form>`、一个保存按钮、一个提交成功后的 `保存时运行中的实例数：<n>（非实时统计）。` 行：① 「预装插件」表单（`aria-label="预装插件"`，按钮「保存插件目录」）逐行显示目录文件顺序的每一项：中文名 `name`、包名 `package`、镜像默认（`imageDefaultEnabled` → `默认开启`/`默认关闭`）、状态；`required` 项状态显示为不可交互的文字 `强制开（必启，不可修改）`，不渲染下拉框；`manageable` 项是一个带可访问名（`<中文名> 的管理状态`）的 `<select>`，三个选项 `员工自选`/`强制开`/`强制关` 对应机器取值 `employee`/`forced-on`/`forced-off`；PUT body 恰为 `{ entries: [{ id, state }] }`，按 GET 顺序覆盖全部条目，必启项固定发 `forced-on`；目录为空时显示 `镜像未随附预装插件。` 且不显示保存按钮。② 「安装源」表单（`aria-label="插件安装源"`，按钮「保存安装源」）：一个 `<textarea>`（标签 `安装源地址（每行一个，第一行为主安装源）`）与一个复选框 `开启仓库探测`；提交时：文本框为空串 → `[]`；否则按 `\n` 切分、去掉每行末尾的 `\r`、只忽略文本末尾的一个空行，其余各行逐字作为 `pluginRegistries` 项（不去重、不去空白、不改写），`registryProbeEnabled` 取复选框；提示文案写明第一行是安装源、其余是备用源，地址中的凭据会对每个员工实例可见，内网部署应填内网源并关闭探测。③ 「联网工具」表单（`aria-label="联网工具"`，按钮「保存联网工具设置」）：一个复选框 `允许联网搜索与抓取工具`，PUT body 恰为 `{ webToolsEnabled }`。页面顶部（三个表单之上）一行固定提示 `修改在每个实例下次启动时生效；保存不会重启正在运行的实例。`）、Documentation（AGENTS.md 由编排者同 PR 更新：「Static delivery declares …」一句加入 `/_platform/admin/plugins`；`plugin-sources` 条目里的「the admin page (11.5) is a later task」与受管覆盖层生成器条目末句「save its intranet mirror and probe-off through `PUT /_platform/api/admin/plugin-sources` right after upgrading (the admin page is #408)」改为指向该页面；审计页 `platform/web/src/audit-page.tsx` 的 `EVENT_NAMES` 补上 11.3 推迟到本任务的三个事件中文名：`plugin-catalog.updated` → `修改插件目录`、`plugin-sources.updated` → `修改插件安装源`、`web-tools.updated` → `修改联网工具开关`，使筛选下拉与行显示中文）；not selected - Schema（无接口、数据库、迁移变化）、Legacy compatibility（既有页面行为不变；`admin-navigation.test.tsx` 只扩表）、File IO、Resource limits、Release（无新依赖）。Office 不可用时显示 ONLYOFFICE 停用原因属于 #436（18.2），本任务不做；员工插件页锁定显示属于 #509。规格里员工侧的重启效果——「强制关闭后下次启动生效」「内网部署关闭探测并填写内网源」「联网工具默认关闭」中重启后工具出现——由 11.4（#407）的覆盖层生成与 Docker 证据承担（锁定显示另由 #509）；「非法状态被拒绝」与「安装源地址校验」的接口侧由 #406/#444/#445 已合入的接口测试承担，本任务只覆盖页面对 400 的呈现。无关键路径文件。Governing invariant：页面上任何一次 PUT 发出时，没有其他请求在途，且它的 body 只来自该保存区当前草稿；任何 401/403 之后页面不再显示任何配置数据。Sibling surfaces：`runtime-page.tsx`（单保存区模板）、`model-page.tsx`（多行编辑与保存提示）、`admin-runtime.ui.test.ts`（真实接口保存、拒绝、截图、`observeAccountUi` 的模式）、`admin-ui-fixture.ts` 的 `withAdminUi`/`holdAdminList`/`failAdminList`/`expectPlatformLogin`。

Evidence (11.5，#408): **现状**：后台页面是单个 `index.html` 加客户端路径分派（`platform/web/src/account-page.tsx:65-71`，`vite.config.ts` `base: '/_platform/'`）；`platform/src/web/routes.ts` 的静态清单是 9 个字面路径（到 `/_platform/admin/runtime`），`routes.test.ts:90,104-112,150-156` 分别逐页覆盖 GET、HEAD 与拒绝变体；`admin-navigation.tsx` 的 `page` 联合是 `accounts|instances|audit|models|runtime`，`admin-navigation.test.tsx` 只覆盖其中四个（漏 `instances`）；三个接口已由 #406/#444/#445 交付（`platform/src/admin/plugin-catalog.ts`、`plugin-sources.ts`、`web-tools.ts`，都经 `registerConfigRoute`，PUT 响应附 `runningInstances`）；`images/dsh-user/catalog.json` 4 项，只有 `office-agents` 是 `manageable`（`imageDefaultEnabled: true`），`permission-tiers`/`platform-nav`/`zh-locale` 是 `required`；安装源初始值是 `["https://registry.npmjs.org/","https://registry.npmmirror.com/"]` 加探测开启，联网工具初始关闭；`audit-page.tsx:4-24` 的 `EVENT_NAMES` 没有三个插件事件。**改动点**（实现者：新建 `platform/web/src/plugins-page.tsx` 与同目录 `plugins-page.test.tsx`（jsdom，沿用 `platform/web/test/account-dom-fixture.tsx`）、`platform/test/admin-plugins.ui.test.ts`；修改 `platform/web/src/account-page.tsx`（分派一支）、`admin-navigation.tsx` 与其测试（加 `plugins`，并把漏掉的 `instances` 补进 `it.each`）、`audit-page.tsx` 与其测试（三个事件名）、`platform/src/web/routes.ts` 与 `routes.test.ts`（新路径进 GET、HEAD、拒绝三张表），样式只在 `platform/web/src/style.css` 复用既有 `admin`/`admin-content`/`field` 等类，必要时为目录表格加最少的新类；编排者：AGENTS.md）。若新页面与既有页面的请求骨架构成 jscpd 克隆，允许在 `platform/web/src/` 新建一个小的共享模块（带同目录测试），并把与之构成克隆的那个既有页面改用它——行为不变、该页面既有测试一字不改且仍通过；`pnpm duplicate-code` 必须仍低于 3%，阈值不动。**测试**：(a) `plugins-page.test.tsx` 用桩 `fetch` 覆盖：`加载中…` 且无表单、三 GET 成功渲染（必启项是文字不是下拉框，可管理项下拉三选项与当前值，页顶提示逐字）、任一 GET 401 → `assign('/_platform/login')` 且仅在三个都结算后调用一次、403 → 只有 `无权限` 且无表单、混合结果（403+401 → 只导航登录；200+200+500 → 失败态且无任何部分数据）、500 → 失败态与「重试」重新发三个 GET、目录为空文案、保存时 PUT 401 → 导航登录、PUT 403 → 只剩 `无权限`、空文本框 → body `pluginRegistries: []` 与「至少填写一个安装源。」、三个保存区各自的 PUT body 逐字（安装源文本的切分：末尾单个空行忽略、中间空行保留为空串项、行内空白原样保留、`\r\n` 去 `\r`）、400 映射（`pluginRegistries[2]` → 「第 3 行…」、信封 400 → 「至少填写一个安装源。」、目录与联网工具的固定文案）、500 → 「保存失败，请重试。」、`runningInstances` 行、保存进行中三个保存按钮都禁用且第二次点击不发请求、卸载中止在途请求、过期响应不覆盖；逐文件覆盖率 ≥ 80%。(b) `admin-plugins.ui.test.ts`（真实应用、SQLite 与三个接口，`withAdminUi`）：管理员打开页面——目录四行与镜像目录文件逐项一致（中文名、包名、镜像默认、必启三项显示锁定文字），安装源文本框是两行默认源、探测勾选，联网工具未勾选；把 `office-agents` 设为 `强制关` 保存 → 响应 200，`readSettings(database).pluginCatalog` 恰为 `{ "office-agents": "forced-off" }`，新增恰一条 `plugin-catalog.updated` 审计；文本框改为单行 `http://mirror.intranet.invalid/` 并取消探测保存 → `pluginRegistries` 恰为 `["http://mirror.intranet.invalid/"]`、`registryProbeEnabled: false`、恰一条 `plugin-sources.updated`；勾选联网工具保存 → `webToolsEnabled: true`、恰一条 `web-tools.updated`；三个 PUT 的响应体逐字（GET 形状加 `runningInstances: 0`），页面显示 `保存时运行中的实例数：0（非实时统计）。`；页顶提示 `修改在每个实例下次启动时生效；保存不会重启正在运行的实例。` 逐字可见；重载后三区显示保存后的值；第二行填 `ftp://mirror.invalid/` 保存 → 400，页面显示「第 2 行…」，settings 与审计行数不变；保存进行中（挂住一个真实 PUT：给 `admin-ui-fixture.ts` 的 `holdAdminList` 加方法参数，不另写近似副本）另两个保存按钮禁用；挂住一个真实 GET 时只见 `加载中…`、无表单；一次受控的 GET 500（`failAdminList`）→ 失败文案、不回显诊断，「重试」随后对真实接口成功；员工账号打开 → 403 页面只有 `无权限`，没有任何表单或数据；会话失效（登出后）打开 → 回到登录页；页面就绪后删除管理员会话（或降权）再点保存 → 分别回到登录页或只剩 `无权限`，settings 与整张审计表不变，留截图（同 `admin-runtime.ui.test.ts:145-175`）；桌面与窄屏截图（`expectViewportLayout`，前缀 `glass-admin-plugins`，无横向溢出），`observeAccountUi` 只列三个接口，`expectHealthy` 只允许本用例明确制造的状态，零控制台错误、零外部请求、`otherMutations` 为空、无浏览器存储；审计页筛选下拉的选项文本恰含 `修改插件目录`、`修改插件安装源`、`修改联网工具开关`（可在同一文件或 `admin-audit` 的 UI 用例里断言一次）。(c) `routes.test.ts`、`admin-navigation.test.tsx`、`audit-page.test.tsx` 扩表。**验证**：`pnpm check`（含 lint、typecheck、单元/覆盖率、集成、build、contract、`duplicate-code`、`dead-code`）与 `pnpm test:ui`（实现者跑一次全量，贴通过数；新文件单独再跑一次）；PR 附截图说明；VPS exact-head `test:docker` 与 `test:deploy` 证据（本任务不改 Docker 用例，预期与 #512 一致）；不涉及 RAGFlow/Office，不需要 `test:stack`。**PR 体量**：目标 ≤ 400 行，若只因测试文件超出，按 #496/#512 的先例加 `diff-limit-exempt` 并在正文写明超出部分是测试。**不做**：员工插件页锁定显示（#509）、ONLYOFFICE 停用原因（#436）、任何接口或覆盖层改动、安装源的去重或归一化、对已运行实例的重启。

## 12. 每次启动的实例令牌和文件令牌密钥

依赖：无。关键路径 `platform/src/orchestrator/`。

- [x] 12.1 每次启动生成 32 字节随机的 ONLYOFFICE 文件令牌密钥，作为 `DSH_TEAM_ONLYOFFICE_FILE_SECRET` 注入容器，不持久化，加入日志脱敏。验证：单元测试覆盖每次启动生成不同的值、值不进入实例行、日志、审计和错误信息；`pnpm test:docker` 断言容器环境里有该值、平台数据库里没有，再次启动后值改变。
- [x] 12.2 每次启动生成 32 字节随机的实例令牌，作为 `DSH_TEAM_INSTANCE_TOKEN` 注入容器。新增迁移，实例行只保存令牌的 SHA-256；空闲、管理员、禁用、出错和对账这几种停止路径都清除哈希；重启时轮换。令牌和哈希都加入日志脱敏。验证：单元测试覆盖生成、轮换和每一种停止路径的清除；迁移账本断言更新；`pnpm test:docker` 断言容器环境里有令牌、数据库里只有哈希，停止后哈希为空，再次启动后哈希改变。

Suggested fixture level: expanded - 关键路径，新增注入容器的密钥
Minimal mergeable slice: 12.1 文件令牌密钥的生成和注入单独合入（没有持久化，插件补丁之前没有读取方，不改变行为）
Risk packs (12.1): selected - Auth / permissions / secrets（新的注入容器的密钥：生成、注入、不持久化、不进入日志/审计/错误）、Public API（创建请求体 `Env` 形状，现有精确断言随之更新）、Error handling（启动失败路径的消息与 `last_error` 不得携带该值）；not selected - Config（无新配置）、File IO、Schema（无迁移，12.2 才有）、Concurrency（沿用现有每用户队列与启动飞行）、Resource limits、Legacy compatibility（旧容器无该变量，没有读取方，无需兼容）、Release（镜像不变）、Documentation（AGENTS.md 环境段在 12.2/18.1 接上读取方时再补）。
Evidence (12.1): 每次被准入的启动在 `startUserContainer` 内用 `node:crypto` `randomBytes(32)` 生成一个值，以 64 位小写十六进制编码，作为 `DSH_TEAM_ONLYOFFICE_FILE_SECRET=<hex>` 追加到员工容器 `/containers/create` 的 `Env`（紧随 `<apiKeyEnv>=<modelKey>` 之后，顺序固定）；compose/profile-restore 等 `NetworkMode: none` 的辅助容器 `Env` 不含它；同一用户复用已运行容器时不生成新值（不重建容器就没有注入点）。不持久化：`instances`、`creation_attempts`、`audit_events` 任何列都不出现该值；不写入覆盖层文件；不进入 `StartResult`、实例列表/状态 API。脱敏：该值在代码里只以 `fileTokenSecret` 命名传递，`platform/src/app.ts` 的 `LOG_REDACT_PATHS` 增加 `fileTokenSecret` 与 `*.fileTokenSecret`（与 `apiKey`/`modelApiKey` 同列）；现有 `startupFailure` 只保留封闭的失败类别，创建失败时的错误消息、`cause` 和 `last_error` 不得包含该值。单元测试（`start.test.ts`，经 `platform/test/container-start-fixture.ts` 假 daemon）：两次独立启动（停止后再启动，或两个用户）得到不同的 64 位十六进制值；员工容器创建体 `Env` 精确等于 `['DSH_HOME=/data/home','DSH_TELEMETRY_DISABLED=1','<apiKeyEnv>=<key>','DSH_TEAM_ONLYOFFICE_FILE_SECRET=<hex>']`，辅助容器创建体 `Env` 不含该前缀；启动成功后 `instances`/`creation_attempts`/`audit_events` 全表序列化后不含该值；让假 daemon 在创建或启动时失败，断言抛出的错误消息、`cause` 序列化与行内 `last_error` 都不含该值；`app.test.ts`（或现有日志脱敏用例）断言含 `fileTokenSecret` 字段的日志对象被写成 `[redacted]`。就绪日志尾部进入 `last_error` 的路径：`platform/src/orchestrator/readiness-logs.test.ts` 加用例，输入整行 `DSH_TEAM_ONLYOFFICE_FILE_SECRET=<64hex>` 与单独一行 `<64hex>`，断言两行都被 `safeLine` 丢弃（DSH 不读该变量也不回显 Env，这是防御性证据）。Docker（`pnpm test:docker platform/test/container-start.docker.test.ts` 现有 `startupScenario` 的两次启动循环，不新建流程）：attempt 0 的 `docker inspect` `Config.Env` 含 `DSH_TEAM_ONLYOFFICE_FILE_SECRET=<值>`（“包含”断言，镜像自带 ENV 也在其中），值匹配 `/^[0-9a-f]{64}$/`，10 个并发启动共用一个容器只有一个值；在 fixture 对 attempt 0 容器做精确 force-DELETE 前取出该值，attempt 1 重新启动后的值与之不同且同样匹配；平台 SQLite 文件的全部表序列化不含任一值；辅助容器 `Env` 不含该前缀。管理员停止后再启动的变体若要补，放 `admin-instance-restart.docker.test.ts`，不在本任务范围。非阻塞：`validateModelEnvironment` 的禁用名单可加 `DSH_TEAM_ONLYOFFICE_FILE_SECRET`（生产 `apiKeyEnv` 为常量，仅防御）。PR 描述须写明 `platform/src/app.ts` 的脱敏路径是任务点名（“加入日志脱敏”）的配置改动。Must preserve：`DSH_TEAM_MODEL_API_KEY`（即 `apiKeyEnv`）注入与校验、`Env` 既有三项的顺序、启动失败分类与补偿路径、辅助容器不携带任何密钥、读取该变量的插件补丁属 18.1（本任务没有读取方，不改变实例行为）。
Risk packs (12.2): selected - Schema（新迁移 4 给 `instances` 增加 `instance_token_hash TEXT` 列；集成测试迁移账本断言、`schema.test.ts`、`scripts/e2e-scenario.sh` 与 AGENTS.md 验证矩阵的版本列表同步到 1–4）、Auth / permissions / secrets（令牌生成、注入、只存 SHA-256、每种停止路径清除、重启轮换、令牌与哈希都脱敏）、Public API（创建请求体 `Env` 增至 5 项，现有精确断言随之更新；实例列表/状态/网关解析输出不暴露哈希）、Error handling（创建失败、启动失败、就绪失败、补偿与创建恢复路径的消息、`cause`、`last_error` 不含令牌或哈希，且这些路径都清除哈希）、Legacy compatibility（阶段 1 存量行迁移后该列为 NULL，其余列不变，对账把它们当作正常幸存者；升级前写入的 `creation_attempts.prior_instance_hash` 在迁移 4 之后仍被接受，启动对账不因此失败）；not selected - Config（无新配置）、File IO（不写覆盖层）、Concurrency（沿用每用户队列与同一启动飞行：10 个并发启动共用一个容器只有一个令牌）、Resource limits、Release（镜像不变）、Documentation（AGENTS.md 只改账本版本列表；读取方的环境说明归 14.1）。
Evidence (12.2): 生成与注入——`createInstance` 在生成文件令牌密钥的同处用 `randomBytes(32).toString('hex')` 生成实例令牌，员工容器 `/containers/create` 的 `Env` 精确等于 `['DSH_HOME=/data/home','DSH_TELEMETRY_DISABLED=1','<apiKeyEnv>=<key>','DSH_TEAM_ONLYOFFICE_FILE_SECRET=<hex>','DSH_TEAM_INSTANCE_TOKEN=<hex>']`（令牌追加在最后）；辅助容器 `Env` 不含 `DSH_TEAM_INSTANCE_TOKEN=` 前缀；`validateModelEnvironment` 禁用名单加入该名。哈希是对注入的 64 位十六进制字符串本身（即 14.1 将收到的 Bearer 字符串）做 SHA-256 后的 64 位小写十六进制，与 `auth/session.ts` 的会话哈希约定一致；`createInstance` 返回 `{ id, attempt, instanceTokenHash }`，令牌原文只进入创建体（不进入返回值、`attempt` 记录；「不被闭包捕获」为 review-only，由评审者按 diff 核对）。持久化——`persistCreatedInstance` 在绑定 `container_id` 的同一 INSERT/UPSERT 里写入 `instance_token_hash`（状态 `starting`）；`readiness.ts` 的 `running` 更新与 `CURRENT_INSTANCE` 围栏不变、不动该列；同一用户复用 `starting`/`running` 行时沿用既有哈希（`start.test.ts` 加用例：复用运行中行后 `instance_token_hash` 与复用前相同，且无新的创建请求）。迁移——`platform/src/db/migrations/4-instance-token-hash.sql` 只含 `ALTER TABLE instances ADD COLUMN instance_token_hash TEXT;`；账本断言改为 `[1,2,3,4]`（`platform/test/db.integration.test.ts` 两处、`platform/src/db/schema.test.ts`、`scripts/e2e-scenario.sh`），AGENTS.md 验证矩阵 Database 行改为「versions 1 to 4」。升级证据放 `db.integration.test.ts` 的 1→4 历史升级用例：其 `instances` `toMatchObject` 加 `instance_token_hash: null`；`schema.test.ts` 的 `SELECT_INSTANCE` 显式列表与 `STOPPED_INSTANCE` 同步加该列（该文件在 `:memory:` 上全量迁移，不是升级证据）。创建尝试摘要兼容——`creation-attempt.ts` `instanceHash` 改为按迁移 4 之前 `SELECT *` 的列序显式选列 `user_id,status,container_id,upstream_host,upstream_port,dsh_cookie,image_tag,last_started_at,last_activity_at,last_error,image_id`（不含 `instance_token_hash`），使升级前写入的 `prior_instance_hash` 字节不变地继续匹配；`creation-attempt.test.ts` 加用例：用 `applyMigrations(db, dir)` 只应用复制到临时目录的 1–3 号迁移，写入 `starting` 行与真实摘要（对 `SELECT *` 行 `JSON.stringify` 后 SHA-256）的 pending attempt，再 `applyMigrations(db)` 到 4，经假 daemon 走恢复路径，断言恢复成功（行变为 `error`、`last_error` 为 `Interrupted container creation recovered`）而不是抛 `Container creation identity changed`；该用例在改 `instanceHash` 前必须红。该 pending attempt 必须具备合法 provenance（UUID v4 `attempt_id`、对齐的 `/28` `network_subnet`、绝对 `overlay_path`、`sha256:` `image_id`、64 位十六进制 `network_id`），且 `container_id` 非空；假 daemon 中该 ID、`dsh-team-u-<user>` 与网络均不存在（`container_id` 为 NULL 会走隔离分支而非恢复）。该用例自建 `:memory:` 数据库与 `startupDaemon()`/`createDockerClient` 编排器（`startupOwnerFixture` 会应用全部迁移，或给它加可选迁移目录参数），并写入 `created_at` 与 attempt 一致的用户。清除——`stop.ts` `commit` 的唯一退役 UPDATE 加 `instance_token_hash = NULL`，覆盖 idle（`IdleChecks` → `orchestrator.stopUserContainer`）、admin/restart 与 disabled（`instance-service` stop）、error 与对账（`reconcile.ts` 两处 reason `error`，`audit/record.ts` 的 reason 集合封闭）；保留容器的出错转换 `start.ts` 补偿 UPDATE 与 `readiness.ts` 就绪失败 UPDATE，以及 `creation-attempt.ts` 创建恢复 UPSERT 同样置 NULL；`start-identity.ts` 期望停止快照加 `instance_token_hash: null`。`CURRENT_RETIREMENT` 围栏不加该列（哈希不是身份）。每个清除断言的起始行必须预置非空哈希，否则断言在未改代码时也会通过：`stop.test.ts` 以 `it.each(['idle','admin','disabled','error'])` 对预置哈希的运行行退役后断言该列 NULL；`reconcile.test.ts` 已有「rejected platform attachment retires into atomic error/null state」用例在起始行（`container-reconcile-fixture.ts` 或用例内 UPDATE）预置哈希后断言 NULL，并加用例：哈希为 NULL 的阶段 1 运行幸存者对账后保持 `running`、哈希仍 NULL、无停止请求与审计；`readiness.test.ts` 就绪失败用例在起始行预置哈希后断言 NULL、就绪成功用例断言哈希保持；`creation-attempt.test.ts` 恢复用例的先前行须是带哈希的已核实缺失运行行（而非 `stopped`），恢复后断言 NULL；`start.test.ts` 补偿路径（`confirmedStarted` 后失败）断言哈希 NULL。字面行期望同步：`stop.test.ts` 的整行 `toEqual`、`platform/test/container-reconcile-fixture.ts` `stoppedRow()`、`platform/test/container-stop.integration.test.ts` 与 `platform/test/instance-idle.integration.test.ts` 的整行停止期望加 `instance_token_hash: null`；`platform/test/container-start.integration.test.ts` 的整行 starting 期望加 `instance_token_hash`（等于创建体令牌的 SHA-256）；`platform/test/container-reconcile.docker.test.ts` 幸存者退役期望 `{...survivor.row, ...}` 加 `instance_token_hash: null`（该用例只在 VPS Docker 通道运行，本地不会暴露）。`start.test.ts` 补偿用例先断言持久化后哈希非空再断言补偿后 NULL。`instanceHash` 的列表加注释：冻结为迁移 4 之前的 `SELECT *` 列序，新列不得追加。脱敏——`LOG_REDACT_PATHS` 加 `instanceToken`、`*.instanceToken`、`instanceTokenHash`、`*.instanceTokenHash`、`instance_token_hash`、`*.instance_token_hash`。不暴露——管理员实例列表只选显式列（无需新用例，PR 描述写明理由）、`GET /_platform/api/instance` 只返回 `{status, reason}`、网关解析只返回 host/port/cookie、`StartResult` 不含哈希：单元测试断言 `startUserContainer` 返回值与 `service.status` 序列化不含令牌或哈希。单元测试（假 daemon）：`start.test.ts` 精确 5 项 `Env`；启动后行内 `instance_token_hash` 等于对创建体令牌计算的 SHA-256；全表序列化不含令牌，哈希只出现在 `instances` 该列（`creation_attempts`、`audit_events` 不含）；管理员停止后再启动得到不同令牌与哈希，旧哈希不再出现在任何表，且重启后行内 `instance_token_hash` 精确等于第二次员工容器创建体中 `DSH_TEAM_INSTANCE_TOKEN` 值的 SHA-256（非空，覆盖 `persistCreatedInstance` 的 `ON CONFLICT DO UPDATE` 分支）；现有 hostile-daemon 回显用例扩展为同时回显令牌与哈希并断言消息、`cause`、`last_error` 都不含；`app.test.ts` 断言含 `instanceToken`/`instanceTokenHash`/`instance_token_hash` 顶层与嵌套字段的日志被写成 `[redacted]`；`readiness-logs.test.ts` 的防御性用例可选（12.1 已证明同模式），超 400 行时先删。规格「旧令牌访问平台代理被拒绝」由 14.1 的代理鉴权用例验证，本任务没有读取方。Docker：`container-start.docker.test.ts` 的 `startupScenario` 两次启动循环——attempt 0 的 `Config.Env` 恰有一条 `DSH_TEAM_INSTANCE_TOKEN=<64hex>`，`instances.instance_token_hash` 等于其 SHA-256，整个 SQLite 文件序列化不含令牌、哈希只出现在该列；force-DELETE 前取出令牌与哈希，attempt 1 两者都不同（这是核实缺失后的替换，不是停止路径）；辅助容器 `Env` 不含该前缀（`container-start-docker-fixture.ts` 现有断言扩展）。`container-stop.docker.test.ts` 的 `retirementScenario`——`startUserContainer` 之后、`stopUserContainer({reason:'idle'})` 之前新增 SELECT 读取 `userId` 的 `instance_token_hash` 并断言非空；停止后现有显式列 SELECT 加 `instance_token_hash` 为 null（真实 `stop.ts` 路径）；stop/delete/recreate 之后断言新哈希非空且与停止前不同；摘要字段若加须同步该 `it` 的精确摘要匹配，超 400 行时只保留断言不加字段。把 12.1 的 `injectedFileTokenSecret` 泛化为 `injectedEnvSecret(env, name)` 供两种密钥共用（单一实现）。PR 不超过 400 行：Docker 断言复用现有循环与 SELECT，不新建流程；admin/disabled 合入同一 `it.each`。Must preserve：12.1 的文件令牌密钥行为与用例、`Env` 前四项顺序、启动失败分类与补偿路径、停止审计 `details` 仍只含 `{reason}`、`idle.ts` 快照比较字段不变、`readiness.ts` `running` 更新与 `CURRENT_INSTANCE`/`CURRENT_RETIREMENT` 不变、对账幸存者判定（`reconcile.ts`）不读哈希、升级前的 `creation_attempts` 行仍为当前且可恢复（启动对账不失败）、管理员列表投影不变、阶段 1 存量行（哈希 NULL）继续有效、无新 HTTP 路由（契约不变）、令牌不写覆盖层也无容器内读取方（14.1 之前不改变实例行为）。

## 13. RAGFlow 连接设置和检索参数

依赖：10（RAGFlow 相关 PR 的本机证据）。

- [ ] 13.1 新增设置迁移，保存 RAGFlow 地址、密钥和检索参数：top_k、相似度阈值、关键词权重、rerank。新增后台接口 `GET/PUT /_platform/api/admin/ragflow-config`（审计 `ragflow-config.updated`）和 `GET/PUT /_platform/api/admin/retrieval-config`（审计 `retrieval-config.updated`）：密钥只返回「已配置」，省略时保留原值，空值拒绝；保存与审计同在一个事务内。密钥加入日志脱敏。验证：集成测试覆盖校验、权限、回滚、审计和迁移账本；`pnpm contract:check` 通过。
- [ ] 13.2 「测试连接」接口 `POST /_platform/api/admin/ragflow-config/test` 调用版本接口，再用已存密钥做一次只读库列表查询验证密钥（design 决定 3），按响应体 `code` 判断成败，不写审计。请求固定超时、不跟随重定向、限制响应体大小；结果为 `ok` 或 `not-configured`、`unavailable`、`timeout`、`upstream-error` 之一，不含上游内容和密钥。`ok` 时回应带版本字符串（不超过 64 个字符的可打印 ASCII），版本缺失、类型不对或超长时结果为 `upstream-error`，失败结果不带版本。验证：集成测试用自有的假 RAGFlow HTTP 服务覆盖成功（回应含版本）、版本缺失、版本非字符串、版本超长、HTTP 200 加非零 code、密钥被拒、超时、拒绝连接、重定向，并断言审计行数不变，回应中没有地址和密钥。
- [ ] 13.3 后台「知识库」页：连接配置、检索参数、测试连接（每个结果取值一条不同的中文说明，成功时显示 RAGFlow 版本），提示「保存即生效」。验证：`pnpm test:ui` 通过，断言成功结果显示版本，有截图。

Suggested fixture level: expanded - 新增外部凭据的保管和后台写入口
Minimal mergeable slice: 13.1 设置和接口单独合入（还没有消费者，不改变运行行为）

Risk packs (13.1 连接配置，#410): fixture level expanded（与 issue 建议一致）。13.1 按宽度拆成两个 issue：本 issue 交付共用的设置迁移、密钥保管和 `ragflow-config` 接口；`retrieval-config` 接口和它的审计事件属于 #446，#446 只读写本迁移建好的检索参数，不再新增迁移。

selected：

- **Schema**：
  - 迁移 6 `platform/src/db/migrations/6-ragflow-settings.sql` 用 `INSERT OR IGNORE` 播种六行（键名和默认值见 design 决定 3「其他约定」的表）：`ragflowBaseUrl` `""`、`ragflowApiKey` `""`、`retrievalTopK` `8`、`retrievalSimilarityThreshold` `0.2`、`retrievalKeywordsWeight` `0.7`、`retrievalRerankId` `""`。
  - `Settings` 接口和 `DEFAULT_SETTINGS` 加同名六个字段。`parseOwned` 的取值域：
    - `ragflowApiKey`、`retrievalRerankId` 是字符串；
    - `ragflowBaseUrl` 是 `''`（未配置），或满足下面地址规则的字符串；
    - `retrievalTopK` 是 1..100 的安全整数；
    - 两个比例是闭区间 0..1 内的有限数。
  - 地址规则由 `db/settings.ts` 导出唯一实现 `isRagflowBaseUrl(value)`，本 PR 的路由 `patch` 与 settings 层都调用它，14.1 代理复用，不复制。规则先检查原始字符串，再做解析检查，因为 `URL` 解析会把 `?`/`#` 空串、`@` 空 userinfo 和中间换行都静默吞掉：
    - 原始串不超过 2048 个字符；
    - 原始串匹配 `/^[^\s\x00-\x1f\x7f]+$/`：挡住首尾和中间的空白字符，以及 C0 控制字符和 DEL（`\S` 本身放行 `\x01` 这类控制字符）；
    - 原始串不含 `?`、`#`、`@`、`\`；
    - `new URL()` 能解析，协议是 `http:` 或 `https:`；
    - 允许路径，原样保存，不规范化末尾斜杠，拼接交给 14.1。原始串检查保证字符串拼接 `/api/v1/...` 不会落进 query 或 fragment。
  - 接口形状：
    - GET `/_platform/api/admin/ragflow-config` 恰好返回 `{ baseURL: string, apiKeyConfigured: boolean }`。`apiKeyConfigured` 为 `ragflowApiKey.trim() !== ''`。字段名沿用 `model-config`。
    - PUT body 是对象，只允许 `baseURL`（必填）和 `apiKey`（可选）。
    - `baseURL` 必须是非空且满足地址规则的字符串。
    - `apiKey` 省略时保留已存值；非空白字符串替换已存值；空串、全空白或非字符串返回 400。
    - 首次保存可以不带 `apiKey`，此时 `apiKeyConfigured` 为 `false`，代理按 `not-configured` 处理（14.1）。
    - 成功响应是 GET 的形状，加上共用提交边界附加的 `runningInstances`。
    - 存储只写 `ragflowBaseUrl`，以及给出时的 `ragflowApiKey`；检索参数四行不动。
- **Auth / permissions / secrets**：
  - 沿用 `registerConfigRoute`：`adminRoutes` 的 `onRequest` 先挡匿名和员工；body 读完后在同一事务里重核当前活动管理员；401/403 时不写设置、不写审计。
  - 密钥从不进入响应（只投影 `apiKeyConfigured`）、审计（细节 `{}`）和日志。路由只记固定的 `storageFailure` 文案。
  - `app.ts` 的 `LOG_REDACT_PATHS` 加 `ragflowApiKey` 和 `*.ragflowApiKey`；请求体字段 `apiKey` 已由 `req.body.apiKey` / `*.apiKey` 覆盖。
- **Error handling / rollback**：
  - `patch` 只返回 `null` 或补丁，不抛出。信封不合法时返回固定 400，文案不回显输入。
  - 地址不满足规则时，`patch` 调 `isRagflowBaseUrl` 返回 `null`，与信封错误统一回固定 `invalidMessage`（同 `plugin-sources` 用 `REGISTRY_URL` 的先例）。settings 层的同一检查是不变量兜底，经路由不会触发。
  - 存储损坏或审计写入失败时返回 500 固定体，整体回滚。
- **Public API**：
  - `config-route.ts` 的 `name` 联合加 `'ragflow'`，`auditType` 联合加 `'ragflow-config.updated'`。
  - `audit/record.ts` 的 `EVENT_DETAIL_FIELDS` 加 `'ragflow-config.updated': []`，`record.test.ts` 的封闭集合清单同步。`retrieval-config.updated` 不在本 issue。
  - `db/index.ts` 转出 `isRagflowBaseUrl`。
- **边界外改动**（issue 的 PR Boundary 字面只列 `platform/src/admin/`、`platform/src/db/`、`schemas/openapi.json`，以下由任务文字授权）：
  - `platform/src/audit/record.ts` 和 `record.test.ts`：审计事件 `ragflow-config.updated`；
  - `platform/src/app.ts` 和 `app.test.ts`：「密钥加入日志脱敏」；
  - `scripts/e2e-scenario.sh` 与 `platform/test/*` 的账本断言：「新增迁移同步更新迁移账本断言」；
  - `platform/src/admin/model-probe.test.ts:7` 与 `platform/src/managed-config/model-settings.test.ts:5`：构造完整 `Settings` 字面量，新字段使类型检查要求补齐；
  - `SEEDED_SETTINGS` 的 13 个引用文件（见同级面）。
- **Legacy compatibility**：
  - 既有五条配置路由的请求、响应和审计都不变。`readSettings` 遇到未知键仍然跳过。
  - 迁移只新增行；已有数据库上 `INSERT OR IGNORE` 不覆盖已有的同名键。
- **Documentation**（由 orchestrator 改）：
  - AGENTS.md 验证矩阵的 Database 行把「versions 1 to 5」改为「1 to 6」。
  - Environment 段在 `web-tools` 条目之后，记录本接口和迁移 6 的形状、校验与密钥保管。

not selected：

- File IO：不读文件。
- Concurrency：单事务。
- Release / packaging：不改镜像。
- Performance：body 受 Fastify 默认 1 MiB 上限。

**不变量**：

- 存储中的 `ragflowBaseUrl` 永远是 `''` 或合规地址，六个字段永远在各自的取值域内；由 `parseOwned` 保证；路由 `patch` 先用同一个 `isRagflowBaseUrl` 校验，不合规回固定 400。
- 密钥明文只存在于 SQLite 行里。
- 400 文案只含固定文字或字段名，不含任何输入字节。

**Must preserve**：

- `model-config`、`runtime-config`、`plugin-catalog`、`plugin-sources`、`web-tools` 的请求、响应与审计不变。
- `registerConfigRoute` 的提交边界语义不变。
- 迁移 1–5 的内容不变，`applyMigrations` 的账本语义不变。

**同级面**：

- 迁移账本断言：`platform/src/db/migrate.test.ts:146`（标题「through 5-plugin-settings」）与 `:151`、`platform/src/db/schema.test.ts`、`platform/test/db.integration.test.ts:346,438`、`platform/test/admin-plugin-catalog.integration.test.ts:64`，以及 e2e 的 `scripts/e2e-scenario.sh:109`。
- `platform/test/admin-config-fixture.ts` 的 `SEEDED_SETTINGS`：`settingsRows` 按 key 排序（`:26`），改后恰为十行，依次是 `pluginCatalog` `{}`、`pluginRegistries`（原值）、`ragflowApiKey` `""`、`ragflowBaseUrl` `""`、`registryProbeEnabled` `true`、`retrievalKeywordsWeight` `0.7`、`retrievalRerankId` `""`、`retrievalSimilarityThreshold` `0.2`、`retrievalTopK` `8`、`webToolsEnabled` `false`（value 为 JSON 文本，如 `'""'`、`'0.7'`）；`:14` 注释改为「Migrations 5 and 6 seed these rows」。引用它的 13 个文件：`platform/src/admin/` 的 `plugin-sources`、`runtime-config`、`web-tools`、`config-route`、`plugin-catalog`、`model-config` 六个测试，`platform/src/db/settings.test.ts`，`platform/test/` 的 6 个集成测试。按下标取值的两处必须改为按 key 构造：`plugin-sources.test.ts:40,43`（`SEEDED_SETTINGS[0]`/`[3]`）、`web-tools.test.ts:42`（`.slice(0, 3)`）；`settings.test.ts:60` 标题「exactly the four migration-seeded rows」改为十行。
- 构造完整 `Settings` 字面量的测试：`platform/src/admin/model-probe.test.ts:7`、`platform/src/managed-config/model-settings.test.ts:5`。
- `platform/web/src/audit-page.tsx` 的 `EVENT_NAMES`：中文名和筛选项由 13.3（#412）加，本 issue 不改。
- 14.1 代理复用 `isRagflowBaseUrl` 和这六个设置。

**宽度**：

- 估算：迁移约 7 行；`settings.ts` 约 35 行；路由约 60 行；`config-route.ts`、`record.ts`、`app.ts`、`routes.ts`、`db/index.ts` 合计约 10 行；单元测试约 250 行；集成测试约 110 行；账本断言约 15 行。
- 加上 13 个 `SEEDED_SETTINGS` 引用文件与 `app.test.ts` 的少量改动（约 30 行），合计可能超过 400 行。超出时打 `diff-limit-exempt`，理由是 issue 已声明 atomic：只有共用迁移、密钥保管和连接配置接口这一条验证路径。

Evidence (13.1 连接配置，#410):

**现状**：

- 迁移目录到 `5-plugin-settings.sql` 为止，迁移 5 用 `INSERT OR IGNORE` 播种四行。
- `platform/src/db/settings.ts`：`parseOwned` 用 `STRING_FIELDS` 校验模型字符串，用 `parsePluginSetting` 校验插件键；`readSettings` 跳过 `DEFAULT_SETTINGS` 之外的键。
- `platform/src/admin/config-route.ts:14-21` 的 `name`/`auditType` 联合为五元。
- `platform/src/admin/routes.ts:219` 注册 `webToolsRoutes`。
- `platform/src/audit/record.ts` 的 `EVENT_DETAIL_FIELDS` 中配置类事件到 `web-tools.updated`（`:49`）为止，其后是 `instance.*` 七个事件（`:50-56`），没有 RAGFlow 事件。
- `platform/src/app.ts:33` 的 `LOG_REDACT_PATHS` 含 `apiKey`、`modelApiKey` 及其通配。
- 平台中没有任何 RAGFlow 代码。

**改动点**：

- 新文件：
  - `platform/src/db/migrations/6-ragflow-settings.sql`
  - `platform/src/admin/ragflow-config.ts`
  - `platform/src/admin/ragflow-config.test.ts`
  - `platform/test/admin-ragflow-config.integration.test.ts`
- 修改：
  - `platform/src/db/settings.ts`：六个字段、取值域、`isRagflowBaseUrl`。
  - `platform/src/db/index.ts`：转出。
  - `platform/src/db/settings.test.ts`、`migrate.test.ts`、`schema.test.ts`：账本和新键。
  - `platform/src/admin/config-route.ts`：联合。
  - `platform/src/admin/routes.ts`：在 `webToolsRoutes` 之后执行 `app.register(ragflowConfigRoutes, { database, resolveSourceAddress })`。
  - `platform/src/audit/record.ts` 和 `record.test.ts`。
  - `platform/src/app.ts`：两条脱敏路径；`platform/src/app.test.ts:108`「redacts credentials before they reach the log」在顶层和 `user.` 下各加一个 `ragflowApiKey` marker，断言 `'[redacted]'` 且 marker 不出现（先红后绿）。
  - 账本与 `SEEDED_SETTINGS` 相关测试，以及 `scripts/e2e-scenario.sh` 的账本数组。
  - `schemas/openapi.json`：运行 `pnpm contract:write`。
- AGENTS.md 由 orchestrator 改。

(1) `ragflowConfigRoutes` 经 `registerConfigRoute` 注册：

- `name: 'ragflow'`，`path: '/_platform/api/admin/ragflow-config'`，`auditType: 'ragflow-config.updated'`。
- `bodySchema` 为 `{ baseURL: { type: 'string', minLength: 1, maxLength: 2048 }, apiKey: { type: 'string', minLength: 1 } }`，`required: ['baseURL']`，`additionalProperties: false`。schema 只记录契约，校验在 `patch` 和 settings 里。
- `responseSchema` 为两键对象。
- `invalidMessage` 固定为「Invalid RAGFlow configuration; provide { baseURL: http(s) URL without credentials, query or fragment, apiKey?: non-blank string }」。
- `patch(body)` 在以下情况返回 `null`：不是普通对象、有 `baseURL`/`apiKey` 之外的键、`baseURL` 不是字符串或 `!isRagflowBaseUrl(baseURL)`、给了 `apiKey` 但它不是字符串或 trim 后为空。否则返回 `{ ragflowBaseUrl: baseURL, ...(给了 apiKey ? { ragflowApiKey: apiKey } : {}) }`。
- `project(settings)` 返回 `{ baseURL: settings.ragflowBaseUrl, apiKeyConfigured: settings.ragflowApiKey.trim() !== '' }`。

(2) `settings.ts`：

- `isRagflowBaseUrl` 实现 Risk packs 里的地址规则，`URL` 构造失败时返回 `false`。
- `parseOwned` 新增分支：`ragflowApiKey` 和 `retrievalRerankId` 是字符串；`ragflowBaseUrl` 是 `''` 或 `isRagflowBaseUrl`；`retrievalTopK` 是 `requirePositiveSafeInteger` 且不超过 100；两个比例是 `typeof number`、`Number.isFinite`，且在 0..1 内。其他字段报 `fieldError`。

**测试**：

单元测试 `ragflow-config.test.ts` 经 `withApp`：

- GET 初始值恰好是 `{ baseURL: '', apiKeyConfigured: false }`。
- PUT 带地址和密钥成功：
  - 两行恰为新值；
  - 检索参数四行和其余播种行都不变；
  - 审计一行 `ragflow-config.updated`，带 actor/source，`target_email` 为空，细节为 `{}`；
  - 响应是 `{ baseURL, apiKeyConfigured: true, runningInstances }`，且不含密钥 SENTINEL；
  - 随后 GET 一致。
- 再 PUT 只带新地址：密钥行不变，`apiKeyConfigured` 仍为 `true`。
- 首次只带地址：`apiKeyConfigured` 为 `false`。
- 400 清单。每例之后 settings 与审计都不变，响应和日志都不含输入 SENTINEL，标签写明各自隔离的规则：
  - `null`、数组或字符串 body；
  - 缺 `baseURL`；
  - 有多余键；
  - `baseURL` 是数字；全空白值同时被原始串规则和 URL 解析拒绝，无法隔离到单条规则，由隔离原始串空白规则的用例（内嵌制表符等，URL 解析会静默剥掉）覆盖；
  - `apiKey` 是 `''`、`'   '` 或数字；
  - 地址规则逐条：`ftp:`、带 `user:pass@`、`https://@kb.internal/`、带 `?q`、`https://kb.internal/?`、带 `#f`、`https://kb.internal/#`、首尾空白、中间带空白或换行、`\x01` 控制字符、反斜杠、超过 2048 字符、不能解析；全部回固定 `invalidMessage`。
- 允许带路径（`https://kb.internal/ragflow`），原样保存。
- 日志全程不含密钥 SENTINEL。
- 存储故障按 `audit`/`write` 参数化（`BEFORE INSERT` 触发器）：返回 500 固定体，settings 等于触发器建立前的快照，审计不变，随后 GET 返回 200。
- 改坏数据：`corrupt-json`、`corrupt-type`（`ragflowBaseUrl` 存成 `"ftp://x"`）。GET 与 PUT 都返回 500。

`settings.test.ts`：

- 默认值；
- 六个字段各自的越界与类型错误，逐个点名；
- `retrievalTopK` 的 0、101、1.5，以及比例的 -0.1、1.1、`NaN`（JSON 无法表示的值经 `writeSettings`）；
- 写入后能读回；
- `isRagflowBaseUrl` 的边界。

`record.test.ts`：封闭集合含新事件。

集成测试 `admin-ragflow-config.integration.test.ts` 经真实 TCP 的 `withListeningApp`：

- 匿名返回 401，员工返回 403（GET/PUT 都不动 settings，返回固定错误体）。
- 管理员 GET，PUT 地址和密钥返回 200，再 GET。
- 用 `delayedConfigBody` 在 body 被接收之后撤销会话或降级：返回 401/403 固定错误体，不写入，不审计。
- 审计失败回滚（同 `admin-model-config.integration.test.ts:249`）：先保存地址和密钥 A；建 `BEFORE INSERT ON audit_events` 触发器；PUT 地址和密钥 B 返回 500 固定体；settings 仍是 A（密钥行不变）、审计行数不变；响应和日志不含 B 的 SENTINEL、触发器名和 `SQLITE`。
- 一次 400 之后，快照（含已保存值）不变。
- 审计行的 actor 为该管理员。
- 迁移账本恰为 1..6。
- 响应体、审计行和捕获的日志中都没有密钥 SENTINEL。

**命令**：

- `pnpm test`（逐文件 80%）
- `pnpm test:integration`（全量：账本与 `SEEDED_SETTINGS` 的期望变化波及 7 个集成测试文件）
- `pnpm contract:check`
- `pnpm check`
- VPS exact-head 的 `pnpm test:docker` 和 `pnpm test:deploy`（含 platform-image 的迁移重开）
- 本机 exact-head 的 `pnpm test:stack` 证据评论（本 issue 涉及 RAGFlow；用例没有覆盖本接口，证据只证明入口未回归）

**交接**：

- 检索参数接口和 `retrieval-config.updated`：#446。
- 测试连接：13.2。
- #446 的 PR Boundary 不含 `platform/src/audit/`，但 `retrieval-config.updated` 需要改 `record.ts`（含 `record.test.ts`）和 `config-route.ts` 联合，届时按本条授权。
- 页面与审计中文名：13.3。
- 代理读取与映射：14.x。14.1 拼接前须去掉 `baseURL` 末尾的 `/`（否则 `https://kb/` 拼出 `//api/v1/...`），并以 `new URL()` 解析后的结果为实际连接目标：保存的字符串不一定等于实际主机（IDN、软连字符、`http:kb` 这类合规写法）。补单元测试覆盖 `https://kb/` 与 `https://kb/sub/` 两种 base 拼出的路径。

Risk packs (13.1 检索参数，#446): fixture level expanded（与 issue 建议一致；本接口不涉及凭据，但它是员工检索结果的管理员写入口，沿用同组的 expanded）。selected：

- **Schema**：
  - GET `/_platform/api/admin/retrieval-config` 恰好返回 `{ retrievalTopK, retrievalSimilarityThreshold, retrievalKeywordsWeight, retrievalRerankId }`，即 settings 同名四键的投影。字段名与 settings 键一致，沿用 `runtime-config`、`plugin-sources` 的做法，不另起映射。
  - PUT body 恰为同形状对象，四键都必填，整值替换，没有「省略即保留」。
  - 成功响应 = GET 形状加共用提交边界附加的 `runningInstances`。
  - 存储只写这四个键。`ragflowBaseUrl`、`ragflowApiKey` 和其余设置不动。
- **Config**：
  - 取值域沿用 #410 的 settings 层：`retrievalTopK` 是整数 1..100；两个比例是 0..1 的有限数；`retrievalRerankId` 是字符串。
  - 例外只有一条，放在路由：`retrievalRerankId` 为 `''`（不重排），或首尾没有空白的非空字符串（design 决定 3 表已记录这次收窄）。原因：14.4 会把非空值原样作为 `rerank_id` 发给 RAGFlow，`' '` 或带首尾空白的 ID 会让所有员工的检索失败。它放在路由而不在 settings 层，是因为本 issue 的 PR Boundary 不含 `platform/src/db/`；存储层的取值域仍是 `string`。不设长度上限（上游没有依据）。
  - 默认值是迁移 6 播种的 `8`/`0.2`/`0.7`/`''`。映射见 design 决定 3。
- **Auth / permissions**：沿用 `registerConfigRoute`：
  - `adminRoutes` 的 `onRequest` 先挡匿名和员工；
  - body 读完后在同一事务里重核当前活动管理员；
  - 401/403 时不写设置、不写审计。
- **Error handling / rollback**：
  - `patch` 只做信封检查：不是普通对象、键集合不恰为这四个 → 返回 `null`，回固定 `invalidMessage`。
  - 值域错误（类型不对、越界、`NaN` 无法经 JSON 到达）由 `writeSettings` 抛 `SettingsValidationError`，经既有通道转成 400：消息点名字段，后接 `validationGuidance`（四个取值域的固定文字，满足 spec「指出取值范围」）。原参数不变。
  - 重排模型规则放在 descriptor 的 `validate(settings)`（写入后、审计前，在同一事务内），抛出即 400 加回滚，与 `runtime-config` 的子网容量校验同一机制。消息为固定文字，不回显输入。
  - 存储损坏或审计写入失败时返回 500 固定体，整体回滚。
- **Public API**：
  - `config-route.ts` 的 `name` 联合加 `'retrieval'`，`auditType` 联合加 `'retrieval-config.updated'`。
  - `audit/record.ts` 的 `EVENT_DETAIL_FIELDS` 加 `'retrieval-config.updated': []`，`record.test.ts` 封闭集合同步。这两处超出 issue 字面的 PR Boundary，由 #410 fixture 的交接条目授权。
  - `routes.ts` 在 `ragflowConfigRoutes` 之后注册。
- **Legacy compatibility**：
  - 不新增迁移，不改 `platform/src/db/`。
  - 既有六条配置路由的请求、响应和审计不变。
  - `schemas/openapi.json` 用 `pnpm contract:write` 重生成。
- **Documentation**（由 orchestrator 改）：AGENTS.md Environment 段 `ragflow-config` 条目末句「No route reads RAGFlow yet: the connection test, the retrieval-parameter API, the administrator page and the proxy belong to later tasks.」只删去其中的 `the retrieval-parameter API`；另起一条记录本接口的形状、整值替换、校验规则和审计。

not selected：

- Secrets：本接口没有凭据字段，不新增脱敏路径。
- File IO、Concurrency：单事务。
- Release / packaging。
- Performance：四个标量。

**不变量**：

- 存储中的四个检索参数永远在各自的取值域内：settings 层的 `parseOwned` 保证，路由不复制取值域。
- 经本接口写入的 `retrievalRerankId` 永远是 `''` 或修剪后等于自身的非空字符串（存储层本身只保证是字符串）。
- 400 文案只含固定文字和字段名，不含任何输入字节。

**Must preserve**：

- `model-config`、`runtime-config`、`plugin-catalog`、`plugin-sources`、`web-tools`、`ragflow-config` 的请求、响应与审计不变。
- `registerConfigRoute` 的提交边界语义不变（`validate` 在写后、审计前，失败整体回滚）。

**同级面**：

- `config-route.ts` 联合；
- `record.ts` 封闭集合；
- `routes.ts` 注册顺序；
- `platform/web/src/audit-page.tsx` 的 `EVENT_NAMES`：中文名与筛选项由 13.3（#412）加；
- 14.4 代理读取这四个键；
- `platform/test/admin-config-fixture.ts` 的 `seededWith`，测试用它按 key 构造期望行。

**宽度**：

- 同构的 #410 三件套是 52 + 207 + 168 = 427 行；diff-size-guard 只排除 `pnpm-lock.yaml` 和 `schemas/openapi.json`，本段 fixture 与 AGENTS.md 也计入。预计超过 400 行，本 PR 打 `diff-limit-exempt`，理由同 issue 的 atomic 声明：一组接口，一条验证路径。
- 不重复覆盖：存储写入失败（`write` 触发器）与损坏数据只在单元测试；审计失败回滚只在集成测试（真实 TCP）。

Evidence (13.1 检索参数，#446):

**现状**：

- 迁移 6 已播种四键：`retrievalTopK` `8`、`retrievalSimilarityThreshold` `0.2`、`retrievalKeywordsWeight` `0.7`、`retrievalRerankId` `""`。
- `platform/src/db/settings.ts:60-64,88-91` 声明字段与默认值；`parseRagflowSetting` 校验取值域：`requireTopK` 1..100，比例为 0..1 的有限数，重排为字符串。
- `platform/src/admin/config-route.ts:14,22` 的联合已含 `ragflow`；`descriptor.validate` 在写后、审计前执行，抛出转为 400（`validationGuidance` 追加在消息后）。
- `routes.ts:221` 注册 `ragflowConfigRoutes`。
- `audit/record.ts:50` 有 `ragflow-config.updated`，没有 `retrieval-config.updated`。
- `platform/src/admin/runtime-config.ts` 是同构先例：四个以上必填字段、只做信封检查的 `patch`、`DOMAINS` 文案、`validate`。

**改动点**：

- 新文件：`platform/src/admin/retrieval-config.ts`、`platform/src/admin/retrieval-config.test.ts`、`platform/test/admin-retrieval-config.integration.test.ts`。
- 修改：
  - `platform/src/admin/config-route.ts`：联合；
  - `platform/src/admin/routes.ts`：注册；
  - `platform/src/audit/record.ts` 与 `record.test.ts`；
  - `schemas/openapi.json`。
- AGENTS.md 由 orchestrator 改。

(1) `retrievalConfigRoutes` 经 `registerConfigRoute` 注册：

- `name: 'retrieval'`，`path: '/_platform/api/admin/retrieval-config'`，`auditType: 'retrieval-config.updated'`。
- `bodySchema` 与 `responseSchema` 都是四键对象，只记录契约：
  - `additionalProperties: false`，四键 `required`；
  - `retrievalTopK`：`integer`，1..100；
  - 两个比例：`number`，0..1；
  - `retrievalRerankId`：`string`。
- `DOMAINS` 固定文字：「Allowed domains: retrievalTopK: integer 1..100 (returned chunk count); retrievalSimilarityThreshold, retrievalKeywordsWeight: finite numbers 0..1; retrievalRerankId: rerank model ID without surrounding whitespace, or empty for no reranking」。
- `invalidMessage` 为 `Invalid retrieval configuration; provide exactly <四键>. <DOMAINS>`；`validationGuidance: DOMAINS`。
- `patch(body)`：非普通对象（复用 `isPlainObject`）、有多余键、或缺任一键 → `null`；否则返回 `body` 原样，值域交给 `writeSettings`。
- `validate(settings)`：`retrievalRerankId` 非空且 `trim()` 不等于自身时，抛 `new Error('retrievalRerankId must be empty or a rerank model ID without surrounding whitespace')`。
- `project(settings)` 返回四键。

**测试**：

单元测试 `retrieval-config.test.ts` 经 `withApp`：

- GET 初始值恰为 `{ retrievalTopK: 8, retrievalSimilarityThreshold: 0.2, retrievalKeywordsWeight: 0.7, retrievalRerankId: '' }`。
- PUT 成功（`3`/`0.5`/`0.3`/`'bge-reranker-v2-m3'`）：
  - 存储四行恰为新值，其余播种行不变（`seededWith`）；
  - 审计一行 `retrieval-config.updated`，带 actor/source，`target_email` 为空，细节 `{}`；
  - 响应为新值加 `runningInstances`；
  - 随后 GET 一致。
- 再 PUT 一次，`retrievalRerankId: ''` 证明能关闭重排。
- 边界接受：
  - `retrievalTopK` 取 1 和 100；
  - 两个比例取 0 和 1；
  - 带内部空格和 `/`、`@` 的重排 ID（`'BAAI/bge-reranker-v2-m3@Builtin'` 与 `'my reranker@Builtin'`）。
- 400 清单。每例之后 settings 与审计不变，响应和日志不含输入 SENTINEL，标签写明各自隔离的规则：
  - `null`、数组或字符串 body（信封）；
  - 缺任一键（键集合）；
  - 有多余键（键集合）；
  - `retrievalTopK` 为 0、101、1.5、`'8'`（settings 取值域，消息含字段名与 `DOMAINS`）；
  - 相似度阈值为 -0.1、1.1、`'0.2'`；
  - 关键词权重为 -0.1、1.1、`null`；
  - `retrievalRerankId` 为数字（settings 层）；
  - `retrievalTopK: SENTINEL`（类型错误，SENTINEL 不进响应和日志）；
  - 重排 ID 为 `' '`、`` ` ${SENTINEL}` ``、`` `${SENTINEL} ` ``（`validate` 规则：写入已发生但整体回滚，消息为固定文字加 `DOMAINS`，SENTINEL 不进响应和日志）；
  - 数值越界各例不带 SENTINEL，只断言 settings 与审计不变和消息内容。
- 存储写入失败（`BEFORE INSERT ON settings` 触发器）：返回 500 固定体，settings 等于触发器建立前快照，审计不变，随后 GET 返回 200。
- 改坏数据 `corrupt-json`、`corrupt-type`（把 `retrievalTopK` 存成 `"8"`）：GET 与 PUT 均返回 500。

`record.test.ts`：封闭集合含新事件。

集成测试 `admin-retrieval-config.integration.test.ts`，真实 TCP 的 `withListeningApp`：

- 匿名返回 401，员工返回 403（GET/PUT 都不动 settings，返回固定错误体）。
- 管理员 GET 默认值，PUT 新值返回 200，再 GET。
- 用 `delayedConfigBody` 在 body 被接收之后撤销会话或降级：返回 401/403 固定错误体，不写入，不审计。
- 审计失败回滚：先保存 A，建 `BEFORE INSERT ON audit_events` 触发器，PUT B 返回 500 固定体；settings 仍是 A，审计行数不变，响应和日志不含触发器名与 `SQLITE`。
- 一次值域 400 之后快照不变。
- 审计行 actor 为该管理员。

**命令**：

- `pnpm test`（逐文件 80%）
- `pnpm test:integration`
- `pnpm contract:check`
- `pnpm check`
- VPS exact-head 的 `pnpm test:docker` 和 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论（本 issue 涉及 RAGFlow；用例不覆盖本接口，只证明入口未回归）

**交接**：

- 页面与审计中文名：13.3（#412）。
- 代理在检索时应用参数（14.4）：映射见 design 决定 3；重排 ID 为空时不发 `rerank_id`；实例请求中带 `top_k`、`page_size`、`similarity_threshold`、`keywords_similarity_weight`、`vector_similarity_weight`、`rerank_id` 等检索参数字段时，按 design 表拒绝为 `invalid-request`。

Risk packs (13.2 测试连接，#411): fixture level expanded（与 issue 建议一致：本接口第一次用已存的 RAGFlow 密钥向外发请求）。selected：

- **Schema**：
  - `POST /_platform/api/admin/ragflow-config/test` 沿用 `model-config/test` 的空 body 约定（`empty-body.ts` 的 `emptyBodyPolicy`，body 只能是 `{}`；400/413/415 固定体）。
  - 200 回应：`{ result: 'ok', version }`，或失败时只有 `{ result }`。`result` 取 `ok`、`not-configured`、`unavailable`、`timeout`、`upstream-error`；`version` 必须匹配 `^[\x20-\x7e]{1,64}$`。schema 写 `additionalProperties: false`、`required: ['result']`。
  - 不返回 HTTP 状态和耗时：design 决定 3 只规定结果和版本；模型测试回 `httpStatus` 是那条接口自己的约定，这里不照搬。
- **Auth / permissions / secrets**（密钥）：
  - 密钥只放进 `Authorization: Bearer <key>` 请求头。回应、日志、审计和错误里都不出现密钥、地址和上游回应体。
  - 日志只有固定文字加 `result`（同 `model-connection.ts:76`）。
  - 已存密钥让 `new Headers()` 抛错时（例如含换行），按 `not-configured` 处理，不发请求，错误文字（会引用密钥）不外传，同 `model-probe.ts:101-104` 的做法。
- **Resource limits / large input**（对外请求）：一次测试最多两个请求，顺序固定：
  1. `GET <base>/api/v1/system/version`，不带密钥。RAGFlow v1.0.0-rc2 的该接口在 `apiNoAuth` 组，本机实测返回 `{"code":0,"data":"v1.0.0-rc2","message":"success"}`。
  2. 只有第 1 步 `code: 0` 且版本合法时，才发 `GET <base>/api/v1/datasets?page=1&page_size=1`，带密钥。只看 `code`，不读 `data`。实测无效密钥返回 HTTP 401 加 `{"code":401,…,"message":"Invalid access token"}`。
  - 每个请求 `redirect: 'manual'`、固定超时 `RAGFLOW_TIMEOUT_MS = 10_000`（覆盖到回应体读完）、回应体上限 64 KiB、不重试、不缓存。两步最坏 20 s，与模型测试的 20 s 同级。
  - 管理员断开连接或应用关闭时，中止进行中的请求。中止不是测试结果：同模型测试，抛出后路由回 500 固定体。
- **Error handling / rollback / partial outputs**：结果映射（第一个失败即停）：
  - 地址或密钥为空串 → `not-configured`，不发任何请求。
  - 请求头无法构造 → `not-configured`。
  - HTTP 401/403，或回应体 `code` 为 401 → `not-configured`。
  - 自身超时 → `timeout`。
  - 其他传输失败（拒绝连接、DNS、重置）→ `unavailable`。
  - 以下都是 `upstream-error`：3xx（含重定向）；其他非 2xx（含 404）；回应体超过 64 KiB；不是 JSON；`code` 不是数字；`code` 非零（401 除外）；第 1 步版本缺失、不是字符串、为空、超过 64 个字符或含不可打印字符。
  - 404 不算 `not-configured`：design 决定 3 结果表与 ragflow-proxy spec 已同步澄清（用户 2026-11-03 拍板），`not-configured` 只含未配置和密钥被拒。地址在保存时已由 `isRagflowBaseUrl` 校验，运行时能到达却回 404 的地址属于上游返回异常；14.x 继承同一映射（库或文档不存在同样不应显示为「知识库未配置」）。
  - `code: 401` 是 v1.0.0-rc2 实测的认证失败码。其他认证失败码（例如旧 Python API 的 `109`）没有在 rc2 上观察到，不猜，按 `upstream-error`。
- **Public API / 模块**：
  - 新模块 `platform/src/ragflow-proxy/`，含 `client.ts`、`client.test.ts` 和只做转出的 `index.ts`。`client.ts` 是唯一的 RAGFlow HTTP 实现：拼 URL、带密钥、超时、`redirect: 'manual'`、体积上限，以及按 HTTP 状态和 `code` 映射失败。
  - 超出 issue 字面的 PR Boundary（`platform/src/admin/`）。理由：第 14 组的代理需要完全相同的拼接、超时、体积上限和 `code` 映射；放在 `admin/` 里，14.1 要么复制（违反 Code Canonicality），要么从 `admin/` 搬走。直接放在设计规定的代理模块（`docs/IMPLEMENTATION_PLAN.md` §3 的 `ragflow-proxy`）只建一次。模块只导出本 issue 用到的东西；14.x 再按需扩展，`knip` 会挡住未用导出。
  - 拼接：去掉 `baseURL` 末尾所有 `/`，再接 `/api/v1/...` 路径，用 `new URL()` 解析，实际连接目标以解析结果为准（#410 交接）。保存的地址已由 `isRagflowBaseUrl` 保证没有 `?#@\` 和空白，拼出的路径不会落进查询或片段。
  - `admin/ragflow-connection.ts` 只做路由：空 body、读完 body 后复核权限、组合中止信号、调用 `index.ts` 导出的测试函数、记日志。它在 `routes.ts` 中紧接 `ragflowConfigRoutes` 注册，传入 `{ database, shutdown }`。
- **Auth / permissions / secrets**（权限）：沿用 `model-connection.ts:12-18` 的 `authorityRejection`：入口由 `adminRoutes` 拦截；body 读完后再按当前会话复核，401/403 时不发请求。复核函数与模型测试是同一份逻辑：移到 `admin/empty-body.ts`（两条测试路由共用的空 body 约定和 `ADMIN_ERRORS` 已在此文件），导出名 `authorityRejection`，`model-connection.ts` 改为引用它；测试补进 `empty-body.test.ts`（匿名、过期、员工、管理员四种）。`instance-actions.ts` 与 `config-route.ts` 的复核与各自事务/准入绑定，不动。
- **Code Canonicality**（与 `model-probe.ts` 的重叠）：
  - 64 KiB 截断读取 `readLimited`（`model-probe.ts:47-65`）移到新的顶层文件 `platform/src/bounded-body.ts`（导出 `readLimited(response, limit)`，配 `bounded-body.test.ts`），`model-probe.ts` 与 `ragflow-proxy/client.ts` 都引用它。放顶层而不放 `admin/` 或 `ragflow-proxy/`：放 `admin/` 会形成 `ragflow-proxy → admin/index.ts → routes.ts → ragflow-connection.ts → ragflow-proxy` 循环；让模型测试引用 RAGFlow 模块则方向错误。顶层 `platform/src/unicode.ts` 被 `auth/`、`db/` 引用是先例。
  - 截止组合（`AbortController` + `setTimeout` + `AbortSignal.any`）和 `new Headers` 抛错兜底各 3–5 行，是平台 API 的惯用写法，不抽取：抽成函数要多传回调或返回多值，比原写法更长。jscpd 阈值不变。
- **Legacy compatibility**：
  - 不改设置、迁移、审计事件和其他路由。
  - 模型测试的请求、回应和日志不变。
  - `schemas/openapi.json` 用 `pnpm contract:write` 重生成。
- **Documentation**（由 orchestrator 改）：
  - AGENTS.md Environment 段 `ragflow-config` 条目末句「No route reads RAGFlow yet: the connection test, the administrator page and the proxy belong to later tasks.」改为只剩页面和代理。
  - 另起一条记录测试连接的两步请求、结果映射、限制和不写审计。

not selected：

- Config / project setup：超时是代码常量 `RAGFLOW_TIMEOUT_MS`，不新增环境变量；`.env.example` 不变。
- Concurrency / shared state / ordering：管理员同时点击两次就是两次独立的只读请求，不加锁。
- File IO / path safety、Release / packaging：没有落盘，不改镜像和依赖。
- Documentation / migration notes 中的迁移部分：不新增设置。

**不变量**：

- 本接口不写 settings 和审计。测试前后两张表的快照相同。
- 不带密钥的请求只有版本接口；带密钥的请求只有那一次库列表查询，方法都是 GET。
- 回应只有封闭集合的 `result`，`ok` 时加一个合法版本串。上游的任何其他字节都不会进入回应和日志。

**Must preserve**：

- `model-config/test` 的行为、日志与 schema 不变（`authorityRejection` 抽取后的调用点行为相同）。
- 既有七条配置路由不变。
- 应用关闭顺序不变：`shutdown` 信号在排空在途回应之前中止。

**同级面**：

- 14.1–14.4 代理复用 `ragflow-proxy/client.ts`，到时扩展结果集合（`no-results`、`invalid-request`）与路径。
- 13.3（#412）的页面按 `result` 显示中文说明和版本。
- `platform/test/model-upstream-fixture.ts` 的 `startModelUpstream(handler)` 与 `refusedOrigin()` 是现成的自有 loopback HTTP 假服务。集成测试用自定义 handler 复用它，不另起第二个假服务。

**宽度**：client、路由、两份单元测试和集成测试，加上本段 fixture 与 AGENTS.md，预计超过 400 行；本 PR 打 `diff-limit-exempt`，理由同 issue 的 atomic 声明：一条接口，一条验证路径。

Evidence (13.2 测试连接，#411):

**现状**：

- `platform/src/admin/model-probe.ts`：`readLimited` 64 KiB、`redirect: 'manual'`、`AbortSignal.any` 截止加外部中止、请求头抛错映射为固定结果。
- `model-connection.ts`：空 body、`authorityRejection`、`reply.raw` 的 `close` 中止、失败日志只带 `result`。
- `routes.ts:208` 注册模型测试，`shutdown` 已传入。
- `settings.ts` 已有 `ragflowBaseUrl`、`ragflowApiKey`（#410）。
- `platform/src/ragflow-proxy/` 尚不存在。

**改动点**：

- 新文件：
  - `platform/src/ragflow-proxy/client.ts` 与 `client.test.ts`、`index.ts`；
  - `platform/src/admin/ragflow-connection.ts` 与 `ragflow-connection.test.ts`；
  - `platform/test/admin-ragflow-connection.integration.test.ts`。
- 新文件（共用）：`platform/src/bounded-body.ts` 与 `bounded-body.test.ts`。
- 修改：
  - `platform/src/admin/routes.ts`：注册；
  - `empty-body.ts` 与 `empty-body.test.ts`：接收 `authorityRejection`；
  - `model-connection.ts`：改用 `empty-body.ts` 的 `authorityRejection`；
  - `model-probe.ts`：改用 `bounded-body.ts` 的 `readLimited`，行为不变（`model-probe.test.ts` 与模型测试集成用例原样通过）；
  - `schemas/openapi.json`。
- AGENTS.md 由 orchestrator 改。

**测试**：

单元测试 `client.test.ts`（注入 `send`，不连网）：

- URL 拼接覆盖 `https://kb`、`https://kb/`、`https://kb//`、`https://kb/sub/`：实际请求 URL 分别是 `https://kb/api/v1/system/version`、同上、同上、`https://kb/sub/api/v1/system/version`。第二步路径带 `?page=1&page_size=1`。
- 第一步不带 `Authorization`；第二步恰好带 `Bearer <key>`；两步都是 GET 且 `redirect: 'manual'`。
- 映射表逐项一例：
  - 地址或密钥为空时不调用 `send`；
  - 请求头构造失败（密钥含 `\n`）时不调用 `send`；
  - HTTP 401、403、200 加 `code: 401` → `not-configured`；
  - 302、404、500 → `upstream-error`；
  - 非 JSON、`code: "0"`、`code: 102`、体积 64 KiB+1 → `upstream-error`，且确认未读完；
  - 版本缺失、为数字、为空串、65 个字符、含 `\u0007` 与非 ASCII → `upstream-error`，且不发第二步；
  - 版本恰为 64 个可打印字符 → 接受；
  - 第二步失败时结果里没有版本；
  - 截止触发 → `timeout`；
  - `send` 抛 `TypeError` → `unavailable`；
  - 外部中止 → 抛出，不返回结果。

单元测试 `ragflow-connection.test.ts` 经 `withApp`，用 `writeSettings` 存入地址与密钥：

- 未配置 → `{ result: 'not-configured' }`。
- 匿名 401、员工 403。
- 非 `{}` body 返回 400/415。
- 日志里没有密钥 SENTINEL。

集成测试 `admin-ragflow-connection.integration.test.ts`：真实 TCP，经 `startModelUpstream` 用自定义 handler 模拟 rc2 的两条路径，密钥正确时库列表回 `{"code":0,"data":[],…}`，错误时回 HTTP 401 加 `code: 401`。

- 成功：回应恰为 `{ result: 'ok', version: 'v1.0.0-rc2' }`；假服务收到恰好两个请求，顺序与 `Authorization` 有无符合上文。
- 以下各例都断言回应形状和结果：
  - 版本缺失、版本非字符串、版本超长 → `upstream-error`，且假服务只收到一个请求；
  - HTTP 200 加 `code: 102` → `upstream-error`；
  - 密钥被拒 → `not-configured`；
  - 超时：handler 不回应。测试函数与 `probeModel` 同形，接收 `deadlineMs` 参数（路由固定传 `RAGFLOW_TIMEOUT_MS`）；集成测试经 `ragflow-proxy/index.ts` 直接调用它，传 200 ms → `timeout`。这与 `admin-model-connection.integration.test.ts` 直接调用 `probeModel` 是同一做法；
  - 拒绝连接：用 `refusedOrigin()` → `unavailable`；
  - 重定向：302 指向另一个自有假服务 → `upstream-error`，且该服务收到 0 个请求。
- 每例断言：审计行数和 settings 快照不变；回应文本不含地址（假服务 origin）、密钥和 handler 写入的上游 MARKER；日志不含密钥和 MARKER。
- 管理员在 body 被接收后被撤销或降级（`delayedConfigBody`）→ 401/403，假服务收到 0 个请求。
- 客户端在请求挂起时断开 → 假服务的该连接被关闭（`socketClosed`）。
- 回应体卡住：第 2 步库列表先回 200 头，写出半个 JSON（`{"code":0,`）后停住；测试函数传 200 ms 截止 → `timeout`，结果没有 `version`（参照 `admin-model-connection.integration.test.ts:279-283`）。
- 应用关闭时测试在途（参照 `admin-model-connection.integration.test.ts:378-399`）：第 1 步 handler 收到请求后不回应，此时关闭应用 → 管理员收到 500 固定体，假服务的该连接被关闭，回应和日志不含密钥和假服务 origin。

`bounded-body.test.ts`：恰好上限的体返回全文；上限 +1 返回 `null` 且流被取消；`body` 为 `null` 返回空串。

**命令**：

- `pnpm test`（逐文件 80%）
- `pnpm test:integration`
- `pnpm contract:check`
- `pnpm check`
- VPS exact-head 的 `pnpm test:docker` 和 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论（本 issue 涉及 RAGFlow；用例不覆盖本接口，只证明入口未回归）

**交接**：

- 13.3（#412）：页面为五个 `result` 各写一条中文说明，`ok` 时显示 `version`。
- 14.1：在 `ragflow-proxy/client.ts` 上扩展，不新建第二个 RAGFlow HTTP 实现；结果集合加入 `no-results`、`invalid-request`。

Risk packs (13.3 后台「知识库」页，#412): fixture level expanded（与 issue 建议一致：本页是 RAGFlow 密钥和检索参数的后台写入口）。只做页面：三个接口已由 #410、#446、#411 交付，本任务不改任何接口、设置或迁移，`schemas/openapi.json` 不变。selected：

- **Public API（页面地址）**：
  - 新页面 `/_platform/admin/knowledge-base`，导航名「知识库」，链接排在「插件目录」之后、「账号设置」之前。
  - `platform/src/web/routes.ts` 的静态页面清单加这一项，与既有页面一样只答 GET/HEAD、`sendFile('index.html')`；尾斜线、子路径、`%00`、`%2f` 仍是 404。
  - `account-page.tsx` 的路径分派加一支；`AdminNavigation` 的 `page` 联合加 `'knowledge-base'`。
- **Auth / permissions / secrets**：
  - 进入页面时并发 GET `/_platform/api/admin/ragflow-config` 与 `/_platform/api/admin/retrieval-config`，作为当前权限探测。两个请求都结算、响应体都读完之后才按优先级决定（同 #408）：任一 401 → `window.location.assign('/_platform/login')`，只导航一次；任一 403 → 只显示 `无权限`（`role="alert"`），不渲染地址、密钥状态、参数或任何按钮；其他任一失败 → 整页失败态；两个都 200 → 就绪。不得在兄弟请求仍在途时导航（AGENTS.md 开发笔记 9）。
  - 保存和测试连接的 401/403 与 `model-page.tsx` 相同：401 → 导航登录；403 → 页面只剩 `无权限`，表单全部移除，草稿和已输入的密钥都清空。
  - 密钥：输入框 `type="password"`、`autoComplete="new-password"`，旁边只显示 `已配置`/`未配置`（来自 `apiKeyConfigured`；规格写「只显示已配置」，本页用这对文案，不沿用模型页的 `已设置`），提示 `留空保留原密钥。`。PUT 时密钥框为空串就不带 `apiKey`；非空但只含空白时在页面上拒绝（`密钥不能只包含空白字符。`），不发请求。任何一次加载、保存（成功或失败）之后都清空密钥框；测试连接不清空，也不发送它。页面任何地方都不显示密钥原文，`localStorage`、`sessionStorage`、URL 里都没有它。
  - 页面只调用这三个接口（两个 GET/PUT 加 `POST …/ragflow-config/test`），不调其他 `/_platform/api/`。
- **Concurrency / shared state**：
  - 两个保存区和测试连接共用一个页面级 pending 锁（同 `model-page.tsx` 的 `owner` ref 与 `current()` 失效判定）。加载、任一保存或测试进行中，两个表单的 `fieldset` 都 `disabled`，「测试连接」也不可点，杜绝重复与交叉提交。
  - 离开页面时中止在途请求。每个响应体在结算前读完（含 400/500）；过期响应不覆盖当前状态。
  - 保存成功只用该保存区自己的响应更新该区草稿，另一区草稿不动。
- **Error handling**（页面只显示下列固定中文，从不显示服务端 message 或响应体原文）：
  - 加载中：状态行只显示 `加载中…`，不渲染任何表单。
  - 加载失败（非 401/403）：`知识库配置加载失败，请重试。` 加「重试」按钮（重新发两个 GET），不显示任何部分数据。
  - 连接配置保存 400：`RAGFlow 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \，最长 2048 个字符。`。
  - 检索参数保存 400：`检索参数无效：返回片段数为 1–100 的整数，相似度阈值和关键词权重为 0–1 之间的数，重排模型 ID 前后不能有空白。`。
  - 其他保存失败：`保存失败，请重试。`；测试请求失败（非 200 或回应不合法）：`连接测试请求失败，请重试。`。
  - 页面侧只做两项必要检查，其余交给服务端 400（检索参数表单 `noValidate`，所以 0、101、1.5 等越界值也会真实发出并得到 400）：地址为空 → `请输入 RAGFlow 地址。`；四个检索参数里数字框为空或不是有限数字 → 检索参数 400 那一行。重排模型 ID 的前后空白不在页面检查，原样发送，由服务端 400 拒绝（这样浏览器用例能走到真实的 400）。
- **Config（页面结构）**：
  - 页面顶部（两个表单之上）一行固定提示：`保存即生效：平台之后的每次知识库请求都使用新配置，不需要重启实例。`。
  - ① 「连接配置」表单（`aria-label="RAGFlow 连接"`，按钮「保存连接配置」）：`RAGFlow 地址` 输入框（说明 `RAGFlow 服务的根地址，例如 http://ragflow.intranet:9380；平台会在其后拼接 /api/v1/…`）与密钥框（见上）。PUT body 恰为 `{ baseURL }` 或 `{ baseURL, apiKey }`，`baseURL` 原样发送，不去空白、不改写。成功后状态行 `已保存，立即生效。`。
  - ② 「检索参数」表单（`aria-label="检索参数"`，按钮「保存检索参数」；`<form noValidate>`，越界值不由浏览器原生约束拦截，而是发出 PUT、由服务端 400 判定，页面显示参数那一行）：`返回片段数`（`type="number"`，`min=1`、`max=100`、`step=1`）、`相似度阈值`、`关键词权重`（都是 `type="number"`，`min=0`、`max=1`、`step="any"`，同 `runtime-page.tsx:254`）、`重排模型 ID`（文本框，说明 `留空即不启用重排序`）。PUT body 恰为 `{ retrievalTopK, retrievalSimilarityThreshold, retrievalKeywordsWeight, retrievalRerankId }`，三个数字取 `Number(<输入>)`，重排模型 ID 原样。成功后状态行 `已保存，立即生效。`。
  - ③ 「测试连接」按钮放在连接配置表单下方，旁边固定说明 `测试使用上次保存的配置，未保存的修改不参与`。它发 `POST …/ragflow-config/test`，body 为 `{}`。回应必须恰为 `{ result }`，或 `ok` 时恰为 `{ result: 'ok', version }`（`version` 匹配 `^[\x20-\x7e]{1,64}$`）；其他形状按请求失败处理。五个取值各一条不同的中文：
    - `ok` → `连接成功，RAGFlow 版本：<version>`（`role="status"`；`version` 作为文本节点渲染，不当 HTML）；
    - `not-configured` → `未配置 RAGFlow 地址或密钥，或密钥被拒绝`；
    - `unavailable` → `无法连接到 RAGFlow 地址`；
    - `timeout` → `连接 RAGFlow 超时`；
    - `upstream-error` → `RAGFlow 返回了异常结果`。
    - 失败四项用 `role="alert"`。
    - 请求进行中状态行为 `正在测试连接…`；保存进行中为 `正在保存…`（同 `model-page.tsx:36-40`）。
  - 两个 PUT 回应都带 `runningInstances`。页面校验它是非负安全整数，但不显示：本页设置保存即生效，与运行中的实例数无关。
- **Documentation**（编排者同 PR 更新）：
  - AGENTS.md：「Static delivery declares …」一句加入 `/_platform/admin/knowledge-base`；RAGFlow 连接配置条目里「the administrator page belongs to a later task」改为指向该页面。
  - `platform/web/src/audit-page.tsx` 的 `EVENT_NAMES` 补上 13.1 推迟到本任务的两个事件中文名：`ragflow-config.updated` → `修改知识库连接`，`retrieval-config.updated` → `修改检索参数`。这两个事件没有 details，审计页按既有规则只显示中文名。

not selected：

- Schema、Legacy compatibility：没有接口、数据库或迁移变化；既有页面行为不变，`admin-navigation.test.tsx` 只扩表。
- File IO、Resource limits、Release：没有新依赖。
- 「保存即生效」的运行时效果（员工刷新知识库列表看到新服务、下一次检索用新参数）由 #410/#446/#417 的接口与代理测试承担；本页只写提示，不另行证明。
- 接口层的拒绝与事务语义由 #410/#446 已合入的接口测试承担：服务端拒绝只含空白的密钥、「提交期间被降权」、「审计失败回滚」。本页只覆盖页面对 400/401/403 的呈现。

Governing invariant：

- 页面上任何一次 PUT 或测试 POST 发出时，没有其他请求在途；PUT 的 body 只来自该保存区当前的草稿。
- 任何 401/403 之后，页面不再显示任何配置数据。
- 密钥原文从不出现在页面、存储或 URL 中。

Sibling surfaces：

- `model-page.tsx`：密钥框与状态、测试连接、单页 pending 锁。
- `plugins-page.tsx`：多保存区、并发 GET 后再决定权限。
- `admin-models-connection.ui.test.ts`：本机回环上游、挂住的测试请求、固定文案。
- `admin-plugins.ui.test.ts`：两个以上 GET 的拒绝与失败用例。
- `admin-ui-fixture.ts`：`withAdminUi`、`holdAdminList`、`failAdminList`、`expectPlatformLogin`。
- `model-upstream-fixture.ts`：`startModelUpstream` 的 `setHandler` 与 `requests`。

无关键路径文件。

Evidence (13.3 后台「知识库」页，#412):

**现状**：

- 后台页面是单个 `index.html` 加客户端路径分派（`platform/web/src/account-page.tsx`）。`platform/src/web/routes.ts:58-67` 的静态清单到 `/_platform/admin/plugins` 为止；`AdminNavigation` 的 `page` 联合是 `accounts|instances|audit|models|runtime|plugins`。
- 三个接口：
  - `platform/src/admin/ragflow-config.ts`：GET 恰为 `{ baseURL, apiKeyConfigured }`，PUT 再加 `runningInstances`。
  - `platform/src/admin/retrieval-config.ts`：四个字段，PUT 再加 `runningInstances`。
  - `platform/src/admin/ragflow-connection.ts`：回应 `{ result: 'ok', version }` 或 `{ result }`；RAGFlow 请求的固定超时是 `RAGFLOW_TIMEOUT_MS = 10_000`（`platform/src/ragflow-proxy/client.ts:4`）。
- 设置初始值（迁移 6）：地址与密钥为空，`retrievalTopK` 8、`retrievalSimilarityThreshold` 0.2、`retrievalKeywordsWeight` 0.7、`retrievalRerankId` 空。
- `audit-page.tsx:4-27` 的 `EVENT_NAMES` 没有两个 RAGFlow 事件。

**改动点**：

- 实现者新建：
  - `platform/web/src/knowledge-base-page.tsx`，与同目录 `knowledge-base-page.test.tsx`（jsdom，沿用 `platform/web/test/account-dom-fixture.tsx`）；
  - `platform/test/admin-knowledge-base.ui.test.ts`。
- 实现者修改：
  - `account-page.tsx`（分派一支）；
  - `admin-navigation.tsx` 与其测试；
  - `audit-page.tsx` 与其测试（两个事件名）；
  - `platform/src/web/routes.ts` 与 `routes.test.ts`（新路径进 GET、HEAD、拒绝三张表）；
  - 样式只在 `platform/web/src/style.css` 复用既有类。
- 编排者修改：AGENTS.md。
- 若新页面与 `model-page.tsx` 的请求骨架构成 jscpd 克隆，允许在 `platform/web/src/` 新建一个小的共享模块（带同目录测试），并让构成克隆的那个既有页面改用它：行为不变，该页既有测试一字不改且仍通过。`pnpm duplicate-code` 仍须低于 3%，阈值不动。
- RAGFlow 测试回应的解析与五条中文放在页面模块里的一个纯函数中（同 `model-config.ts` 的 `connectionMessage`）。不要改 `model-config.ts`，除非为了上面的共享模块。

**测试**：

- (a) `knowledge-base-page.test.tsx` 用桩 `fetch` 覆盖：
  - 加载：`加载中…` 且无表单；两 GET 成功渲染（地址、`已配置`/`未配置`、四个参数、页顶提示逐字）；任一 GET 401 → 两个都结算后才 `assign('/_platform/login')`，且只调用一次；403 → 只有 `无权限` 且无表单；403+401 → 只导航登录；200+500 → 失败态且无任何部分数据；「重试」重新发两个 GET。
  - 连接配置：PUT body 逐字——密钥框空则无 `apiKey`；有密钥则带上；`baseURL` 带前后空格时原样发送。只含空白的密钥和空地址不发请求，显示固定文案。400 → 地址那一行；500 → `保存失败，请重试。`。成功后密钥框清空、状态 `已配置`、提示 `已保存，立即生效。`。
  - 检索参数：PUT body 逐字（数字是 number，重排 ID 原样）；空数字框或非有限数字不发请求并显示参数那一行；400 → 参数那一行；成功只更新本区，连接区草稿（含已输入未保存的地址）不变。
  - 测试连接：body `{}`；五个取值的五条文案两两不同；`ok` 显示版本；版本缺失、超长、含控制字符、多出字段，以及失败结果带版本，都按 `连接测试请求失败，请重试。` 处理；测试不清空密钥框，也不发送它。
  - 401/403 在保存和测试时的处理同上。
  - pending 期间所有按钮禁用，第二次点击不发请求；卸载时中止在途请求；过期响应不覆盖当前状态；`runningInstances` 不合法按保存失败处理。
  - 逐文件覆盖率 ≥ 80%。
- (b) `admin-knowledge-base.ui.test.ts`（真实应用、SQLite 与三个接口，`withAdminUi`；用 `startModelUpstream` 在本机回环起一个测试自有的假 RAGFlow，按路径回答 `/api/v1/system/version` 与 `/api/v1/datasets`）：
  1. 管理员打开页面：地址为空、`未配置`、四个参数为 8/0.2/0.7/空，页顶提示逐字可见。此时测试连接 → `未配置 RAGFlow 地址或密钥，或密钥被拒绝`，假服务收到 0 个请求。
  2. 填假服务地址与一把测试密钥后保存 → 响应 200；`readSettings(database)` 的地址等于输入、密钥等于输入；新增恰一条 `ragflow-config.updated` 审计；页面显示 `已配置`，密钥框为空；页面 HTML 与所有浏览器存储里都没有这把密钥。
  3. 测试连接（假服务版本回 `{code:0,data:"v1.0.0-rc2"}`，库列表回 `{code:0,data:[]}`；测试接口对库列表只看 HTTP 状态和 `code`，见 `platform/src/ragflow-proxy/client.ts:232-244`）→ 状态行恰为 `连接成功，RAGFlow 版本：v1.0.0-rc2`，截图 `admin-knowledge-base-connection-ok`。假服务收到的第二个请求带 `Authorization: Bearer <测试密钥>`，第一个不带。
  4. 挂住一个真实测试请求（假服务延迟回答版本接口）：状态 `正在测试连接…`，两个保存按钮与「测试连接」都禁用，双击只发一次；放行后恢复正常回答。
  5. 假服务库列表改回 HTTP 401 → `未配置 RAGFlow 地址或密钥，或密钥被拒绝`；版本接口改为 HTTP 200 加 `{code:500,message:"x"}` → `RAGFlow 返回了异常结果`（覆盖「HTTP 200 加非零业务代码不算成功」）；最后保存一个指向已关闭回环端口的地址（这一次保存恰好新增一条 `ragflow-config.updated`）→ 测试连接 → `无法连接到 RAGFlow 地址`。三条文案两两不同。每次点击「测试连接」前后各取一次审计表快照，两者相等（测试连接不写审计）。`timeout` 需要 10 秒固定超时，只在 (a) 覆盖。
  6. 检索参数：把返回片段数改为 3 保存 → `readSettings` 的 `retrievalTopK` 为 3，其余不变；恰一条 `retrieval-config.updated`。接着，返回片段数保持 3，重排模型 ID 填 `" rr "`（JSON 字符串，前后各一个空格）保存 → 断言发出的 PUT body 恰为 `retrievalTopK: 3` 且 `retrievalRerankId` 为 `" rr "`，得到真实 400（`retrieval-config.ts` 的 `validate` 拒绝），页面显示参数那一行，settings 与审计行数不变。然后把重排模型 ID 清空、返回片段数填 0 保存 → 断言 PUT body 的 `retrievalTopK` 为 0、`retrievalRerankId` 为空串，真实 PUT 得到 400（表单 `noValidate`；`writeSettings` 拒绝），页面显示参数那一行，settings 与审计行数不变（规格「参数校验…指出取值范围」的浏览器证据）。两次失败都不改动草稿，所以顺序不能颠倒。
  7. 地址填 `http://ragflow.invalid/?x` 保存 → 真实 400，显示地址那一行，settings 与审计不变。
  8. 重新打开页面（重载）后两区显示保存后的值；密钥状态为 `已配置`，密钥框为空，页面 HTML 与浏览器存储里都没有测试密钥（规格「密钥只显示已配置」）。
  9. 拒绝与失败：
     - 挂住一个真实 GET 时只见 `加载中…`，`form` 个数为 0（`openPendingAdminList` 断言的是表格个数，本页没有表格，须另断言表单）；
     - 一次受控的 GET 500（`failAdminList`）→ 失败文案，不回显诊断，「重试」随后对真实接口成功；
     - 员工账号打开 → 403，页面只有 `无权限`；
     - 登出后打开 → 回到登录页；
     - 页面就绪后删除管理员会话、或把账号降为员工，再点保存 → 分别回到登录页或只剩 `无权限`，settings 与整张审计表不变，留截图。
  10. 桌面与窄屏截图（`expectViewportLayout`，前缀 `glass-admin-knowledge-base`，无横向溢出）。`observeAccountUi` 只列三个接口；`expectHealthy` 只允许本用例明确制造的状态；零控制台错误、零外部请求（假服务在回环上，经平台服务端访问，浏览器不直连它）、`otherMutations` 为空、无浏览器存储。
  11. 审计页筛选下拉的选项文本含 `修改知识库连接` 与 `修改检索参数`：在本文件拆成独立用例，用 `observeAuditUi` 观察 `/_platform/api/admin/audit-events`，不放进第 10 步只列三个接口的观察。
- (c) `routes.test.ts`、`admin-navigation.test.tsx`、`audit-page.test.tsx` 扩表。

**验证**：

- `pnpm check`（含 lint、typecheck、单元/覆盖率、集成、build、contract、`duplicate-code`、`dead-code`）。
- `pnpm test:ui`：实现者跑一次全量，贴通过数；新文件单独再跑一次。PR 附截图说明。
- VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy` 证据：本任务不改 Docker 用例，预期与 #535 一致。
- 本机 exact-head `pnpm test:stack` 证据评论：本 issue 涉及 RAGFlow，但 stack 用例经接口配置 RAGFlow、不经本页，只证明入口未回归。

**PR 体量**：目标 ≤ 400 行。若只因测试文件超出，按 #408 的先例加 `diff-limit-exempt`，并在正文写明超出部分是测试。

**不做**：

- 任何接口、设置或迁移改动；
- 显示运行中实例数或重启实例；
- 员工侧知识库面板；
- 在页面上预检 RAGFlow 地址规则（服务端 `isRagflowBaseUrl` 是唯一实现）。

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

Risk packs (14.1 实例接口鉴权与版本路由，#413): fixture level expanded（与 issue 建议一致：新的对外数据通道入口与鉴权）。selected：

- **Public API / CLI / script entry**：
  - 新前缀 `/_platform/instance-api/ragflow/`，本 issue 只声明 `GET /_platform/instance-api/ragflow/version`。
  - 回应约定由本 issue 定下，14.2–14.4 沿用，记入 design 决定 3：
    - 鉴权失败一律 401，固定体 `{ statusCode, error, message }`：401/500 固定体是模块内共用的 `INSTANCE_ERRORS`（`instance-auth.ts`），schema 是模块内的 `ERROR_SCHEMA`（`routes.ts`），形状与仓库既有副本相同；
    - 未声明的路径或方法返回 404（Fastify 默认，或网关保留路径的平台 404），405 不另造；
    - 鉴权通过后，结果一律 HTTP 200，body 是封闭集合 `{ result, … }`，例如 `{ result: 'ok', version }` 或 `{ result: 'timeout' }`。
  - 理由：插件和工具只看 `result`，模型测试连接（`model-config/test`）与 #411 已是这一形状。415 与 404 是 HTTP 层的拒绝，不是结果取值。
- **Auth / permissions / secrets**：
  - 鉴权在根级 `onRequest` 钩子里先于路由执行，覆盖整个前缀（同 `installRequestGuard` 的安装方式）。因此前缀下的普通 HTTP 请求（不含 WebSocket 升级，见下），任何方法、任何路径，没有有效令牌都是 401；只有鉴权通过后才会出现 404。这满足「无令牌无 Origin 的 POST 被拒为 401」：本 issue 还没有 POST 路由，但该请求也必须得到 401，而不是 404。
  - 前缀判定用两个条件之一成立即鉴权：
    - ① 路由视角：`request.routeOptions.url` 以前缀开头（同 `installRequestGuard` 用 `routeOptions.url`）。find-my-way 在路由前会解码非保留字符的 `%XX`，所以 `/_platform/instance-api/ragflo%77/version`、`/_platfor%6d/instance-api/ragflow/version` 都会命中已声明的版本路由。只看原始路径就会绕过鉴权（fixture 评审指出的 P0）。
    - ② 原始路径视角：去掉查询串后的原始路径以前缀开头。它覆盖落到网关 `'/*'` 的未声明路径，使其在鉴权前得到 401。
  - 已声明路由一律设路由级 `exposeHeadRoute: false`（Fastify 5 的路由选项是单数；复数 `exposeHeadRoutes` 只是建应用时的选项，实现时实测确认）：Fastify 5 默认会为 GET 隐式生成 HEAD，这会在鉴权后向 RAGFlow 发请求，违反「只有四个接口」。HEAD 因此落到网关 `'/*'`，在保留路径下得到平台 404。
  - 令牌：`Authorization` 必须恰为 `Bearer <64 个小写十六进制字符>`（`start.ts:365` 的生成格式），否则直接 401，不查库。
  - 查库：对令牌求 SHA-256（hex），`SELECT instances.user_id, instances.upstream_host FROM instances JOIN users ON users.id = instances.user_id WHERE instances.instance_token_hash = ? AND instances.status = 'running' AND users.status = 'active'`。
    - 只读查询，参照 `admin/config-route.ts:161`、`admin/instance-actions.ts:227` 直接读 `instances` 的先例，不改编排器。
    - 停用账号在停用到实例退休之间的窗口内也被拒。
  - 来源核对：取 socket 对端地址（`request.socket.remoteAddress`），**不**经 `X-Forwarded-For` 和可信代理解析。实例总是直连自己网桥上的 +3 地址，转发头不可能合法地出现在这里。
    - 地址先按 `auth/source-address.ts` 的 `parseAddress` 规范化（`::ffff:a.b.c.d` → `a.b.c.d`）。该函数改为经 `auth/index.ts` 导出，不复制。
    - 规范化后必须等于该行的 `upstream_host`（网络方式下即员工容器端点 IPv4，按 `instanceAddressLayout` 为 +2）。比较 `upstream_host` 而不从子网推算 +2，是有意为之：阶段 1 遗留、端点不在 +2 的存活实例（AGENTS.md「Stage-1 instances created before the layout」）也能用它真实的地址通过，而推算会把它们误拒。
  - published-loopback 方式下整个前缀一律 401：该方式下行的 `upstream_host` 是 `127.0.0.1`，不是实例地址；design 决定 2 已说明该方式下代理不可用。实现上由鉴权钩子 `installInstanceAuth(app, database, upstreamMode)` 接收它，而不是路由插件，因为落到网关 `'/*'` 的未声明前缀路径也必须被拒；路由插件只接收 `{ database, shutdown }`。
  - 平台会话 cookie 不参与鉴权：只带 cookie → 401；带 cookie 加有效令牌 → 按令牌处理，cookie 忽略。
  - 所有拒绝原因共用一个 401 回应，日志只有固定文字，不含令牌、哈希、地址或用户。令牌只在 `Authorization` 头里，已在既有脱敏路径中（`app.ts` 的 authorization 头脱敏）。
  - 鉴权通过后把用户 ID 挂在请求上（`request.instanceUserId`，Fastify decorateRequest），供 14.2–14.4 使用；本 issue 的版本路由不使用它。
- **Resource limits / large input**：版本路由复用 #411 的 `client.ts`。
  - 从 `testRagflowConnection` 中抽出 `ragflowVersion(settings, signal, deadlineMs, send?)`，测试连接改为调用它再做库列表查询，不复制。
  - 每次请求读设置；地址或密钥为空 → `not-configured`，不发请求。密钥为空也算未配置：spec「RAGFlow 未配置时 … 不发出外部请求」。
  - 固定超时 `RAGFLOW_TIMEOUT_MS`、`redirect: 'manual'`、64 KiB、不重试。
  - 客户端断开或应用关闭时中止请求；应用关闭回 500 固定体，同 #411。
  - 结果集合常量 `RAGFLOW_TEST_RESULTS` 改名为 `RAGFLOW_RESULTS`，就地重命名，供两条路由共用；14.x 再加入 `no-results`、`invalid-request`。
- **Error handling / rollback / partial outputs**：
  - 鉴权查库抛错（存储故障）→ 500 固定体，日志只有固定文字。不能回成 401，否则会把故障伪装成令牌错误。
  - 钩子必须在内部 `try/catch`，自己 `reply.code(500).send(固定体)` 后返回，同 `installRequestGuard` 自行回应的写法。不能让异常落到 Fastify 默认错误处理器：那会在回应体里带出 `error.message`（例如 `no such table`）。
  - 版本路由的映射与 #411 相同，由 `client.test.ts` 覆盖；路由测试只验证接线。
- **Code Canonicality / 模块方向**：`ragflow-proxy` 不能引用 `admin`（#411 已记录的循环：`ragflow-proxy → admin/index.ts → routes.ts → ragflow-connection.ts → ragflow-proxy`）。
  - 中止接线（回应 `close` 中止控制器、与 `shutdown` 组合的 `AbortSignal.any`、`finally` 解除监听）从 `admin/empty-body.ts` 的 `runConnectionTest` 中拆出，放到新的顶层文件 `platform/src/request-abort.ts`（配 `request-abort.test.ts`），导出 `withRequestAbort(reply, shutdown, run)`。
    - `runConnectionTest` 保留管理员权限复核、非 ok 告警和固定 500，改为调用它。
    - 版本路由同样调用它。
    - 顶层放置的先例是 #411 的 `bounded-body.ts`。
  - 固定错误体与 `ERROR_SCHEMA`：现状已是按模块各自定义（`gateway/routes.ts:29`、`gateway/instance-routes.ts:6`、`admin/config-route.ts`）。`ragflow-proxy` 按同样做法在 `routes.ts` 定义自己的 401/500 固定体和 `ERROR_SCHEMA`，不跨模块引用。三处既有副本的收敛不在本 issue 范围，作为后续记录。
- **Legacy compatibility**：
  - `installRequestGuard` 只管 `/_platform/api/`，新前缀天然不在其中，不改它。
  - 网关保留路径逻辑（`gateway/routes.ts:43-46`）已覆盖 `/_platform/` 后代，不改网关代码，只加回归测试。
  - `admin/ragflow-connection.ts` 的请求、回应与日志不变。
  - `schemas/openapi.json` 用 `pnpm contract:write` 重生成。
- **Documentation / migration notes**（由 orchestrator 改）：
  - AGENTS.md Environment 段新增一条：前缀、Origin/JSON 守卫例外及理由、Bearer 加来源地址核对、published-loopback 一律 401、回应约定。
  - 测试连接条目里的 `ragflow-proxy` 描述同步。
  - design 决定 3 记录回应约定。

- **File IO / path safety**（URL 路径规范化）：上面的双条件判定与编码绕过用例。网关 `platformPath` 对编码路径的既有判定不在本 issue 范围，作为后续记录。

not selected：

- Config / project setup：不新增环境变量；`upstreamMode` 是已有配置。
- Schema / migration：不改表；`instance_token_hash` 已由迁移 4 建立。
- Concurrency / shared state / ordering：只读查询，单语句。
- Release / packaging：无。

**不变量**：

- 前缀下的任何请求（含编码变体与升级请求），在鉴权通过前都不会读 RAGFlow 设置，也不会发出外部请求。
- 鉴权通过当且仅当同时满足：令牌哈希匹配一条 `running` 行；所属账号 `active`；socket 对端规范化后等于该行的 `upstream_host`；运行在 `network` 方式。
- 401 回应不随原因变化（状态、头、体逐字节相同）。
- 令牌明文不落库、不进日志、不进回应。

**Must preserve**：

- 网关对 `/_platform/` 后代的保留与平台 404 不变；匿名 HTML GET 到其他路径仍重定向到登录页。唯一有意的例外：本前缀下未声明的路径，无令牌时先得到 401，鉴权通过后才是平台 404。AGENTS.md 的「unknown reserved paths stay platform404」同步写明这一例外。
- WebSocket 升级不经 Fastify 钩子，仍由网关 `admission` 按保留路径以 404 拒绝。
- `/_platform/api/` 的 Origin/JSON 守卫不变。
- #411 测试连接的行为、日志与契约不变。
- 编排器对 `instance_token_hash` 的写入与清除不变（本 issue 不改编排器，关键路径不涉及）。

**同级面**：

- 14.2–14.4 在同一前缀与鉴权钩子下添加路由；`request.instanceUserId` 是它们的身份来源。
- 15.1（#418/#447）的插件只拿平台地址和 `DSH_TEAM_INSTANCE_TOKEN`。
- `gateway/routes.ts` 的升级处理：前缀下的 WebSocket 升级不转发给 DSH，保持现状。
- `auth/source-address.ts` 的 `parseAddress` 由私有变为经 `auth/index.ts` 导出。

**宽度**：鉴权钩子、版本路由、client 抽取、单元与集成测试，加上本段 fixture 与 AGENTS.md，预计超过 400 行；本 PR 打 `diff-limit-exempt`，理由同 issue 的 atomic 声明。

Evidence (14.1 实例接口鉴权与版本路由，#413):

**现状**：

- `orchestrator/start.ts:365-366`：令牌为 32 字节随机数的 hex，库里存 SHA-256 hex；`start.ts:460-466` 写入，`stop.ts:215`、`readiness.ts:290`、`start.ts:214`、`creation-attempt.ts:349` 清除。
- `instances.upstream_host` 在网络方式下是员工容器端点 IPv4。
- `auth/request-guard.ts:42` 的守卫只作用于 `/_platform/api/`。
- `gateway/routes.ts:43-46` 把 `/_platform/` 后代视为保留路径；`'/*'` 通配路由回平台 404，不转发、不重定向。
- `platform/src/ragflow-proxy/client.ts`（#411）已有 `call`、`endpoint`、映射和 `testRagflowConnection`。

**改动点**：

- 新文件：
  - `platform/src/ragflow-proxy/instance-auth.ts` 与 `instance-auth.test.ts`：令牌解析、查库、来源核对、根级钩子安装函数；
  - `platform/src/ragflow-proxy/routes.ts` 与 `routes.test.ts`：版本路由；
  - `platform/test/ragflow-proxy-auth.integration.test.ts`。
- 修改：
  - `ragflow-proxy/client.ts` 与测试：抽出 `ragflowVersion`，`RAGFLOW_TEST_RESULTS` 改名为 `RAGFLOW_RESULTS`；
  - `ragflow-proxy/index.ts`；
  - `admin/ragflow-connection.ts`：跟随改名；
  - `admin/empty-body.ts` 与测试：`runConnectionTest` 改用 `withRequestAbort`，行为与日志不变；
  - 新文件 `platform/src/request-abort.ts` 与 `request-abort.test.ts`：客户端断开中止、应用关闭中止、正常完成后监听已解除；
  - `auth/source-address.ts` 与 `auth/index.ts`：导出 `parseAddress`；
  - `app.ts`：在路由插件之前安装鉴权钩子并注册路由，传入 `database`、`upstreamMode` 和 `shutdown`；
  - `schemas/openapi.json`。
- AGENTS.md、design.md 由 orchestrator 改。

**测试**：

单元测试 `instance-auth.test.ts`：

- `Authorization` 解析：
  - 接受恰好 64 个小写 hex；
  - 拒绝缺失、`Basic …`、`bearer`（小写）、63/65 个字符、大写 hex、首尾空白、多个空格。
  - 拒绝时不查库（用会抛错的数据库替身证明）。
- 地址规范化：`::ffff:172.30.0.2` 等于 `172.30.0.2`。
- `remoteAddress` 为 `undefined` 或无法解析时 → 401，不查库。

集成测试 `ragflow-proxy-auth.integration.test.ts`：真实 TCP 监听 `127.0.0.1`，配置 `upstreamMode: 'network'`，直接写入用户与实例行。

- 有效：`running` 行、账号 active、`upstream_host = '127.0.0.1'`、令牌哈希匹配。
  - 未配置 RAGFlow → 200 `{ result: 'not-configured' }`，假 RAGFlow 收到 0 个请求。
  - 配置指向自有假 RAGFlow（复用 `startModelUpstream`）→ 200 `{ result: 'ok', version: 'v1.0.0-rc2' }`；假服务恰好收到 1 个不带 `Authorization` 的 GET。
- 以下每一项都得到逐字节相同的 401（状态、`content-type`、体），且假 RAGFlow 收到 0 个请求：
  - 无令牌；
  - 格式错误的令牌；
  - 只带有效 `platform_session`；
  - 实例停止后的旧令牌（行 `status = 'stopped'`、哈希为 NULL）；
  - 重启轮换后的上一次令牌（行哈希已换）；
  - `status = 'starting'` 的行的令牌；
  - 账号 `disabled` 而行仍为 `running`；
  - 他人地址（行 `upstream_host = '127.0.0.2'`）；
  - 带 `X-Forwarded-For: 127.0.0.2`，行地址为 `127.0.0.2`，配置 `trustedProxies` 含 `127.0.0.1`：审计用的来源解析器此时会采信该头，但代理必须仍为 401（转发头不被采信）；
  - `upstreamMode: 'published-loopback'` 下的完全有效请求；
  - 无令牌无 Origin 的 `POST /_platform/instance-api/ragflow/retrieval`（路由尚不存在，仍为 401）；
- 鉴权通过后，未声明路径 `GET …/ragflow/datasets-x` 与未声明方法 `DELETE …/ragflow/version`、`POST …/ragflow/version`、`HEAD …/ragflow/version` → 404，假 RAGFlow 收到 0 个请求。
- 编码变体 `/_platform/instance-api/ragflo%77/version` 与 `/_platfor%6d/instance-api/ragflow/version`：
  - 无令牌 → 401，假 RAGFlow 收到 0 个请求；
  - 带有效令牌 → 200 `{ result }`（与未编码路径相同）。
- 网关：
  - 无令牌、`Accept: text/html` 的 `GET …/ragflow/version` → 401，不是 302 到登录页；
  - 注入的 `resolveUpstream` 在整个文件中从未被调用（计数为 0）；
  - 前缀下的 WebSocket 升级请求被网关以 404 拒绝，`resolveUpstream` 计数仍为 0，假 RAGFlow 收到 0 个请求。
- 存储故障：用 `DROP TABLE instances` 让读取失败（先例见 `platform/test/container-start.integration.test.ts:459` 的 `DROP TABLE settings`；若外键约束阻止删除，测试写明采用的绕行方式），→ 500 固定体，不是 401。回应和日志不含 `SQLITE`、表名或触发器名（同 #446 的断言）。
- 每例断言：回应和日志不含令牌明文、令牌哈希和假 RAGFlow origin。
- 应用关闭时版本请求在途 → 500 固定体，假服务连接被关闭。

`client.test.ts`：`ragflowVersion` 的未配置（地址空、密钥空）不发请求；成功；一个失败映射；测试连接用例保持通过。

**命令**：

- `pnpm test`（逐文件 80%）
- `pnpm test:integration`
- `pnpm contract:check`
- `pnpm lint:agents`
- `pnpm check`
- VPS exact-head 的 `pnpm test:docker` 和 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论（用例不覆盖本接口，只证明入口未回归；真实实例经网桥访问代理由 14.5 和 15.x 验证）

**交接**：

- 14.2–14.4：在 `ragflow-proxy/routes.ts` 添加路由，从 `request.instanceUserId` 取身份，沿用 200 加 `result` 的回应约定与 `INSTANCE_ERRORS`；每个新 GET 都设路由级 `exposeHeadRoute: false`；检索 POST 自行要求 `application/json`（415）。#524 评审建议补一条绝对形式目标（`GET http://h/_platform/instance-api/ragflow/version` 经原始 socket 发送，无令牌 → 401、0 个上游请求）的集成用例，把对 find-my-way 去掉绝对形式 authority 的依赖钉住；14.2 一并加。
- 14.5 或 15.x：在真实 Docker 网桥上证明实例从 +2 地址带令牌可达、其他实例地址被拒。本 issue 的集成测试只能在 loopback 上模拟地址比较。

Risk packs (14.2 库列表路由，#414): fixture level expanded（与 issue 建议一致：员工可见的上游数据第一次经代理返回，14.4 的检索预检也要用同一份完整列表）。selected：

- **Public API / Schema / field names**：
  - 新增 `GET /_platform/instance-api/ragflow/datasets`。
  - 回应沿用 #413 约定：成功为 `{ result: 'ok', datasets: [{ id, name }] }`；失败为 `{ result }`，取值是 `not-configured`、`invalid-request`、`timeout`、`unavailable`、`upstream-error` 之一。
  - 结果集合常量 `RAGFLOW_RESULTS` 加入 `invalid-request`。`no-results` 留给 14.4。库列表为空时回 `ok` 加空数组，面板据此显示「空」，不当作错误。
  - 只返回 `id` 与 `name`：spec 只要求面板显示库名，搜索和分页由面板在完整列表上本地完成。200 schema 的外层和条目都设 `additionalProperties: false`，即使映射代码有缺陷，序列化器也会丢弃 `description`、`tenant_id`、`avatar` 等字段。
  - 路由设 `exposeHeadRoute: false`，鉴权沿用 #413 的钩子。
  - 查询参数：
    - 不声明 `querystring` schema。Fastify 默认的 Ajv `removeAdditional` 会静默丢弃多余字段，而不是拒绝。
    - 改为检查原始 `request.url`：含 `?`（包括末尾只有一个 `?`）就回 `invalid-request`，不访问 RAGFlow。
    - 契约里表达不出这条拒绝，在路由 `summary` 中写明。
- **Resource limits / large input**：
  - 一次请求取完整列表：`GET /api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false`。
    - rc2 源码 `internal/handler/dataset.go:94-121` 对 `page_size` 只要求 ≥ 1，没有上限；未知查询参数一律拒绝（`listDatasetsAllowedParams`），所以这里只用 `page`、`page_size`、`orderby`、`desc` 四个参数。
    - 用一次请求，不分页：分页翻页期间删库会让后面的条目前移、跳过一个仍存在的库，14.4 预检就会把它误判为已删除。单次请求没有这个竞态，也不需要去重或跨页截止。
    - 固定排序（创建时间升序），不依赖默认排序。
  - 数量上限 1000 个库：
    - 返回 1001 个条目 → `upstream-error`，不截断。截断会让 14.4 误把存在的库判为已删除。
    - 返回条目数必须等于 `total_datasets`；`total_datasets` 缺失、不是非负整数、或与条目数不等 → `upstream-error`。这一条防住上游悄悄截断。
  - 回应体上限 `RAGFLOW_LIST_BODY_LIMIT = 8 MiB`，只用于列表；版本和测试连接仍为 64 KiB。`ragflow-proxy/client.ts` 的 `call` 改为接收上限参数。
    - 依据：rc2 实测每个库约 2.1 KB，其中 `parser_config` 1.6 KB；实测的库和所有者账号都没有头像。
    - 头像体积不受控：rc2 的列表查询给每一行都附带库自己的 `avatar`，以及库所有者账号的头像 `tenant_avatar`（`internal/dao/kb.go:259-277`、`internal/service/dataset/utils.go:18-45`）。两者都是不限长的 `longtext`，以 base64 data URL 保存，保存时只校验 MIME 前缀（`validateDatasetAvatar`）。
    - 通常所有库由同一个账号所有。该账号设了头像时，头像字节会在每一行重复一次。例如 100 KB 的账号头像，约 80 个库就会超过 8 MiB；不设头像时约可容纳 1000 个库。
    - 超过上限 → `upstream-error`，整个列表和 14.4 的所有检索都会失败。这是用户 2026-11-03 拍板接受的残余风险（另两种做法是放宽到 32 MiB，或流式解析只保留 id/name，均不采用）。AGENTS.md 和部署文档写明：建 RAGFlow 知识库的账号不要设大头像，库也尽量不设大头像。
  - 单次请求沿用固定截止 `RAGFLOW_TIMEOUT_MS`（覆盖读体），不重试、不缓存，每次请求都重新拉取。
- **Error handling / partial outputs**：
  - `data` 必须是数组。任一条目不合格时整体为 `upstream-error`，从不返回部分列表。条目合格的条件：
    - `id` 匹配 `^[0-9a-f]{32}$`（rc2 实测 ID 格式）；
    - `name` 为非空字符串，UTF-8 不超过 1024 字节。
  - rc2 的库名规则：去掉首尾空白后非空，最多 128 字节，见 `internal/service/dataset/crud.go:30-38` 与 `internal/entity/dataset.go:25` 的 `DatasetNameLimit = 128`；它不限制控制字符。所以代理不按字符内容拒绝，只设一个宽松的字节上限，免得一个合法库名让整个列表和所有检索失败。显示时的转义由面板负责（React 文本节点）。
  - 重复 ID → `upstream-error`。单次请求里出现重复 ID 说明上游异常。
- **Auth / permissions / secrets**：
  - 只在鉴权通过后执行。密钥只放在 RAGFlow 请求头里。
  - 回应和日志不含地址、密钥、上游消息和被丢弃的字段。
- **Code Canonicality**：
  - 列表逻辑放在 `ragflow-proxy/client.ts` 的 `listRagflowDatasets(settings, signal, deadlineMs, send?)`，复用 `call`、`endpoint`、`envelope` 和映射；14.4 预检直接调用它。
  - 路由放在 `ragflow-proxy/routes.ts`，复用 `withRequestAbort` 与固定 500。
- **Legacy compatibility**：
  - `RAGFLOW_VERSION_SCHEMA` 的 `result` 枚举随 `RAGFLOW_RESULTS` 扩大，`schemas/openapi.json` 中版本路由和管理员测试连接路由的枚举随之变化。这两条路由的行为不变，它们从不产生 `invalid-request`。design 决定 3 要求全模块共用一个封闭集合，目前还没有 Web 消费方。
- **Documentation / migration notes**（由 orchestrator 改）：AGENTS.md 代理条目补上：库列表路由、只返回 `{id,name}`、1000 个库与 8 MiB 上限及超限时的 `upstream-error`（含账号头像在每一行重复的说明）、查询参数拒绝。部署文档 `docs/DEPLOY.md` 的 RAGFlow 说明加一句头像提示（若该文档尚无 RAGFlow 段落，交给 16.4 / 19 组的部署文档任务，并在交接中写明）。

not selected：

- Config / project setup：数量与体积上限是代码常量，不新增环境变量。
- Concurrency / shared state：请求之间互不共享状态；单次请求没有翻页竞态。
- File IO / path safety：本路由没有路径参数（14.3 才有）。
- Release / packaging、Migration：无。

**不变量**：

- 回应中的库列表是一次上游回应的完整内容：条目数等于 `total_datasets`，不超过 1000，每条只含合格的 `id` 和 `name`。
- 未配置或请求带查询参数时，不发任何外部请求。
- 回应只含封闭集合中的 `result`，成功时加 `datasets`。

**Must preserve**：

- `version` 路由与 #411 测试连接的行为不变：仍是 64 KiB 上限，结果相同。
- #413 鉴权钩子不变。

**同级面**：

- 14.3 文件路由用同一个 ID 格式校验路径参数。
- 14.4 检索预检调用 `listRagflowDatasets`。
- 15.2 面板在完整列表上本地搜索、分页。

**宽度**：client 扩展、路由、单元与集成测试，加上本段 fixture 与 AGENTS.md，可能超过 400 行；超过时打 `diff-limit-exempt`。

Evidence (14.2 库列表路由，#414):

**改动点**：

- 修改：
  - `ragflow-proxy/client.ts` 与测试：`call` 接收体积上限；新增 `listRagflowDatasets`；`RAGFLOW_RESULTS` 加入 `invalid-request`；
  - `ragflow-proxy/routes.ts` 与测试；
  - `ragflow-proxy/index.ts`；
  - 集成测试：新建 `platform/test/ragflow-proxy-datasets.integration.test.ts`，复用 `instance-token-fixture.ts` 和 `model-upstream-fixture.ts`；
  - `schemas/openapi.json`。
- AGENTS.md 由 orchestrator 改。

**测试**：

`client.test.ts`（注入 `send`）：

- 未配置时不调用 `send`。
- 3 个库、`total_datasets: 3` → `ok`：
  - 只请求一次，路径恰为 `/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false`，带 `Authorization`；
  - 输出恰为 `[{id,name}]`，顺序与上游一致，被丢弃的字段不出现。
- 0 个库、`total_datasets: 0` → `{ result: 'ok', datasets: [] }`。
- 1000 个库 → `ok`；1001 个库 → `upstream-error`。
- 条目数与 `total_datasets` 不等，或 `total_datasets` 缺失、为 `-1`、为 `1.5`、为字符串 → `upstream-error`。
- 条目不合格：ID 大写、长度 31、名字为空、名字为数字、名字超过 1024 字节、`data` 不是数组 → `upstream-error`。名字含 `\u0001`、或 1024 字节整（多字节字符）→ 接受。
- 重复 ID → `upstream-error`。
- 回应体超过 8 MiB → `upstream-error`。
- `code: 102`、超时、拒绝连接 → 对应的失败取值。
- 外部中止 → 抛出。
- 测试连接与版本路由仍用 64 KiB：64 KiB+1 的回应仍为 `upstream-error`。

集成测试（真实 TCP、自有假 RAGFlow、有效实例令牌）：

- 成功：
  - 回应恰为 `{ result: 'ok', datasets: [...] }`；
  - 假服务收到 1 个请求，路径和 `Authorization` 正确；
  - 回应文本不含假服务 origin、密钥，也不含 handler 放在 `description`、`avatar`、`tenant_avatar` 和 `nickname` 中的 MARKER。
- 空库列表 → `{ result: 'ok', datasets: [] }`。
- 未配置 → `not-configured`，假服务收到 0 个请求。
- HTTP 200 加 `code: 102` → `upstream-error`。
- 超时：集成测试经 `index.ts` 直接调用 `listRagflowDatasets`，传 200 ms → `timeout`（同 #411 的做法）。
- 拒绝连接 → `unavailable`（`refusedOrigin()`）。
- 查询参数：`?page=2` 和只有 `?` → `invalid-request`，假服务收到 0 个请求。
- 无令牌 → 401，假服务收到 0 个请求（#413 回归）。
- 鉴权通过后 `HEAD …/datasets` → 404，假服务收到 0 个请求。
- 绝对形式目标 `GET http://h/_platform/instance-api/ragflow/datasets`，经原始 socket 发送、不带令牌 → 401，假服务收到 0 个请求（#524 评审交接）。

**运行时证据**（对本机 RAGFlow rc2 只读，脚本只打印结果、个数、ID 格式和 `total_datasets` 是否相等）：

- 直接调用 `listRagflowDatasets`。期望结果：`ok`，3 个库，ID 格式合格，个数等于 `total_datasets`。
- 用同一脚本确认 rc2 遵守 `page_size` 且 `page` 从 1 开始。期望：
  - `page=1&page_size=2` 返回 2 条；
  - `page=2&page_size=2` 返回 1 条；
  - `page=3&page_size=2` 返回 `code: 0` 和空数组；
  - `orderby=create_time&desc=false` 被接受。

**命令**：

- `pnpm test`、`pnpm test:integration`、`pnpm contract:check`、`pnpm check`
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论

**交接**：

- 14.3：库 ID 路径参数用同一个 `^[0-9a-f]{32}$`，并说明其文件分页策略。
- 14.4：预检调用 `listRagflowDatasets`，它的失败取值直接成为检索结果。
- 15.2：面板在 `datasets` 上本地搜索、分页。
- 部署文档：`docs/DEPLOY.md` 目前没有 RAGFlow 段落（第 246 行写明本阶段不交付）。头像提示交给第 19 组集成验收的部署文档更新，届时写入「建 RAGFlow 知识库的账号和库不要设大头像，否则库列表超过 8 MiB 会返回 `upstream-error`」。
- 后续：#411 的测试连接只取 1 行、上限 64 KiB；单个头像超过约 64 KiB 时，测试连接会误报 `upstream-error`。另开 issue 跟踪。

Risk packs (14.3 库内文件路由，#415): fixture level expanded（与 issue 建议一致：第一个带路径参数和员工输入的代理路由）。selected：

- **Public API / Schema / field names**：
  - 新增 `GET /_platform/instance-api/ragflow/datasets/:id/documents`。
  - 成功回应 `{ result: 'ok', total, documents: [{ id, name }] }`。其中 `total` 是筛选后的总数（rc2 语义，见下），供面板分页；失败时只回 `{ result }`。
  - 只返回 `id` 与 `name`（spec：面板只读展示库内文件名）。200 schema 外层与条目都设 `additionalProperties: false`。
  - 路由设 `exposeHeadRoute: false`，鉴权沿用 #413 的钩子，结果集合不新增取值。
  - 契约里声明请求 schema：`params`（`id`，pattern 32 位 hex）和 `querystring`（`page`、`page_size`、`keywords`，`additionalProperties: false`），满足 spec「每个接口 MUST 声明请求和响应 schema」，先例是 `admin/routes.ts` 的 `/users/{userId}/password`。
    - 路由设 `attachValidation: true`，Fastify 的校验结果不发出 400。
    - 以下面的原始解析为准，`request.query`、`request.params` 被 Ajv 强转或删字段也不影响结果。
- **File IO / path safety**（路径参数）：
  - 以下两种请求在路由之前就被 Fastify 处理，与本路由无关，记为现状：
    - 路径里有无法解码的 `%`（如 `/datasets/%zz/documents`）：Fastify `onBadUrl` 在鉴权钩子之前返回 400 `FST_ERR_BAD_URL`。
    - `:id` 超过 `maxParamLength`（100 字符）：返回 404。
  - `:id` 必须匹配 `RAGFLOW_DATASET_ID_PATTERN`（`^[0-9a-f]{32}$`，#414 已导出）。匹配在 find-my-way 解码路径参数之后进行，不匹配 → `invalid-request`，不访问 RAGFlow。
  - 拼上游路径时只用通过校验的 32 位 hex，不做任何编码转换。因此 `..`、`%2F`、大写 hex 都到不了上游。
  - 点段只能经原始 socket 测试：`app.inject` 与 `fetch` 都会用 WHATWG URL 把 `..`、`%2e%2e` 折叠掉，请求根本到不了路由。find-my-way 不折叠点段，`%2e` 解码为 `.`，所以经原始 socket 发送时参数是 `..`，应得到 `invalid-request`。
- **Config / input validation**（员工查询参数）：
  - 以原始 `request.url` 为准自行解析，原因同 #414：Ajv 的 `removeAdditional` 和类型强转会改写 `request.query`。
    - 原始 URL 含 `#` → `invalid-request`。find-my-way 会在 `#` 处截断，`request.url` 保留原样。
    - 取第一个 `?` 之后的部分，按 `&` 切分；每一项按第一个 `=` 拆成名和值，没有 `=` 的项 → `invalid-request`。
    - 名和值各自先把 `+` 换成空格，再 `decodeURIComponent`；抛 `URIError` → `invalid-request`。`URLSearchParams` 不能代替这一步：它不会因非法编码抛错，`%zz` 原样保留，`%ff` 变成 U+FFFD。
    - 因此 `a+b` 解码为 `a b`，`a%2Bb` 解码为 `a+b`。
  - 允许的键：
    - `page`：必填，匹配 `^[1-9][0-9]{0,5}$`；
    - `page_size`：必填，1..100，匹配 `^(100|[1-9][0-9]?)$`；
    - `keywords`：可选；去掉首尾空白后必须非空（rc2 会 trim，纯空白等于不筛选，返回的 `total` 会让面板的「无匹配」状态失真）；UTF-8 不超过 256 字节；原样转发，不在代理里 trim。
  - 以下情况都回 `invalid-request`，不访问 RAGFlow：出现其他键；同一个键出现多次；缺少必填键；任一值不合规；查询串含无法解码的 `%`。
  - `page_size` 上限 100 的依据：rc2 `internal/handler/document.go` 在 `page_size < 1 || page_size > 100` 时静默改为 10，不报错。代理必须先拒绝，否则员工会拿到与请求不符的页大小。
  - 文件名筛选是 rc2 的 `keywords`，语义为 `LOWER(name) LIKE %kw%`，不转义（`internal/dao/document.go:313-314`）。所以 `%` 和 `_` 是通配符，`\` 是 MySQL LIKE 默认的转义字符，筛选结果可能多于或少于字面匹配。这只影响只读结果，记作已接受的语义差异。代理原样转发、做 URL 编码，不自行转义。
- **Resource limits / large input**：
  - 上游请求 `GET /api/v1/datasets/{id}/documents?page=P&page_size=S&orderby=create_time&desc=false[&keywords=K]`，每页只发一次请求，不在代理里翻页。
  - 回应体上限复用 `RAGFLOW_LIST_BODY_LIMIT`（8 MiB）。依据：rc2 实测每个文件约 2.5 KB，包括 `parser_config`、`meta_fields` 和 `thumbnail`。实测文本文件的 `thumbnail` 为空，但 PDF 或图片的缩略图可能是 base64。页大小由员工控制（≤ 100），面板应选用较小的页（交接给 15.2）。超限 → `upstream-error`。
  - 固定截止 `RAGFLOW_TIMEOUT_MS`，不重试，不缓存。
- **Error handling / partial outputs**：
  - 上游 `code: 404`（库不存在；rc2 实测：HTTP 200 加 `code: 404`，`data: null`）和 `code: 403`（库存在但密钥无权访问；rc2 `ListDocuments` 调 `CheckAccess` 时 `hideResource=false`，`internal/permission/response/errors.go:45-66` 把 `ErrPermissionDenied`、`ErrMembershipNotFound` 映射为 403）→ `invalid-request`。两者都表示请求指向的库不在本密钥可见的库列表里，属于请求不合法，面板据此刷新库列表。其他非零 `code` 仍按共用映射处理（401 → `not-configured`，其余 → `upstream-error`）。
  - `data.total` 必须是非负整数；`data.docs` 必须是数组，长度不超过请求的 `page_size`，也不超过 `total`。
  - 每个条目的要求：`id` 匹配 `^[0-9a-f]{32}$`（rc2 实测格式）；`name` 为非空字符串，UTF-8 不超过 1024 字节；`dataset_id` 必须等于请求的库 ID。任一条目不合格 → 整体 `upstream-error`，不返回部分页面。
  - 同一页里有重复 ID → `upstream-error`。
  - 超出末页（`total > 0`、`docs: []`）→ `ok`，`documents: []`，`total` 照实返回。
  - 跨页顺序不稳定，属于已接受的残余风险：rc2 按 `document.create_time ASC` 排序，没有次排序键（`internal/dao/document.go:222-233`），本接口也不读 `sort`。同一毫秒创建的文件，或翻页期间有上传、删除，都可能让条目跨页重复或被跳过。面板需要容忍跨页出现重复的 `id`；同一页内的重复仍是 `upstream-error`。
- **Auth / permissions / secrets**：只在鉴权通过后执行，且路径与查询参数都通过校验后才读设置。密钥只放在请求头里。回应和日志不含地址、密钥和上游消息，也不含员工的 `keywords`。
  - 现状：`app.ts` 的 Fastify 默认请求日志（`incoming request`）记录带查询串的 `req.url`，`keywords` 会以百分号编码的形式进入每条请求日志。
  - 修复：在 `app.ts` 的 logger 中加 `serializers.req`，对本前缀的请求把 `url` 的查询串替换为 `?[redacted]`，其他路径的日志不变。路由日志仍然只有固定文字加 `result`。
    - 判定与鉴权钩子共用同一个函数：把 `instance-auth.ts` 的 `underPrefix`（路由视角或去掉查询串后的原始路径）导出后复用，不复制。只看原始路径会漏掉编码变体 `/_platform/instance-api/ragflo%77/…` 和绝对形式目标 `GET http://h/_platform/instance-api/ragflow/…`：两者都会到达路由。
    - 写 `incoming request` 日志时路由已完成匹配。
    - 替换后的序列化器保留 Fastify 默认的 `req` 字段（`method`、`url`、`version`、`host`、`remoteAddress`、`remotePort`，见 `fastify/lib/logger-pino.js:47-56`），只改 `url`。
- **Code Canonicality**：
  - `listRagflowDocuments(settings, datasetId, query, signal, deadlineMs, send?)` 放在 `client.ts`，复用 `call`、`endpoint`、`keyHeaders`、`envelope` 和映射规则。条目校验与 `listRagflowDatasets` 共用 ID/名字校验函数，不复制。
  - 路由复用 `relay`。
- **Legacy compatibility**：不改既有路由与结果集合；`schemas/openapi.json` 只新增这条路由。前缀以外的请求日志格式不变。
- **Documentation / migration notes**（由 orchestrator 改）：AGENTS.md 代理条目补上文件路由的参数、上限、404 映射和 `keywords` 通配符语义。

not selected：

- Concurrency / shared state：代理没有共享状态；跨页顺序不稳定见上面的残余风险。
- Release / packaging、Migration：无。

**不变量**：

- 每个回应的页面都来自一次合格的上游回应：条目数不超过 `page_size` 和 `total`，每条都属于所请求的库。
- 路径参数或查询参数不合规时，不读设置，也不发外部请求。
- 回应只含封闭集合的 `result`，成功时再加 `total` 和 `documents`。

**Must preserve**：

- `version` 与 `datasets` 路由、#411 测试连接、#413 鉴权钩子的行为不变。

**同级面**：

- 15.2 面板展开库时调用本路由，自行分页并做文件名筛选。
- 14.4 检索结果里的来源文件名来自检索接口本身，不调用本路由。

**宽度**：client、路由、测试，加上本段 fixture 与 AGENTS.md，可能超过 400 行；超过时打 `diff-limit-exempt`。

Evidence (14.3 库内文件路由，#415):

**改动点**：

- 修改：
  - `ragflow-proxy/client.ts` 与测试：`listRagflowDocuments` 及共用的条目校验；
  - `ragflow-proxy/routes.ts` 与测试；
  - `ragflow-proxy/index.ts`；
  - `platform/src/app.ts` 与 `app.test.ts`：logger 的 `serializers.req` 去掉本前缀请求日志中的查询串；
  - `schemas/openapi.json`。
- 新建 `platform/test/ragflow-proxy-documents.integration.test.ts`，复用 `instance-token-fixture.ts` 和 `model-upstream-fixture.ts`。
- AGENTS.md 由 orchestrator 改。

**测试**：

`client.test.ts`（注入 `send`）：

- 未配置时不调用 `send`。
- 成功：
  - 请求路径恰为 `/api/v1/datasets/<id>/documents?page=2&page_size=30&orderby=create_time&desc=false`，带 `Authorization`；
  - 输出恰为 `{ result: 'ok', total, documents: [{id,name}] }`，顺序与上游一致；
  - 不出现 `thumbnail`、`location`、`created_by`、`nickname`、`meta_fields` 等丢弃字段。
- 带 `keywords`：`keywords=报告 a_b%` 经 URL 编码后出现在上游查询串中；已解码的 `a b` 与 `a+b` 分别编码为 `a%20b` 与 `a%2Bb`。
- 空页（`total: 0`，`docs: []`）→ `ok`。
- 超出末页（`total: 2`，`docs: []`）→ `{ result: 'ok', total: 2, documents: [] }`。
- 上游 `code: 404` 与 `code: 403` → `invalid-request`；`code: 102` → `upstream-error`；`code: 401` → `not-configured`。
- 以下情况 → `upstream-error`：`docs` 长度超过 `page_size`；`docs` 长度超过 `total`；`total` 为 `-1`、`1.5`、字符串或缺失；条目 `dataset_id` 不等于请求的库；条目 ID 不合格；名字为空或超过 1024 字节；重复 ID；回应体超过 8 MiB。
- 超时、拒绝连接、外部中止的映射与其他路由一致。

`routes.test.ts`：

- 路径参数不合格 → `invalid-request`。用 `DROP TABLE settings` 证明在读设置之前就被拒绝。不合格的写法：31 位、33 位、大写 hex、`%2F` 混入（点段改到集成测试中走原始 socket）。
- 查询参数（同样在读设置之前被拒）：
  - 缺 `page`、缺 `page_size` → `invalid-request`；
  - `page=0`、`page=01`、`page=1000000`、`page_size=0`、`page_size=101`、`page_size=1.5` → `invalid-request`；
  - `keywords=`（空）、`keywords=%20%20`（纯空白）、`keywords` 超过 256 字节、`keywords=%zz`、`keywords=%ff`、`keywords=%C3`、重复的 `page`、未知键 `x=1`、没有 `=` 的项 `page`、只含 U+0085 的 `keywords=%C2%85`（rc2 的 Go `TrimSpace` 会把它当空白）→ `invalid-request`；
  - 边界接受：`page=1`、`page=999999`、`page_size=1`、`page_size=100`、`keywords` 恰为 256 字节。
- 未配置 → `not-configured`；HEAD → 404；存储故障 → 500。

集成测试（真实 TCP、自有假 RAGFlow、有效实例令牌）：

- 成功：
  - 恰好收到 1 个请求，路径、查询串与 `Authorization` 正确；
  - 回应恰为期望的 JSON；
  - 回应文本不含 handler 放进 `thumbnail`、`location`、`nickname` 和上游 `message` 里的 MARKER，也不含假服务 origin 和密钥。
- 分页：`page=2&page_size=1`，假服务按页返回，回应中 `total` 与条目正确。
- 非法 ID（`/datasets/ABC/documents?page=1&page_size=10`）与非法参数（`page_size=101`）→ `invalid-request`，假服务收到 0 个请求。
- 点段：经原始 socket 发 `/_platform/instance-api/ragflow/datasets/../documents?page=1&page_size=10` 与 `…/datasets/%2e%2e/documents?…` → `invalid-request`，假服务收到 0 个请求。
- 原始 URL 含 `#`（经原始 socket 发 `…/documents?page=1&page_size=10#x`）→ `invalid-request`，假服务收到 0 个请求。`app.inject` 会丢掉片段，所以这条只能放在这里测。
- 解码往返：`keywords=a+b` 时假服务收到 `keywords=a%20b`，`keywords=a%2Bb` 时收到 `keywords=a%2Bb`。断言假服务收到的查询串。
- 日志：`keywords` 放 ASCII MARKER（如 `kwmarker411`），分别用以下三种形式请求。每种请求之后，所有日志行（含 Fastify 的 `incoming request` 与 `request completed`）都不含 MARKER，且请求日志仍有 `method`、`url`、`remoteAddress` 字段：
  - 普通路径；
  - 编码变体 `/_platform/instance-api/ragflo%77/datasets/<id>/documents?…`；
  - 经原始 socket 发送的绝对形式目标。
- 上游 `code: 404` → `invalid-request`；HTTP 200 加 `code: 102` → `upstream-error`。
- 超时：经 `index.ts` 直接调用 `listRagflowDocuments`，传 200 ms → `timeout`。
- 拒绝连接 → `unavailable`。
- 无令牌 → 401，假服务收到 0 个请求。

**运行时证据**（对本机 RAGFlow rc2 只读，脚本只打印结果、个数和格式事实）：

- 对每个种子库调用 `listRagflowDocuments`（`page=1&page_size=100`）：结果 `ok`，个数等于 `total`（每库 2 个），ID 格式合格。
- 分页 `page=2&page_size=1`：1 条，`total` 为 2；`page=3&page_size=1`：0 条，`total` 为 2。
- 不存在的库：`invalid-request`。

**命令**：

- `pnpm test`、`pnpm test:integration`、`pnpm contract:check`、`pnpm check`
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论

**交接**：

- 15.2：
  - 面板用 `page_size` 30 左右分页，并容忍跨页出现重复的 `id`；
  - 文件名筛选走 `keywords`，接受 `%`、`_`、`\` 的 LIKE 语义；
  - 收到 `invalid-request`（库不存在或无权访问，即上游 404/403）时刷新库列表。
- 14.4：检索的来源文件名直接取检索结果，不调用本路由。

Risk packs (14.4 检索路由，#416): fixture level expanded（与 issue 建议一致：员工的问题第一次经平台发往 RAGFlow，结果直接进入 Agent 上下文）。selected：

- **Public API / Schema / field names**：
  - 新增 `POST /_platform/instance-api/ragflow/retrieval`，鉴权沿用 #413 的钩子。
  - 请求体恰为 `{ question, datasetIds }`：
    - `question`：字符串，空白判定与 14.3 的 `keywords` 共用同一个函数（`\s` 加 U+0085，对齐 rc2 的 Go `TrimSpace`），纯空白 → `invalid-request`；UTF-8 不超过 4096 字节；原样转发，不在代理里 trim。
    - `datasetIds`：非空数组，1..1000 项（上限与库列表的 `MAX_DATASETS` 相同，超出的部分不可能都存在），每项匹配 `RAGFLOW_DATASET_ID_PATTERN`，不得重复。
    - 出现其他任何键 → `invalid-request`。这一条覆盖 spec「实例不能自带检索参数」：`top_k`、`page_size`、`similarity_threshold`、`keywords_similarity_weight`、`vector_similarity_weight`、`rerank_id` 都属于其他键，不必逐个列举。
  - 请求体校验手写在路由里，用 `validatorCompiler: () => (value) => ({ value })` 关掉 Ajv（先例：`admin/empty-body.ts`）。原因：Fastify 默认的 Ajv 带 `removeAdditional: true` 和 `coerceTypes: 'array'`，声明的 body schema 会悄悄删掉 `top_k`（spec 场景就失效了），还会把 `datasetIds: "abc"` 强转为 `["abc"]`。body schema 照常声明，只用于契约。
  - 成功回应：
    - `{ result: 'ok', excluded, chunks }`；
    - 检索成功但零片段：`{ result: 'no-results', excluded }`；
    - 剔除后范围为空（spec「全部失效时不检索」的空范围结果）：同样是 `{ result: 'no-results', excluded }`，`excluded` 恰为全部请求的 ID，不发检索请求；
    - 失败只有 `{ result }`。
    - `excluded` 是请求中不在当前库列表里的 ID，按请求顺序排列；成功时总是出现，可以为空数组。
  - 片段 `{ content, documentName, datasetName, positions? }`：
    - `content` 取上游 `content`（rc2 由 `content_with_weight` 改名）；
    - `documentName` 取 `document_keyword`（由 `docnm_kwd` 改名）；
    - `datasetName` 取预检库列表里该 `dataset_id` 的名字。rc2 片段只带 `dataset_id`，不带库名，所以预检列表同时是名字表；
    - `positions` 见下面「结果字段只含真实值」。
    - 其他上游字段一律丢弃：`id`、`document_id`、`content_ltks`、`similarity`、`term_similarity`、`vector_similarity`、`image_id`、`important_keywords`、`questions`、`doc_type_kwd`、`highlight`，以及 `data` 里的 `doc_aggs`、`labels`、`total`。
  - 200 schema 外层与片段都设 `additionalProperties: false`；另声明 401、413、415、500 的 `ERROR_SCHEMA`。
  - `RAGFLOW_RESULTS` 加入 `no-results`。version、datasets、documents 三条路由和 #411 测试连接共用这个枚举，它们契约里的 `result` 枚举随之多一个值，但这些路由的行为不变（#414 加入 `invalid-request` 时同样如此）。
- **Config / input validation**（传输层）：
  - 路由级 `onRequest` 检查 `Content-Type`：媒体类型（`;` 之前，trim、小写）必须恰为 `application/json`，否则返回固定体 415（`INSTANCE_ERRORS` 新增 415），不解析请求体。它排在根鉴权钩子之后，所以无令牌的请求仍是 401。
    - 判定与 `auth/request-guard.ts` 的平台变更守卫共用同一个函数：把那里的媒体类型判断抽成导出函数，经 `auth/index.ts` 导出，守卫行为不变。这一处超出 issue 的 PR Boundary，由本条授权。
    - 依据（Fastify 5.12.7 实测）：没有 `Content-Type` 也没有请求体时，`body` 是 `undefined`，会进入 handler；`text/plain` 会被默认解析器解析为字符串；只有带请求体又没有 `Content-Type`，或用了没有解析器的类型（如 `application/vnd.api+json`），Fastify 才自己回 415。所以必须由路由自己检查。
  - 路由 `bodyLimit` 为 64 KiB（4096 字节的问题加 1000 个 ID 约 35 KB）。
  - 路由级 `errorHandler`：
    - `FST_ERR_CTP_INVALID_JSON_BODY`（含 `__proto__`、`constructor.prototype` 投毒，实测都是这个错误码）和 `FST_ERR_CTP_EMPTY_JSON_BODY` → HTTP 200 `{ result: 'invalid-request' }`；
    - `FST_ERR_CTP_BODY_TOO_LARGE` → 固定体 413（`INSTANCE_ERRORS` 新增 413）；
    - 其他错误 → 固定体 500，只记固定文字。不交给 Fastify 默认错误处理，因为它会把错误对象写进日志。
  - JSON `null`、数组、字符串等非对象请求体 → `invalid-request`。
- **Resource limits / large input**：
  - 顺序：鉴权 → 媒体类型 → 解析请求体 → 校验请求体 → 一次 `readSettings`（连接设置和四个检索参数取自同一次读取）→ 预检 → 检索。前四步任一不过都不读设置、不发外部请求。design 决定 3 的「处理顺序」把读设置写在校验之前；两者对外行为相同，本路由沿用 14.2、14.3 先校验后读设置的做法。
  - 预检直接调用 `listRagflowDatasets`（#414），它的失败取值直接成为检索结果，检索请求不发出。
  - 检索请求：`POST <base>/api/v1/retrieval`，`Content-Type: application/json`，带 `Authorization`，`redirect: 'manual'`。请求体恰为：
    - `question`；
    - `dataset_ids`：剔除后剩余的 ID，按请求顺序；
    - `page: 1`、`page_size: retrievalTopK`；
    - `similarity_threshold: retrievalSimilarityThreshold`；
    - `keywords_similarity_weight: retrievalKeywordsWeight`；
    - `rerank_id`：只在 `retrievalRerankId` 非空时出现，值原样；
    - `rerank_candidates_count: max(64, retrievalTopK)`。rc2 默认候选数是 64（`internal/service/dataset/search.go:49-52`，只有 `search_id` 分支会改它），而 `internal/service/nlp/retrieval.go:141-145` 在 `page > rerank_candidates_count / page_size`（Go 整数除法）时报错。不发这个字段时，返回片段数 65..100 会让 `64/page_size` 为 0，每次检索都以 `code: 102` 失败，而管理员接口允许 1..100。取 `max(64, …)`，小值时保持 rc2 默认的候选池；
    - `include_knowledge_compilation: false`。不发时，rc2 的过滤条件是「普通片段或 `scope_kwd = dataset`」（`search.go:364-378`），会返回库级的编译知识行。这些行由 `internal/ingestion/knowledge_compile/writer.go:553-568` 写入，`content_with_weight` 是 JSON，没有 `docnm_kwd`，没有来源文件，不满足 spec「每个片段 MUST 包含片段文本、文件名和所属知识库名称」；在任一选中的库有编译输出之后，它们会让整次检索变成 `upstream-error`。`false` 只保留普通片段（`must_not exists compile_kwd`）。
    - 不发 `top_k`（design 决定 3）、`vector_similarity_weight`（rc2 由 `keywords_similarity_weight` 推导为 1 减它，`internal/service/similarity_weight.go:29-44`；两者同时发且和不为 1 会报错）、`highlight`、`keyword`、`document_ids`。
  - 预检和检索各有自己的 `RAGFLOW_TIMEOUT_MS` 截止（先例：#411 测试连接的两步），最坏约 20 秒；不重试，不缓存。
  - 检索回应体上限复用 `RAGFLOW_LIST_BODY_LIMIT`（8 MiB）。最多 100 个片段，但 rc2 每个片段还带 `content_ltks` 分词结果，`data` 里另有 `doc_aggs` 和 `labels`。超限 → `upstream-error`。
  - 每次检索都会再拉一次完整库列表。#414 交接里的「限制并发的列表拉取」本 issue 不做，记作残余风险：库列表实际只有几 KB 到几百 KB，只有库数很多、头像很大时，多个实例并发检索才会占用可观的内存。
- **Error handling / partial outputs**：
  - 检索回应：`data` 必须是对象，`data.chunks` 必须是数组，长度不超过 `retrievalTopK`。
  - 每个片段的要求：
    - 是对象；
    - `content` 是字符串；
    - `document_keyword` 是非空字符串，UTF-8 不超过 1024 字节；
    - `dataset_id` 是字符串，且在本次实际检索的集合内。否则就是越界片段（spec「返回片段越界校验」）：整次检索 `upstream-error`，回应中没有任何片段；
    - `positions` 缺失、`null` 或是数组（见下）。
    - 任一片段不合格 → `upstream-error`，不返回部分结果。
  - `code` 映射沿用默认规则：`401` → `not-configured`，其余非零 → `upstream-error`。rc2 中可能出现的情况（`internal/handler/dataset.go:1093-1170`、`internal/service/dataset/search.go`）：
    - 所选库使用不同的 embedding 模型，或有的库没有 embedding 模型（`ValidateDatasetEmbeddingModels`）→ `code: 102`；
    - 预检之后库被删除（竞态）→ 权限或「not found」错误；
    - 重排模型 ID 不存在或调用失败 → `code: 102`；
    - 参数错误 → `code: 101`。
  - **用户决定（2026-11-03）**：所选库混用 embedding 模型时，整次检索 `upstream-error`。代理不按模型分组检索，design 决定 3 仍是「一次多库检索」。新 Session 默认全选（D10），所以管理员必须让所有知识库使用同一个 embedding 模型。AGENTS.md 写明这一条，部署文档交给第 19 组。
- **结果字段只含真实值**（spec「没有页码就不显示页码」）：
  - rc2 主路径总是返回 `positions`，没有值时是 `[]`（`internal/service/nlp/retrieval.go:313-316`）；父子聚合的片段直接取父片段的 `position_int`，没有时是 JSON `null`（`retrieval.go:1171`）。代理只在 `positions` 是非空数组时输出它；`[]`、`null` 或缺失时片段里没有这个字段，不填 0 或空串。
  - 代理不从 `positions` 推导页码。rc2 的五元组含义取决于文件类型（`internal/ingestion/task/indexdoc/position.go`）：PDF 是 `[页码, left, right, top, bottom]`，页码从 1 开始；表格是 `[sheet, rowStart, rowEnd, colStart, colEnd]`。代理推导出的「页码」对表格就是伪造。
  - 校验：每个元素都是恰好 5 个有限数的数组，最多 1024 个元素；否则 `upstream-error`。数组原样输出。
  - 运行时只能验证空数组这一支：种子数据全是 `.txt`。非空分支依据源码，在有 PDF 种子之前没有运行时证据。
- **Auth / permissions / secrets**：
  - 只在鉴权通过后执行。密钥只放在请求头里。
  - `question` 和 `datasetIds` 属于对话相关内容（F6），不进任何日志：请求体本来就不被记录，路由日志只有固定文字；`errorHandler` 不记录错误对象；回应不回显请求内容。
  - 回应和日志都不含地址、密钥和上游消息。
- **Code Canonicality**：
  - `retrieveRagflow(settings, request, signal, deadlineMs, send?)` 放在 `client.ts`，内部调用 `listRagflowDatasets`，复用 `call`、`endpoint`、`keyHeaders`、`envelope` 和映射规则，不新建第二个 HTTP 实现。
  - 路由复用 `relay`。为了传出检索参数，可以把 `relay` 交给回调的设置扩成连接设置加四个检索参数，但仍然只调用一次 `readSettings`。
  - 空白判定与 14.3 共用一个函数；媒体类型判定与平台变更守卫共用一个函数（见上）。
- **Legacy compatibility**：
  - 其他三条路由、#411 测试连接和 #413 鉴权钩子的行为不变，只有 `result` 枚举多一个值。
  - 平台变更守卫抽出函数后行为不变，既有测试不改。
  - `schemas/openapi.json` 新增本路由，并给共用的 `result` 枚举加 `no-results`。
- **Documentation / migration notes**（由 orchestrator 改）：AGENTS.md 代理条目改为四条路由都已声明，补上检索的请求体、映射、`no-results`、`excluded`、`positions` 规则和 embedding 模型约束。

not selected：

- Concurrency / shared state：代理没有共享状态；并发拉取列表见上面的残余风险。
- Release / packaging、Migration：无。四个检索参数已由迁移 6 播种。

**不变量**：

- 发给 RAGFlow 的检索请求，`dataset_ids` 总是预检后非空的子集；没有任何路径会用空集合或省略范围去检索。
- 每个返回的片段都属于本次实际检索的集合，库名来自同一次预检。
- 请求体不合规时，不读设置，也不发外部请求。
- 回应只含封闭集合的 `result`；`ok` 和 `no-results` 时再加 `excluded`，`ok` 时再加 `chunks`。

**Must preserve**：

- `version`、`datasets`、`documents` 路由，#411 测试连接，#413 鉴权钩子，平台变更守卫的行为。

**同级面**：

- 15.x 的插件检索工具：这是它唯一的调用方。
- 14.5 本机通道用例：真实种子数据上的检索、改参数即生效、RAGFlow 停机时的 `unavailable`。

**宽度**：client、路由、测试，加上本段 fixture 与 AGENTS.md，会超过 400 行；打 `diff-limit-exempt`。

Evidence (14.4 检索路由，#416):

**改动点**：

- 修改：
  - `ragflow-proxy/client.ts` 与测试：`retrieveRagflow`，`RAGFLOW_RESULTS` 加 `no-results`；
  - `ragflow-proxy/routes.ts` 与测试：检索路由、共用的空白判定；
  - `ragflow-proxy/instance-auth.ts` 与测试：`INSTANCE_ERRORS` 加 413、415；
  - `ragflow-proxy/index.ts`；
  - `auth/request-guard.ts`、`auth/index.ts`：抽出并导出媒体类型判定，守卫行为不变；
  - `schemas/openapi.json`。
- 新建 `platform/test/ragflow-proxy-retrieval.integration.test.ts`，复用 `ragflow-proxy-fixture.ts`、`instance-token-fixture.ts` 和 `model-upstream-fixture.ts`。`ragflow-proxy-fixture.ts` 的 `Proxy.send` 扩展出请求体和 `Content-Type` 选项（`sendHttp` 已经能带请求体）。
- AGENTS.md 由 orchestrator 改。

**测试**：

`client.test.ts`（注入 `send`）：

- 未配置、密钥无法构成请求头时不调用 `send`。
- 预检失败（`timeout`、`unavailable`、`upstream-error`、`not-configured`）直接成为结果，只有 1 次 `send`。
- 成功：
  - 第 2 次 `send` 是 `POST /api/v1/retrieval`，带 `Authorization` 和 `Content-Type: application/json`；
  - 请求体恰为上面列出的键值，`dataset_ids` 是剔除后的子集、按请求顺序；
  - `retrievalRerankId` 为空时请求体里没有 `rerank_id`，非空时原样出现；
  - `retrievalTopK` 为 8 时 `rerank_candidates_count` 为 64，为 100 时为 100；
  - `include_knowledge_compilation` 恰为 `false`；
  - 请求体里没有 `top_k`、`vector_similarity_weight`；
  - 输出恰为 `{ result: 'ok', excluded, chunks }`，`datasetName` 按 `dataset_id` 从预检列表取得，丢弃的字段都不出现。
- 剔除：请求 `{A, B}` 且列表里只有 A → 检索只用 `[A]`，`excluded: [B]`。
- 全部剔除 → `{ result: 'no-results', excluded: [全部] }`，只有 1 次 `send`。
- 零片段 → `{ result: 'no-results', excluded: [] }`。
- 越界：一个片段的 `dataset_id` 被剔除或不在列表中 → `upstream-error`，输出里没有 `chunks`。
- `positions`：`[]`、`null` 和缺失时片段没有该字段；`[[1,10,20,30,40]]` 原样输出；4 元组、含字符串、超过 1024 个元素 → `upstream-error`。
- 以下情况 → `upstream-error`：`chunks` 超过 `retrievalTopK`；`data` 或 `chunks` 不是预期类型；`content` 不是字符串；`document_keyword` 为空或超过 1024 字节；检索回应体超过 8 MiB；`code: 102`；`code: 101`。
- `code: 401` → `not-configured`。
- 检索一步的超时、拒绝连接和外部中止，映射与其他路由一致。

`routes.test.ts`（`app.inject`）：

- 用 `DROP TABLE settings` 证明下列请求都在读设置之前被拒绝：
  - 415：没有 `Content-Type`（有请求体和没有请求体两种）、`text/plain`、`application/vnd.api+json`；
  - 413：请求体超过 64 KiB；
  - `invalid-request`：
    - 无法解析的 JSON、空请求体、`__proto__` 投毒；
    - `null`、数组、字符串；
    - 缺 `question`、缺 `datasetIds`；
    - 多出 `top_k`、`similarity_threshold`、`page_size`、`rerank_id`、`x`；
    - `question` 为空、纯空白、只含 U+0085、超过 4096 字节、不是字符串；
    - `datasetIds` 为 `[]`、超过 1000 项、含重复项、含大写 hex、含 31 位 ID、不是数组、是字符串 `"abc"`。
- 边界接受：`question` 恰为 4096 字节、`datasetIds` 恰为 1000 项、`application/json; charset=utf-8`、`Application/JSON`。断言 `not-configured`，证明请求越过了校验。
- 未配置 → `not-configured`；无令牌 → 401（即使请求体不是 JSON）；存储故障 → 500；`GET`/`HEAD` → 404。

`request-guard` 的既有测试不改，照常通过。

集成测试（真实 TCP、自有假 RAGFlow、有效实例令牌）逐条对应 spec 场景：

- 剔除不存在的库后检索：假服务列表只有库1，请求 {库1, 库2} → 检索请求的 `dataset_ids` 恰为 `[库1]`，回应 `excluded: [库2]`，片段带库1的名字。
- 全部失效时不检索：假服务只收到 1 个请求（列表），回应 `no-results`，`excluded` 为全部 ID。
- 空范围被拒：`datasetIds: []` → `invalid-request`，假服务收到 0 个请求。
- 实例不能自带检索参数：请求体带 `top_k` 或 `similarity_threshold` → `invalid-request`，假服务收到 0 个请求。
- 管理员改参数后下一次检索立即使用新值：经 HTTP `PUT /_platform/api/admin/retrieval-config` 把返回片段数从 8 改为 3、设置重排 ID，紧接着的检索请求体 `page_size` 为 3、带 `rerank_id`；再改为 100，请求体 `page_size` 为 100、`rerank_candidates_count` 为 100；改回空重排 ID 后再检索，请求体没有 `rerank_id`。不重启应用。
- 越界片段导致整体失败：假服务返回一个 `dataset_id` 不在请求集合内的片段 → `upstream-error`，回应文本不含任何片段内容。
- HTTP 200 但 `code: 102` → `upstream-error`。
- 超时与中断可区分：检索一步超时（经 `index.ts` 直接调用 `retrieveRagflow`，传 200 ms）→ `timeout`；拒绝连接 → `unavailable`。
- 无结果不是错误：零片段 → `no-results`。
- 没有页码就不显示页码：`positions: []` 的片段在回应里没有 `positions` 字段。
- 检索要求 JSON：`text/plain` → 415，假服务收到 0 个请求。
- 无令牌无 Origin 的 POST → 401，假服务收到 0 个请求。
- 泄露检查：假服务把 MARKER 放进 `content_ltks`、`similarity`、`important_keywords`、`doc_aggs`、`labels` 和上游 `message`；`question` 放另一个 MARKER。回应文本不含前一组 MARKER、假服务 origin 和密钥。所有日志行都不含任一 MARKER 和密钥。

**运行时证据**（对本机 RAGFlow rc2，用户 2026-11-03 授权最多 5 次只读 `POST /api/v1/retrieval`；脚本自己读私有配置，只打印结果、个数、字段名和耗时，不打印问题和片段内容）：

1. 一个种子库、一个真实问题（实现前已直接对 rc2 发出，用于核对字段）：HTTP 200、`code: 0`，`data` 的键为 `chunks,doc_aggs,labels,total`，1 个片段，字段含 `content`、`document_keyword`（以 `.txt` 结尾）、`dataset_id`（等于请求的库）、`positions`（空数组），耗时 977 ms；三个种子库的 embedding 模型相同。
2. 三个种子库（经实现的 `retrieveRagflow`）：`datasetName` 与 `dataset_id` 对应正确。
3. 一个真实库加一个伪造 ID：`excluded` 有 1 项，检索仍然发出。
4. 只有伪造 ID：`no-results`，`excluded` 为全部，没有检索请求（不产生 embedding 费用）。
5. 请求体带 `top_k`：`invalid-request`，没有外部请求（不产生费用）。

**命令**：

- `pnpm test`、`pnpm test:integration`、`pnpm contract:check`、`pnpm check`
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`
- 本机 exact-head 的 `pnpm test:stack` 证据评论

**交接**：

- 15.x 插件检索工具：
  - 请求体 `{ question, datasetIds }`，`question` 不超过 4096 字节；
  - 片段字段 `content`、`documentName`、`datasetName`，`positions` 可能没有；只有 PDF（按文件扩展名判断）才把 `positions[i][0]` 当页码显示，表格的五元组不是页码；
  - `excluded` 非空时提示这些库已不存在；`no-results` 和每个失败取值各有一条中文提示；
  - 最坏等待约 20 秒（两次各 10 秒）。
- 14.5：真实种子数据检索、改参数即生效、停机 `unavailable`。
- 第 19 组部署文档：「所有知识库必须使用同一个 embedding 模型，否则检索失败（`upstream-error`）」。另写明 rc2 会在自己的服务日志里以 Info 级别记录员工的检索问题（`internal/service/dataset/search.go:37`），这在平台 F6 边界之外，由运营方管理 RAGFlow 日志。

Risk packs (14.5 本机通道 RAGFlow 代理用例，#417): fixture level expanded（与 issue 建议一致：第一次从真实员工实例经网桥调用代理，并且用例要停启一个不属于本项目的测试栈容器）。selected：

- **Auth / permissions / secrets**：
  - 用例不新增或改变任何路由，只调用 #413–#416 已交付的四个接口和既有的后台接口：`GET/PUT /_platform/api/admin/ragflow-config`、`POST /_platform/api/admin/ragflow-config/test`、`PUT /_platform/api/admin/retrieval-config`。
  - 实例侧请求由 `docker exec --user 1001 dsh-team-u-<id> node …` 在员工容器里发出，令牌取自容器环境里平台注入的 `DSH_TEAM_INSTANCE_TOKEN`。来源地址因此是实例的 +2，这正是生产路径：插件在容器内调用平台。
    - 平台地址是平台容器在该实例网桥上的端点地址（+3），端口是容器内的 `PLATFORM_PORT`。两者都从 `docker inspect` 读取，不靠推算。
    - 失败路径也不能泄露。`docker-cleanup.ts` 的 `output()` 会在退出码非零时把完整参数、stdout 和 stderr 写进抛出的错误，所以：
      - 实例脚本在任何路径上都只写固定字符串、每次调用的 HTTP 状态、封闭集合的 `result`、个数、32 位 hex 库 ID（不是秘密；后续调用和 `excluded` 断言要用），以及种子库名和种子文件名，失败时也一样；不打印回应体、异常消息、令牌和片段内容；
      - 脚本本身以退出码 0 结束，调用失败也照常输出状态，由测试进程判定；
      - 脚本以 `node --input-type=module -e <脚本>` 送进容器，参数里只有脚本文本、平台地址和端口。令牌只在容器内从 `process.env.DSH_TEAM_INSTANCE_TOKEN` 读取，从不出现在参数里。检索问题是固定的测试常量（「报销需要提交哪些材料」），不是员工输入，可以出现在脚本文本里。既有的 `createDockerCommands` 异步路径没有 stdin 输入通道，本 issue 不新增；
      - 记录每次调用的 HTTP 状态：令牌或来源校验失败时报告为 401，而不是被当作解析失败。
  - not selected：真实网桥上的错误令牌和错误来源地址。#413 的集成测试已经覆盖这两种情况；为了构造它们，要么把令牌带出容器，要么从别处发起调用，这本身就是暴露。
  - RAGFlow 地址：平台容器经 `host.docker.internal:<端口>` 访问只在主机 loopback 上发布的 RAGFlow API。端口取自私有配置里的 `ragflowUrl`，把主机部分 `127.0.0.1` 或 `[::1]` 换成 `host.docker.internal`。
    - Docker Desktop 实测（2026-11-03）：一次性容器 `fetch('http://host.docker.internal:19380/api/v1/system/version')` 得到 HTTP 200、`code: 0`、`v1.0.0-rc2`。
    - 密钥只在测试进程发给平台的 `PUT` 请求体里，不写入日志、证据和报告。
- **Lifecycle / external state**（停启 RAGFlow，用户 2026-11-03 特批）：
  - 「RAGFlow 停机」用真实停机验证，不用改地址模拟：用例对本机测试栈的 `ragflow-rc2-ragflow-cpu-1` 执行 `docker stop`，之后再 `docker start`。只做这两种操作，不删除、不重建、不改配置，也不碰该栈的其他 5 个服务。
  - 停机之前先核对身份：按名字 inspect，标签 `com.docker.compose.project=ragflow-rc2`、`com.docker.compose.service=ragflow-cpu`，状态 `running`。记下容器 ID；之后的停、启、复核都按这个 ID 进行。身份不符时用例失败，不停任何容器。
  - 停机前向 stderr 写一行，格式与 `test-stack.mjs` 的 run directory 提示相同，说明被停的容器和人工恢复命令 `docker start ragflow-rc2-ragflow-cpu-1`。
  - 恢复放在 `finally` 里：只要 `docker stop <ID>` 已经提交（沿用 `composeScenario` 的 `submitted` 写法；CLI 超时的 stop 也可能已经停掉容器），就一定执行 `docker start <ID>`，然后等待（上限 300 秒）版本接口返回 `v1.0.0-rc2`，且 `readSeedDatasets` 的快照与运行前相同。恢复失败时，这个失败附在原始错误后面一起抛出，信息里说明人工恢复的命令。
  - 结束时由用例断言：
    - 6 个 `ragflow-rc2-*` 容器的 ID 都不变；
    - 其他 5 个容器的 `StartedAt` 不变；
    - `ragflow-cpu` 是 `running`；它的 `StartedAt` 和 `RestartCount` 允许改变：第一次实跑（2026-11-04）观察到 `docker start` 把 `RestartCount` 从 5 清零；
    - 其他 5 个容器的 `RestartCount` 也不变；
    - 数据卷清单不变。
  - 以下情况都不会执行 `finally`，容器会停留在停止状态：
    - 进程被强杀；
    - `test-stack.mjs` 把 SIGINT/SIGTERM 转发给整个进程组（`:250-271`），vitest 的 fork worker 被直接杀死；
    - vitest 超时（`vitest.config.ts:50`）。
    - 下一次运行的前提检查会以通用的「RAGFlow test stack unreachable」失败。上面那行 stderr 提示和 `docs/LOCAL_STACK.md` 第 5 节的人工恢复命令就是为这种情况准备的。
  - 整个过程都在既有的部署锁 `acquireDeploymentLock` 之内。
- **Error handling / partial outputs**（spec「RAGFlow 不可用不影响平台其他功能」「RAGFlow 停机时仍能进入工作台」）：
  - 顺序：
    1. 拉起平台。
    2. 管理员保存模型设置（既有）和 RAGFlow 地址与密钥，测试连接得到 `{ result: 'ok', version: 'v1.0.0-rc2' }`。这也是 `host.docker.internal` 路径的正向对照。
    3. 停掉 `ragflow-cpu`。停机放在 `prepareDeploymentAccounts` 之后、`gateway.state` 之前。
    4. 员工登录、启动实例、经工作台完成一轮对话（既有流程）。这证明登录、实例启动和网关在 RAGFlow 停机时照常工作。
    5. 停机期间的后台页面（spec「后台其他页面照常工作」）：管理员 `GET /_platform/api/admin/ragflow-config` 返回 200 和 `{ baseURL, apiKeyConfigured: true }`；`POST /_platform/api/admin/ragflow-config/test` 返回 `{ result: 'unavailable' }`。
    6. 从实例内调用四个接口：`version`、`datasets`、`datasets/<ID>/documents?page=1&page_size=10` 和检索，都必须是 HTTP 200 加 `unavailable`。这一步不需要真实的库 ID：文件列表和检索都在发往 RAGFlow 时失败，所以任何合格的 32 位 hex ID（例如 32 个 `0`）都可以。
    7. 启动 `ragflow-cpu` 并等待就绪。
    8. 再从实例内调用四个接口，结果见下。这是代理第一次对真实的 rc2 发请求：此时出现 `upstream-error`，说明 client 的回应映射有缺陷，而不是测试栈的问题。用例失败并停下报告，不放宽断言。
  - Docker Desktop 在容器停止后会撤掉发布端口，所以连接被拒绝，结果是 `unavailable`。如果实测得到的是 `timeout`，用例失败并停下报告，不放宽断言。
- **恢复后的四个接口**（spec「实例可以调用四个只读接口」）：
  - `version` → `{ result: 'ok', version: 'v1.0.0-rc2' }`。
  - `datasets` → `ok`，列表包含三个种子库，按名字匹配。之后的文件列表和检索用这里得到的 ID。
  - `documents`：
    - 每个种子库 `page=1&page_size=10` → `ok`，`total` 为 2，文件名集合等于该库的种子文件；
    - `dsh-team-seed-policies` 加 `keywords=expense` → `total` 为 1，文件名为 `expense-policy.txt`。
  - 检索（付费，用户 2026-11-03 接受）：
    1. 三个种子库，问题「报销需要提交哪些材料」→ `ok`，`excluded: []`，至少 1 个片段；每个片段的 `datasetName` 都是种子库名，`documentName` 都是该库的种子文件名。
    2. 三个种子库加一个伪造 ID（32 个 `0`）→ `ok`，`excluded` 恰为伪造 ID，片段都属于种子库。第一次实跑（2026-11-04）中，只用 `dsh-team-seed-policies` 加伪造 ID 时同一问题得到 `no-results`，所以改用与检索 1 相同的范围。
    3. 保存即生效：管理员 `PUT retrieval-config`，把 `retrievalSimilarityThreshold` 改为 `1`，其余保持默认，然后重复检索 1 → `no-results`。不重启实例，也不重启平台。
    - 不再做其他检索：全部剔除的情况不发检索请求，由 #416 的集成测试覆盖。
- **Resource limits**：
  - 实例侧每次 `docker exec` 设 30 秒上限。
  - RAGFlow 恢复的等待上限 300 秒，按 1 秒间隔轮询版本接口，再读一次种子快照；不用固定的 sleep。
  - 用例的总时长上限随之增加（`vitest` 的 stack 项目超时如有需要就调整，并在 PR 中说明）。
- **Documentation / migration notes**（由 orchestrator 改）：
  - `docs/LOCAL_STACK.md`：
    - 第 1 节说明用例会停启 `ragflow-cpu`；
    - 第 5 节写人工恢复命令 `docker start ragflow-rc2-ragflow-cpu-1`；
    - 第 6 节「RAGFlow 测试栈」一行改为：「6 个容器的 ID、状态和数据卷清单一致；只有 `ragflow-cpu` 的 `StartedAt` 和重启次数因用例自己的停启而改变」，并要求证据评论附上 `stackEvidence.proxy` 行。
  - `AGENTS.md`：
    - Agent Operating Rules 的 RAGFlow 例外补一句：用户 2026-11-03 授权本机通道用例停启自己验证过身份的 `ragflow-rc2-ragflow-cpu-1`，此外不做任何改动；
    - 验证矩阵的 Local full stack 一行补上四个接口、停机 `unavailable` 和保存即生效。

not selected：

- Concurrency / shared state：部署锁已经串行化本机通道。
- Migration / release：无。

**不变量**：

- 用例结束时，本机 RAGFlow 测试栈恢复运行，种子快照与运行前相同。只有 `ragflow-cpu` 的 `StartedAt` 和 `RestartCount` 可以改变。
- 停机期间平台的登录、实例启动、网关和对话照常工作；代理只回 `unavailable`，不是 500，也不挂起。
- 用例输出与日志中没有 RAGFlow 密钥、实例令牌和片段内容。检索问题是固定的测试常量，不受此限。

**Must preserve**：

- 既有的 stack 用例断言：镜像构建、健康检查、对话、文件写入、截图、零控制台错误、零外部请求、种子快照不变。
- 部署锁和精确归属的清理顺序。

**同级面**：

- 15.x 插件将用同一条容器内路径（+2 到 +3:端口，令牌来自环境变量）调用代理。

**宽度**：stack 用例、可能新增的 `platform/test/ragflow-stack-fixture.ts`，加上本段 fixture 和文档，可能超过 400 行；超过时打 `diff-limit-exempt`。

Evidence (14.5 本机通道 RAGFlow 代理用例，#417):

**改动点**：

- 修改 `platform/test/platform-stack.stack.test.ts`。
- 实例侧调用、RAGFlow 停启与就绪等待可以抽到新的 `platform/test/ragflow-stack-fixture.ts`。它是测试辅助模块，计入 jscpd。
  - 其中不依赖 Docker 的纯函数，例如把 `ragflowUrl` 换成 `host.docker.internal`、解析实例脚本的输出，配套 `platform/test/ragflow-stack-fixture.integration.test.ts`，在 `pnpm test:integration` 里运行。
- `docs/LOCAL_STACK.md`、`AGENTS.md` 由 orchestrator 改。

**测试**：

- `pnpm test:stack`：上面列出的顺序与断言全部通过。`stackEvidence` 增加 `proxy` 字段，只含结果和个数，例如：

  ```
  { downResults: { version, datasets, documents, retrieval }, adminDown: { configStatus, testResult },
    version, seedDatasets, documentsTotals, keywordsTotal,
    retrieval: { result, chunks }, excluded, thresholdResult, ragflowRestartMs }
  ```

- 辅助模块的集成测试覆盖：
  - 地址替换：`127.0.0.1` 和 `[::1]` 都换成 `host.docker.internal`，端口保留；
  - 实例脚本输出的解析：输出不合格时失败，而不是当作结果。
- 先红后绿：新增断言要在实现之前失败（例如 `stackEvidence.proxy` 缺失，或者对代理的调用失败）。

**命令**：

- `pnpm test:integration`（辅助模块）、`pnpm check`
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`

**交接**：

- 15.x 插件：容器内调用代理的地址、端口与令牌来源，同本用例。
- 第 19 组：集成验收复用本用例的停机步骤。

## 15. 「知识库」插件

依赖：4、10（含 10.2 种子和 10.4 本机浏览器）、11、14。关键路径 `images/dsh-user/`（15.1 镜像交付）。

- [ ] 15.1 新建 `plugins/knowledge-base/`，包含 host 和 client 两半、`engines.dsh` 和成对单元测试。插件以 root 所有、只读的方式随用户镜像交付，并作为可管理项加入 `catalog.json`；三处探测构建和文档中的构建示例都加入 BuildKit 命名上下文。覆盖层在网络方式下给插件平台地址（+3 加平台端口），published-loopback 下不给；插件启用状态只服从目录三态。验证：用户镜像 Docker 用例断言插件只读、已加载，环境、覆盖层和插件目录中都没有 RAGFlow 密钥；生成器单元测试覆盖三种目录状态和两种上游方式。
- [ ] 15.2 左侧栏「知识库」面板：库列表、展开文件、搜索、筛选、分页、刷新，以及加载中、空库、无匹配、失败可重试、知识库未配置五种状态。浏览器请求经插件自己的路由转发到代理。验证：插件单元测试覆盖状态机和取值到状态的映射；本机通道 Playwright 用例在真实种子数据上通过，并有截图，包括未配置 RAGFlow 时的「知识库未配置」。
- [ ] 15.3 输入区范围控件：多选、全选、取消全选；选择记在 Session 日志中（经插件命令的 `command/run`/`command/done`，见下方 #420 fixture），新 Session 默认全选；提交时快照本轮范围（在 `turn/start` 折叠）。验证：单元测试覆盖快照语义；本机通道 Playwright 用例用确定性 provider 驱动任务，覆盖刷新和重开后恢复、两个 Session 互相独立、提交后修改不影响进行中的任务。
- [ ] 15.4 检索工具：沿父 Session 回溯到根 Session，取本轮快照；范围为空时不发请求；展示来源；对被剔除的库、`no-results` 和每个失败取值分别给出互不相同的中文提示。验证：单元测试覆盖回溯和六种取值的提示；本机通道用例由确定性 provider 驱动综合办公委派给子 Agent 并调用检索，断言范围不变，以及删除一个库后出现提示。

Suggested fixture level: expanded - 新插件，涉及 Session 状态、子 Agent 继承和外部数据展示
Minimal mergeable slice: 15.1 插件骨架和镜像交付单独合入（没有界面和工具，不影响现有行为）

Risk packs (15.1 插件骨架与镜像交付，#418): fixture level expanded（与 issue 建议一致：新插件第一次经 profile 清单登记的 bundle 层进入员工默认组成，且触及关键路径 `images/dsh-user/`）。本 issue 只交付插件骨架、镜像交付和目录登记；覆盖层给平台地址的部分是 #447，面板、范围控件和检索工具是 15.2–15.4。selected：

- **Public API / Schema**（插件包形状，编排者裁定）：
  - `plugins/knowledge-base/package.json`：`name` 为 `@dsh-team/knowledge-base`，`version` `0.1.0`，`private`，`type: module`，`main: index.js`；`exports` 恰为 `.`、`./client`、`./package.json`；`engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0`，没有 `@deepseek-ai/dsh` peer；`dsh.bundle.patch` 为 `./cordis.patch.yml`；`dsh.client` 与 `platform-nav` 相同：`{ platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] }`（15.2 的面板挂在左侧栏，沿用已在 VPS 上证明可交付的形状）；`files` 列出四个交付文件和 README。
  - `cordis.patch.yml`：恰好一行插入，`- insert: [{ id: knowledge-base, name: /opt/dsh-team/knowledge-base/index.js }]`，没有覆盖行、没有 `config`。
    - 必须非空：目录项是可管理项，#447 起 `forced-on`/`forced-off` 经 `forcedBundle` 读取规范 patch，空 patch 让生成器抛 `TypeError`（`platform/src/managed-config/generate.ts:125`）。
    - 不能有覆盖行：`forced-off` 只会还原 `agent-preset-registry`，其他目标的覆盖行让生成器拒绝。
    - 行 id 钉死为 `knowledge-base`：#447 的平台地址行和 15.2–15.4 都以它为目标。
    - `name` 用 `/opt` 绝对路径而不是包名：`forced-on` 在 profile 里没有登记副本时（阶段 2 之前建的 home 卷不重新灌种子；员工用原生卸载入口删掉副本）整段写出规范 patch，包名在这些 profile 里解析不到，绝对路径总能解析到 root 只读的规范副本，并像覆盖层的 `platform-nav` 行一样经相邻清单交付 client 半区。这是 profile bundle 层第一次用绝对路径行，但代码路径与覆盖层相同：领先于发布版的 `resource/deepseek-harness/packages/boot/app-boot/src/profile.ts:754-755` 让 bundle 层的 patch 与覆盖层一样经 `loadOverlayPatches` → `parsePatchList`（`src/index.ts:388`）→ `anchorInsertedPluginNames`（`:347-356`，把绝对路径转成 file URL），而覆盖层的 `/opt/dsh-team/platform-nav/index.js` 行已在 VPS 上证明经相邻清单交付 client 半区（启动模块清单含 `@dsh-team/platform-nav`）。`resource/` 不代替 0.2.1-rc.2 的实测（开发注记 1），所以仍由下面的「已加载」断言在真实镜像上证明；组成读取器（`read.ts`）只按 id 判断在场，`forcedBundle`（`generate.ts:118-128`）对只有插入行的非空 patch 两种强制态都能处理。VPS 实测如果证明 bundle 层的绝对路径行不加载，停下报告、回到 fixture，不静默改成包名。
  - `catalog.json` 新增一项 `{ id: 'knowledge-base', package: '@dsh-team/knowledge-base', name: '知识库', category: 'manageable', imageDefaultEnabled: true }`，按现有的 id 字母序放在第一项。
    - `imageDefaultEnabled: true`：设计决定 12 的分类是「只由覆盖层激活的插件为 `false`，由 profile 清单登记的 bundle 为 `true`」；知识库由 profile 清单的 bundle 层激活，覆盖层「不另行启用」（managed-config「知识库插件取得平台地址」）。后果：`catalog-check.mjs register` 把它追加进 `dsh.profile.bundles`（目录顺序，在 `@dsh-team/office-agents` 之前），员工插件页的卡片状态为 `running`，`employee` 态下新实例加载插件。
- **Config**（host 半区的配置契约，#447 照此写行）：
  - `index.js` 导出 `name = 'dsh-team-knowledge-base'` 和 `apply(ctx, config)`。
  - 「没有平台地址」是设计内的状态，不是错误：`config` 为 `undefined`、`null` 或没有自有键的普通对象时，`apply` 什么都不做、不抛错。15.1 里永远是这一态（#447 未合入）；#447 之后 published-loopback、以及员工取消勾选时覆盖行的目标不存在（告警跳过），也是这一态。
  - 有平台地址时 `config` 恰为 `{ platformUrl }`：字符串 `http://<规范点分 IPv4>:<端口>`，最后一个八位组模 16 等于 3（实例 bridge 的 +3，与生成器对 +2 的检查同一写法），端口是 1..65535 且没有前导零的十进制，没有路径（结尾的 `/` 也不接受）、查询、片段或用户信息。
  - 其他任何形状（多余的键、非字符串、地址不合格、非普通对象）让 `apply` 抛 `TypeError`，消息固定、不回显输入。这与 `platform-nav` 对被篡改行的处理相同：整个插件加载失败，由既有的插件失败标记检查发现。
  - 15.1 的 host 半区只做这一项校验，校验结果没有消费者；读取 `DSH_TEAM_INSTANCE_TOKEN`、注册插件路由属于 15.2，本 issue 不读环境变量。
- **Client 半区**：
  - `client.js` 是 classic script，`window.__ModuleLoader__.load({ id: '@dsh-team/knowledge-base', factory })`，factory 返回的注册不注入任何服务、不注册任何 slot、不发网络请求、不写控制台。
  - 它在 15.1 存在，是为了在这个关键路径镜像 PR 里证明 client 半区经 bundle 层交付到浏览器；面板和范围控件由 15.2、15.3 加入。这是组 15 声明的分步交付（「没有界面和工具，不影响现有行为」），不是假实现。
- **Auth / permissions / secrets**（spec「插件随镜像交付且不接触 RAGFlow 凭据」「实例内找不到 RAGFlow 密钥」）：
  - 插件的代码、清单、patch 中没有 RAGFlow 地址、密钥或检索参数的任何键名或取值。
  - 正向断言，不能空过：Docker 用例在启动实例前用 `writeSettings` 写入、再用 `readSettings` 回读确认已存入，向测试自己的 SQLite 写入不是秘密的哨兵值 `ragflowBaseUrl`（例如 `http://ragflow-sentinel.invalid:9380`）和 `ragflowApiKey`（例如 `ragflow-sentinel-not-a-key`），实例就绪后断言这两个哨兵都不出现在：
    - `docker inspect` 的 `Config.Env`；
    - 该实例生成的覆盖层文件字节；
    - `/opt/dsh-team/knowledge-base/` 下全部文件字节，以及 profile 中的登记副本。
  - 每个被扫描对象先证明读到的是真内容，否则「不包含」会因为读错路径而空过：`Config.Env` 含 `DSH_TEAM_MODEL_API_KEY=` 条目；覆盖层字节含 `webserver` 行；`/opt/dsh-team/knowledge-base` 恰为四个文件且非空；profile 登记副本与规范副本逐字节相等。
  - 这组断言不声称先红：交付前后都没有东西会泄漏哨兵。它的强度来自上面的正向标记和回读。
  - 哨兵值是测试常量，可以出现在测试代码和失败信息里；真实密钥从不参与本 issue 的任何用例。
  - spec 的第四处（浏览器页面资源）推迟到 15.2：15.1 的 client 半区没有内容，页面资源里没有可检查的插件数据。15.2 的本机通道用例负责这一处。
- **Release / packaging**（关键路径 `images/dsh-user/`；`images/seccomp/README.md` 的构建示例也是关键路径文件）：
  - Dockerfile 在 `platform-nav` 的 COPY 之后加 `COPY --from=knowledge-base --chown=root:root --chmod=0444 package.json index.js client.js cordis.patch.yml /opt/dsh-team/knowledge-base/`，并把 `/opt/dsh-team/knowledge-base` 加进 `chmod 0555` 那一行。`register`/`verify` 由目录驱动，不改。
  - BuildKit 命名上下文 `knowledge-base=<repo>/plugins/knowledge-base` 加到每个构建入口：`scripts/probe-sandbox.sh`、`scripts/probe-dsh-api.sh`、`scripts/probe-first-run.sh`、`platform/test/user-image-fixture.ts` 的 `PLUGIN_CONTEXTS`、`platform/test/user-image-rejection.integration.test.ts`（上下文名单与断言）。
  - 文档里的构建示例（由 orchestrator 改）：`docs/DEPLOY.md`、`images/seccomp/README.md`、四个插件 README 的构建示例（「four narrow plugin named contexts」改为五个）、`AGENTS.md` 的 Docker suite 段落（命名上下文清单与「Every delivered plugin manifest」清单）。新插件的 `plugins/knowledge-base/README.md` 由 implementer 写，说明 15.1 的范围、配置契约、交付方式和验证。
- **Legacy compatibility**：
  - 新建的 home 卷从镜像种子得到登记副本和 bundle 成员资格；已有 home 卷不重新灌种子，`employee` 态下这些员工在管理员重置 profile 之前没有知识库（与办公 Agent bundle 的既有行为相同）。#447 之后 `forced-on` 经绝对路径行也能在这些卷上加载。这一点写进插件 README 和 PR 的 Risk。
  - `employee` 态的目录项不进入组成读取（`platform/src/orchestrator/start.ts:66-72`），编排器和生成器的现有测试不受新目录项影响；`platform/src/orchestrator/` 不改。
- **Error handling**：`apply` 对「没有平台地址」不抛错（否则每个新实例都出现插件失败标记）；对畸形配置抛固定消息的 `TypeError`。client 不抛错。

not selected：

- Concurrency / shared state：插件不持有状态。
- Migration：没有数据库迁移；settings 不变（目录状态仍由 #405 的 `pluginCatalog` 保存，新目录项默认 `employee`）。
- Resource limits：无新的网络或文件操作。

**不变量**：

- 现有四个目录项的交付、登记、三态和锁定显示不变；`required` 项仍恒为 `forced-on`。
- 员工默认组成里新增且只新增 `@dsh-team/knowledge-base` 一个启动模块；其他模块和插件失败标记检查不变，直接打开 DSH 的验证通道仍无控制台错误。
- 插件目录、覆盖层和实例环境中没有 RAGFlow 地址、密钥或检索参数。

**Must preserve**：

- `catalog-check.mjs` 的一致性、兼容性和登记校验（目录与镜像内容两个方向一致、`engines.dsh` 满足、登记副本逐字节相同、默认状态一致）在新目录项上照常生效，不放宽。
- 不兼容范围的拒绝构建用例（`platform-nav` 副本 `>=0.3.0`）仍然失败并点名该插件。
- 管理员插件目录页与接口：PUT 必须覆盖目录中每个 id 恰好一次，所以写死目录的测试随之更新，规则本身不变。

**同级面**：

- #447：覆盖层按本 fixture 钉死的 `{ id: 'knowledge-base', config: { platformUrl } }` 写平台地址；`forced-on`/`forced-off` 读本 patch 的插入行 `knowledge-base`。`forced-on` 且 bundle 缺席时，这条覆盖行必须排在整段规范 patch 的插入行之后，否则目标尚不存在，只会告警跳过（设计决定 12 的「目标 id 不存在时告警跳过」）。
- 15.2：host 半区在同一个 `apply` 里读取令牌、注册路由；client 半区加面板。

**宽度**：插件十个文件、Dockerfile、目录、三个门禁配置、五个构建入口、Docker 与目录相关测试、文档，预计超过 400 行，开 PR 时打 `diff-limit-exempt`。PR 描述写明触及关键路径 `images/dsh-user/` 和 `images/seccomp/`（README），人工逐行审查推迟到 Epic #380 完成，未通过。

Evidence (15.1 插件骨架与镜像交付，#418):

**改动点**：

- 新建 `plugins/knowledge-base/`：`package.json`、`cordis.patch.yml`、`index.js`、`index.test.js`、`client.js`、`client.test.js`、`types.d.ts`、`client.types.d.ts`、`tsconfig.json`（与 `platform-nav` 相同）、`README.md`。
- `images/dsh-user/Dockerfile`、`images/dsh-user/catalog.json`。
- 门禁配置照 `platform-nav` 扩展：`knip.json`（entry 加 `index.js` 与 `*.test.js`，project 加 `*.js` 与 `*.d.ts`）、`vitest.config.ts` 覆盖率清单、`scripts/check-test-pairing.sh` 的 find 路径（新插件的每个 `.js` 都要成对测试，不像 `zh-locale` 那样豁免）、根 `package.json` 的 `typecheck` 加 `tsc -p plugins/knowledge-base/tsconfig.json`。ESLint 与 vitest 的 include 已经按通配覆盖，核对即可。`scripts/test-guardrails.sh` 照 `plugins/office-agents/orphan.js` 的写法加 `plugins/knowledge-base/orphan.js` 拒绝用例，证明新的 find 子句生效。
- 构建入口：上面 Release 一节列出的五处。
- 阶段 1 卷升级用例：`platform/test/volume-upgrade.docker.test.ts:70-79,90` 用 `PLUGIN_CONTEXTS` 从阶段 1 提交 `3482a520…` 做 `git archive` 并为旧镜像生成 `--build-context`；该提交没有 `plugins/knowledge-base`（`git archive` 退出 128）。在 `user-image-fixture.ts` 钉死一份阶段 1 的四项上下文集（`office-agents`、`permission-tiers`、`platform-nav`、`zh-locale`），阶段 1 的提取与旧镜像构建只用它；当前镜像构建用五项。验证仍是 exact-head 全量 `pnpm test:docker` 中该用例通过。
- 写死目录或启动模块清单的测试随新目录项更新（implementer 用 grep `office-agents` 与 `MANAGED_BOOT_ROSTER` 核对全集）：`platform/test/managed-boot-roster.ts`（加 `@dsh-team/knowledge-base`）、`platform/test/admin-plugin-catalog.integration.test.ts`、`platform/test/admin-plugins.ui.test.ts`、`platform/src/plugin-catalog/catalog.test.ts`、`platform/src/admin/plugin-catalog.test.ts`、`images/dsh-user/catalog-check.test.mjs`（`:590-592` 的排序断言与新项放第一位一致）、`platform/test/probe-plugin-page.integration.test.ts`、`platform/test/user-image.docker.test.ts`、`platform/test/first-use.docker.test.ts` 和 managed-policy 的 oracle/fixture 中与员工默认组成相关的期望。只改受新目录项影响的期望，不改断言强度。`platform/src/managed-config/generate-catalog.test.ts` 与 `platform/web/src/plugins-page.test.tsx` 经核对不受影响（前者的目录项都是 `employee` 态，后者用自造目录），不改。`platform/test/model-refusal-fixture.ts:372` 是启动模块清单的第四个消费方，共享常量自动覆盖它；`pnpm test:model` 不在本 issue 的命令里，这是已知验证缺口。
- 不改 `platform/src/orchestrator/`、`platform/src/managed-config/`。

**测试**：

- 单元（`pnpm test`）：
  - `index.test.js`：`undefined`、`null`、`{}` 不抛错且不注册任何东西；合格的 `{ platformUrl }` 被接受（含端口边界 1 与 65535、最后八位组 3 与 19 等 +3 地址）；以下每种都抛 `TypeError` 且消息不含输入：多余的键、非字符串、`https:`、非规范 IPv4（前导零、越界八位组）、非 +3 地址、端口 0/65536/前导零、带路径或结尾 `/`、查询、片段、用户信息、数组和非普通对象。
  - `client.test.js`（jsdom）：恰好一次 `__ModuleLoader__.load`，id 为 `@dsh-team/knowledge-base`；`apply` 不注册 slot、不调用 `fetch`、不写控制台。
  - 目录相关的既有单元测试在五项目录上通过。
- 集成（`pnpm test:integration`）：管理员插件目录接口在五项目录上通过；拒绝构建用例的上下文名单含 `knowledge-base`。
- Docker（`pnpm test:docker`，VPS exact-head）：
  - 只读（`user-image.docker.test.ts`，把 `platform-nav` 的只读用例扩展为同时覆盖两个目录，不复制一份）：`/opt/dsh-team/knowledge-base/` 恰有四个文件，目录 root 0555、文件 root 0444，uid1001 写入、新建、改名都被拒绝；清单名、`engines.dsh` 满足、没有 DSH peer、`./client` 导出与 `dsh.client.platform`。
  - 目录交付用例：`dsh.profile.bundles` 为 `[...shipped, '@dsh-team/knowledge-base', '@dsh-team/office-agents']`；`dependencies` 与登记副本由目录驱动，自动覆盖新项。
  - 已加载：以 managed-policy 用例为准：它用真实目录、全部 `employee` 态（`managed-policy-fixture.ts:84`），同时精确比较启动模块清单（新清单含 `@dsh-team/knowledge-base`，证明 client 半区交付）和 `rejectPluginFailures`（host 半区 `apply` 没有加载失败，这只能从失败标记看出；「未停用、已激活」由下面的 observer 断言证明）；并用 managed-policy observer 正向断言 `ctx.loader.entries()` 中有 id `knowledge-base`、未停用且已激活的条目。`first-use` 与 `admin-config-activation` 的精确清单比较随共享常量更新；首次使用的插件页用例中知识库卡片为 `running`、开关可见（`employee` 项不锁定）。
  - 无 RAGFlow 密钥：`first-use` 用例写入上面的哨兵后，断言实例环境、覆盖层字节、`/opt/dsh-team/knowledge-base/` 与 profile 登记副本中都没有哨兵。
- 先红后绿：新的只读、名单、启动模块和 loader 条目断言要在插件交付之前失败（例如目录项存在但镜像没有 COPY 时构建门禁失败，或启动模块清单缺少新项）；哨兵断言例外，见上。

**命令**：

- `pnpm test`、`pnpm test:integration`、`pnpm check`
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`（清理已确认）
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论（新插件进入员工默认组成，零控制台错误照常要求）

**交接**：

- #447：覆盖层的 `knowledge-base` 行形状与 `platformUrl` 规则见上；生成器单元测试覆盖三种目录状态和两种上游方式。
- 15.2：host 半区读取令牌并注册路由，client 半区加面板；浏览器页面资源中没有 RAGFlow 密钥的断言在 15.2 的本机通道用例里做。

Risk packs (15.1 覆盖层下发平台地址，#447): fixture level expanded（与 issue 建议一致：覆盖层第一次给插件一个平台内部地址，且需要改关键路径 `platform/src/orchestrator/` 的两处输入传递）。本 issue 只交付覆盖层输出；插件骨架与配置校验已由 #418 合入（`plugins/knowledge-base/index.js`），面板、范围控件和检索工具是 15.2–15.4。selected：

- **Public API / Schema**（生成器输入与输出，编排者裁定）：
  - `ManagedConfigInput` 新增必填键 `platformPort: number | null`：
    - `null` 表示该实例没有平台地址（published-loopback）；
    - 数字必须是 1..65535 的整数，否则 `TypeError`（固定消息，不回显输入），与其他必填输入的处理相同。
    - 不再另传平台地址：地址由已有输入 `instanceAddress`（+2，已校验末八位组模 16 等于 2）把末八位组加 1 得到 +3，与 `instanceAddressLayout(...).platform`（`platform/src/orchestrator/subnet.ts:96`）一致，生成器只有这一个地址来源。选择在生成器里推出 +3 而不是由 `start.ts` 传 `layout.platform`：`managed-config` 不能 import orchestrator，生成器本来就自带 +2 的规则（`isInstanceAddress`），两种做法改 orchestrator 的行数相同，而这种做法不会出现地址与 `instanceAddress` 不在同一 /28 的输入。
  - `platformPort` 为数字时，覆盖层恰好多一行 `{ id: 'knowledge-base', config: { platformUrl: 'http://<+3>:<platformPort>' } }`；为 `null` 时没有任何 `knowledge-base` 配置行。
    - 位置：紧跟目录行 `...catalog.rows` 之后、`plugin-manager` 行之前。`forced-on` 且 bundle 缺席时，目录行里整段写出的规范 patch 已插入 `knowledge-base`，这条覆盖行在它之后，目标存在（#418 交接）。
    - 与目录状态无关：`employee`、`forced-on`、`forced-off` 三种状态下这一行逐字节相同（spec「三种情况下平台地址配置相同」）。启用状态仍只由 11.4 的目录行决定：`employee` 不写，`forced-on` 写 `{ id: 'knowledge-base', disabled: false }`（在场时）或整段 patch（缺席时），`forced-off` 写 `{ id: 'knowledge-base', disabled: true }`。本 issue 不改这部分逻辑。
    - 行 id 是固定常量 `knowledge-base`，不随目录内容变化；目录里没有该项时（只有自造目录的测试会出现），覆盖行的目标不存在，DSH 只告警跳过，与 `forced-off` 对缺席目标的既有处理同类。
  - `config` 是整块替换：bundle 层的插入行没有 `config`（#418），所以这一行就是插件的全部配置，恰为 #418 host 半区接受的形状。
- **Config**（编排器输入，关键路径）：
  - `platform/src/orchestrator/start-identity.ts` 的 `StartUserContainerInput.config` 的 `Pick` 加入 `'port'`；`instance-service.ts` 传的是完整 `PlatformConfig`，不用改。
  - `platform/src/orchestrator/start.ts` 调用生成器时传 `platformPort: input.transport.config.upstreamMode === 'network' ? config.port : null`。
    - 端口是平台进程自己的 `PLATFORM_PORT`：网络方式下平台在实例 bridge 上的端点是 +3，监听的就是这个端口（#417 从容器内经 +3:`PLATFORM_PORT` 调用代理已实测）。
    - published-loopback 下平台不接入实例网络，不给地址（设计决定 2、managed-config「回环方式不给平台地址」）。
  - 偏离 issue 的 PR 边界（「只改 `platform/src/managed-config/`」）：生成器自己不知道上游方式和平台端口，只能由调用方传入，所以必须改上面两处共两行左右；`orchestrator/` 的其他行为不变。PR 描述写明触及关键路径 `platform/src/orchestrator/`，人工逐行审查推迟到 Epic #380 完成，未通过。
  - 阶段 1 的幸存实例不重新生成覆盖层（只在启动时生成），旧覆盖层没有这一行，插件处于「没有平台地址」态，不受影响。
- **Auth / permissions / secrets**：
  - 这一行只有平台地址，不含 RAGFlow 地址、密钥或检索参数，也不含实例令牌（令牌由 15.2 从环境变量读取）。
  - 生成器测试断言：在 settings 层面放入 RAGFlow 地址与密钥的取值无从进入生成器（`ManagedConfigInput` 没有这些字段）；对网络方式的输出断言它不包含 `ragflow`、`retrieval`、`apiKey` 这些键名（大小写不敏感），以及测试给出的 RAGFlow 哨兵取值。
- **Legacy compatibility**：
  - 现有覆盖层的其他行和顺序不变；`platformPort: null` 时输出与改动前逐字节相同（published-loopback 的回归基线）。
  - 直接调用生成器的地方（以 `grep -rln generateManagedConfig platform/src platform/test` 为全集）补上 `platformPort`：`platform/test/managed-policy-fixture.ts`、`model-refusal-fixture.ts`、`permission-browser-fixture.mjs`、`permission-tiers.docker.test.ts:96`、`office-delegation.docker.test.ts:56,171`、`credential-priority-fixture.ts:71`、`platform/src/managed-config/write.test.ts`。除了 managed-policy（见下），一律传 `null`，保持它们原有的覆盖层。
  - 构造 `StartUserContainerInput` 的测试辅助代码补 `config.port`，统一传 `8080`（与 `auth-fixture.ts:13` 一致；传 0 会让网络方式启动在 `managed overlay` 阶段抛错）：`platform/test/container-start-fixture.ts:604`（`start.test.ts`、`container-network-mode`、`container-reconcile.integration`、`container-network-allocation` 共用）、`container-start-docker-fixture.ts:350`、`instance-browser-docker-fixture.ts:35`、`instance-idle-docker-fixture.ts:191`、`dsh-cookie-fixture.ts:74,131`；其余以 `pnpm typecheck` 为准。
  - 间接影响：`container-reconcile.docker.test.ts` 经真实启动路径以网络方式启动实例，覆盖层会带上原子网 +3 的这一行；它的 `rebindSurvivorWeb`（`:360-389`）只改 `webserver` 行，断言不受影响（模拟的幸存者因此多了这一行，不再是阶段 1 的形态，不影响它要证明的重新接入）。
- **Error handling**：非整数、0、65536、负数、`NaN`、字符串、缺失（未定义）的 `platformPort` 都抛 `TypeError`；`null` 不抛。

not selected：

- Concurrency / shared state：生成器是纯函数，编排器只多传一个值。
- Migration：没有数据库或 settings 变化。
- Resource limits：无。

**不变量**：

- 网络方式下，每个新启动实例的覆盖层恰有一条 `knowledge-base` 配置行，地址是该实例 bridge 的 +3，端口是平台的 `PLATFORM_PORT`；三种目录状态下这一行相同。
- published-loopback 下覆盖层没有 `knowledge-base` 配置行，输出与改动前相同。
- 覆盖层中没有 RAGFlow 地址、密钥或检索参数；相同输入得到逐字节相同的输出。

**Must preserve**：

- 11.4（#407）和 11.4b（#509）的目录行、`platform-nav` 行、安装源与联网工具行的内容和顺序。
- 启动失败补偿、网络分配和覆盖层写入顺序：覆盖层仍在网络分配之后生成（`start.ts` 的 `managed overlay` 阶段）。

**同级面**：

- #418 的 host 半区校验这一行；畸形值让插件加载失败（失败标记检查兜底）。
- 15.2：host 半区用 `platformUrl` 加环境变量里的令牌调用代理。

**宽度**：生成器与测试、编排器两行与 `start.test.ts`、测试辅助代码的机械更新、managed-policy 的 Docker 断言、AGENTS.md 一句，预计不超过 400 行。

Evidence (15.1 覆盖层下发平台地址，#447):

**改动点**：

- `platform/src/managed-config/generate.ts`、`generate.test.ts`、`generate-catalog.test.ts`（3×2 矩阵，见测试）、`write.test.ts`（只补输入）。`generate.test.ts` 的共享 `INPUT`（`:6`）与 `generate-catalog.test.ts` 的 `BASE` 固定传 `platformPort: null`，保持 `:474` 等「目录行后紧跟 `plugin-manager`」的位置断言；网络方式由单独的用例覆盖。
- `platform/src/orchestrator/start-identity.ts`（`Pick` 加 `'port'`）、`start.ts`（传 `platformPort`）、`start.test.ts`：
  - 默认 `fixture()` 是 published-loopback（`start.test.ts:186`、`:661-683`）：扩展 `:173-192` 现有的覆盖层断言，要求没有 `knowledge-base` 配置行；
  - 网络方式用 `networkOwner()`（`:643-650`），断言覆盖层含 `{ id: 'knowledge-base', config: { platformUrl: 'http://172.30.0.3:8080' } }`（分配子网 +3 加夹具端口）。
- 测试辅助：上面 Legacy 一节列出的调用方。
- managed-policy 的 Docker 断言：`publishOverlay` 传固定测试端口 `8080`；它有首启（`:620`）和重启（`:808`）两次调用，网络不同，所以期望的 `platformUrl` 按各自的 `webAddress(network)` 推出 +3，传给 `assertPluginsLoaded`，`KNOWLEDGE_BASE_LOADED`（`:76`）不再是常量；observer 的 `knowledgeBase()` 照 `entryConfig`（`managed-policy-observer.js:62-73`）的写法读 `entry.fiber.config`，增加 `config` 字段；断言它恰为 `{ platformUrl: 'http://<该网络 +3>:8080' }`。这是 #418 的 host 校验第一次在真实 DSH 上收到生成器的输出：没有插件失败标记、条目已激活，证明两边的契约一致。用例里没有平台监听那个地址，15.1 的 host 半区也不发请求，所以不需要真实平台。
- `AGENTS.md` 的覆盖层生成器段落（由 orchestrator 改）：加一句 `platformPort` 和 `knowledge-base` 行，以及下面的残余。
- `plugins/knowledge-base/README.md`（implementer 改）：`:17`「In 15.1 this is always the state」与 `:38`「after #447」的将来时改为现状：网络方式下覆盖层给出 `platformUrl`，published-loopback 下没有。

**测试**：

- 单元（`pnpm test`）：
  - 3 种目录状态 × 2 种上游方式（放在 `generate-catalog.test.ts`，用它的 `entry()` 与 bundle 辅助，`knowledge-base` 的规范 patch 取 #418 的一行插入）：网络方式三种状态下这一行逐字节相同且地址为 +3；published-loopback 三种状态下没有这一行；启用状态行与 11.4 相同。
  - 位置：网络方式加 `forced-on` 缺席时，这一行出现在整段规范 patch 的插入行之后、`plugin-manager` 之前。
  - 基准：同一输入下，`platformPort: null` 的输出等于网络方式的输出去掉那一行 `knowledge-base` 配置行；并钉死网络方式的行 id 序列。
  - 相同输入两次生成逐字节相同。
  - 没有 RAGFlow 键名和哨兵取值。
  - 每种非法 `platformPort` 抛 `TypeError`，消息不含输入。
  - `start.test.ts` 的两种上游方式。
- 先红后绿：生成器的新断言先失败（缺少这一行或缺少输入校验），再实现。

**命令**：

- `pnpm test`、`pnpm check`
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`（清理已确认）
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论（控制台错误仍为 0）。「Compose 网络方式下真实实例收到这一行」由编排者在运行后核对：在宿主机读该员工的 `<managedConfigDir>/<userId>.patch.yml`，与 inspect 到的实例子网 +3 和 `PLATFORM_PORT` 比对（如果运行结束时目录已随运行目录删除，就在 stack 用例里加一条只读断言，由 implementer 实现）。

**交接**：

- 15.2：`platformUrl` 已由覆盖层给出；host 半区读取 `DSH_TEAM_INSTANCE_TOKEN`、注册路由并调用 `<platformUrl>/_platform/instance-api/ragflow/…`。
- 残余（写进 AGENTS.md 与交接）：「平台在 +3 上监听 `PLATFORM_PORT`」只在 `PLATFORM_HOST` 绑到所有地址时成立（Compose 要求 `0.0.0.0`）；网络方式下平台容器若绑定别的地址，插件到不了平台。运营方改了 `PLATFORM_PORT` 并重建平台后，运行中的实例在下次启动前仍持有旧端口。

Risk packs (15.2 左侧栏「知识库」面板，#419): fixture level expanded（与 issue 建议一致：员工第一次在浏览器里看到上游数据，请求经插件自己的 host 路由用实例令牌访问平台代理）。范围控件是 15.3（#420），检索工具是 15.4（#421）；本 issue 不涉及检索范围。selected：

- **Public API**（DSH 0.2.1-rc.2 发行版接口，编排者从本机用户镜像只读提取发行包核对）：
  - host 路由用 `ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch })`（`dsh-client-connection/lib/index.js:840-854`，类型 `lib/types/rpc.d.ts:114-141`）。
    - 路径必须是 `/api/<段>`，段只能用 `[A-Za-z0-9_$.-]`，只能精确匹配，没有路径参数。
    - DSH 在交给处理函数之前完成鉴权：`/api` 前缀路由先走 `connection.admit`：未鉴权得到 401，Host 或 Origin 不受信任得到 403，不是本人的 Peer 得到 403（`:1048-1055`、`:742-751`、`:826-831`）。浏览器经平台网关到达时，带的是网关注入的 DSH cookie。
    - 发行插件 `dsh-client-ui-deliverables`、`dsh-client-file-upload` 用的是同一种写法。
    - host 模块因此新增导出 `inject = ['connection']`。
  - 两条路由，编排者钉死：
    - `GET /api/knowledge-base.datasets`：无查询参数。有任何查询串时，返回 `invalid-request` 并且不发上游请求。它转发到 `<platformUrl>/_platform/instance-api/ragflow/datasets`。
    - `GET /api/knowledge-base.documents?datasetId=<32 位小写 hex>&page=<1..999999>&pageSize=<1..100>[&keywords=<非空白，≤256 UTF-8 字节>]`：
      - 查询串的解析规则与 #415 的代理一致：严格解析并做百分号解码，未知、重复、格式不合法的参数都返回 `invalid-request`，不发上游请求；
      - 合法时转发到 `<platformUrl>/_platform/instance-api/ragflow/datasets/<id>/documents?page=&page_size=&keywords=`。
  - 两条路由都只回 HTTP 200，响应头 `content-type: application/json`、`cache-control: no-store`。响应体是封闭集合：
    - `{ result: 'ok', datasets: [{ id, name }] }`；
    - `{ result: 'ok', total, documents: [{ id, name }] }`；
    - `{ result }`，`result` 取 `not-configured`、`unavailable`、`timeout`、`upstream-error`、`invalid-request` 之一。
  - host 到平台这一跳：
    - 请求头 `Authorization: Bearer <DSH_TEAM_INSTANCE_TOKEN>`，令牌直接从 `process.env` 读取；
    - `redirect: 'manual'`；单次 25 秒期限（代理每次上游调用 10 秒），覆盖到响应体读完；响应体上限 2 MiB（代理自身允许 1000 个库 × 名字 1024 字节，约 1.07 MB；rc2 实际把库名限制在 128 字节），上限作为平台请求函数的参数，15.4 的检索回应用 8 MiB；不重试；
    - 客户端断开或插件卸载时中止请求。
  - 平台回应的映射：
    - 平台回 HTTP 200，并且回应体能通过本插件对代理响应形状的严格校验时，原样转出（只保留上面列出的字段）；
    - 3xx、401 和其他非 200、超出上限、无法解析或形状不合法 → `upstream-error`；401 单独记一行固定日志，便于排查令牌问题；
    - 传输失败 → `unavailable`；超时 → `timeout`。
    - 平台自己的 `result`（例如 `not-configured`）原样传出。
- **Config / 可用性**：
  - 插件可用的条件是同时满足两点：覆盖层给了合法的 `{ platformUrl }`（#418 的校验、#447 的输出），并且 `DSH_TEAM_INSTANCE_TOKEN` 是 64 位小写 hex。
  - 可用时注册两条路由，并经 `webserver/index-inject` 发布页面全局 `__DSH_TEAM_KNOWLEDGE_BASE__ = { available: true }`（与 `platform-nav` 发布全局变量的机制相同）。
  - 不可用时（published-loopback、员工的旧覆盖层、令牌缺失或形状不合法）：不注册路由，发布 `{ available: false }`。client 据此不注册面板，这对应设计里的「插件在该实例不可用」。
  - 令牌不在页面全局、日志或回应里出现。
- **Client 半区**（左侧栏面板的落点，编排者裁定）：
  - DSH 0.2.1 的左侧栏没有可以放内容的槽位：`sidebar.workspaces` 是会话树单槽，`sidebar.footer.action` 是页脚入口（`dsh-client-ui-sidebar/lib/client.js:487-521`）。
  - 发行版的「面板」做法是成对注册（参照 `dsh-client-ui-schedule/lib/client.js:7467-7490`）：
    - 在 `sidebar.panellist` 注册一行入口（`{ id: 'knowledge-base', order, label: () => '知识库' }`，组件接收 `{ size, active }`，用内联 SVG 图标）；
    - 在 `main` 注册同一个 key 的页面组件；
    - `layout.selectPanel(id)` 要求 `main` 中存在同 key 的条目（`dsh-client-ui-layout`，`:469`）。
  - 「左侧栏『知识库』面板」按这个发行版定义实现：入口在左侧栏，内容显示在主区域，和 DSH 自带的定时任务面板一样。
  - `package.json` 的 `dsh.client.inject` 加上 `@deepseek-ai/dsh-client-ui-layout`。client 运行时的 `inject` 为 `['slots']`。React 用 `requireClient('react')` 取得。不依赖 `primitives` 组件，界面元素用普通 DOM 元素加 DSH 的 CSS 变量，与 `platform-nav` 相同。
  - 所有文案固定为中文，不注册多语言资源。
  - 结构（`eslint.config.mjs:25-30` 对 `plugins/*/client.js` 限制每个函数 200 行、复杂度 15、整个文件 800 行）：组件和辅助函数放在文件顶层的 IIFE 或块里（该规则不计 IIFE），`factory` 只做注入和注册。host 与 client 都保持单文件；如果超过 800 行必须拆文件，就会改到关键路径 `images/dsh-user/Dockerfile` 的 COPY 列表，这时停下来报告。
  - 请求一律是同源相对地址 `fetch('api/knowledge-base.…')`（`frontend-static` 注入了 `<base href="./">`）。所有回应体都要读完，再更新界面状态。
- **状态机**（spec「五种状态可区分」，编排者钉死映射）：
  - 库列表：
    - 加载中：首次打开与刷新时；
    - 知识库未配置：`not-configured`；不显示空列表，也不给重试按钮；
    - 失败可重试：`unavailable`、`timeout`、`upstream-error`、`invalid-request`，并给一个重试按钮；
    - 空库：`ok` 并且 0 个库；
    - 无匹配：有库，但按库名搜索（客户端过滤，不区分大小写的子串匹配，搜索框非空）后一个都不剩；
    - 列表：其余情况。
  - 展开的库：
    - 文件分页大小固定 20，由 client 传给 `pageSize`；
    - 加载中 / 知识库未配置 / 失败可重试（重试同一页）；
    - 空库：`total` 为 0 且没有文件名筛选；
    - 无匹配：`total` 为 0 且有筛选；
    - 文件列表：带「上一页／下一页」和「第 x / N 页」。按文件名筛选用 `keywords`：按回车或点击筛选按钮提交，提交后回到第 1 页。
    - 筛选词在发请求前用与代理相同的规则校验（空白判断含 U+0085，上限 256 个 UTF-8 字节）：全是空白就当作清除筛选；超出上限就不提交，显示单独的提示「筛选词过长」，不进入失败可重试（否则重试永远失败）。
    - `total > 0` 但当前页为空（文件在两次请求之间被删，页码超出末页）：退回到最后一页重新请求一次，仍为空就显示空库或无匹配。
  - 每种状态的文案互不相同，界面元素带稳定的 `data-dsh-team-kb-state` 属性，单元测试和浏览器用例按它定位。
  - 刷新按钮重新拉库列表并收起所有展开的库。
  - 旧请求不能覆盖新状态：每个库、以及库列表各有一个请求序号，过期回应直接丢弃。
  - 浏览操作不读也不写任何 Session 或范围数据（spec「浏览不改变范围」；15.3 之前没有范围可言）。
- **Auth / permissions / secrets**：
  - 浏览器只访问 DSH 自己的 `/api/knowledge-base.*`，拿不到实例令牌，也看不到平台地址。
  - 回应里只有库与文件的 ID 和名称、文件总数和封闭集合的 `result`。
  - host 日志只写固定文本和 `result`，不写 `keywords`、令牌、平台地址或回应体。
- **Error handling**：
  - 平台回应或网络发生任何异常，都映射成封闭集合，不抛到 DSH（处理函数抛错时 DSH 会回 400，不可控）。
  - client 遇到非 200 或无法解析的 JSON 时，按「失败可重试」处理，不在控制台报错。
- **Resource limits**：每个库最多一个进行中的请求，新请求发出前中止旧请求；库列表同理。

not selected：

- Concurrency / shared state：插件没有持久状态。
- Migration / Schema：没有数据库或设置变化。

**不变量**：

- 不可用的实例上没有面板、没有路由、也不发请求；直接打开 DSH 的验证通道仍然没有控制台错误。
- 浏览器拿不到令牌和平台地址；面板只显示库名与文件名。
- 五种状态（以及「列表」）可区分，文案互不相同。

**Must preserve**：

- #418 的配置契约（`apply` 对畸形配置抛错、没有地址时什么都不做），只在此基础上加路由和页面全局。
- 启动模块清单不变（client 模块 id 仍为 `@dsh-team/knowledge-base`）；managed-policy 中 loader 条目的断言不变。
- #417 的本机通道用例的全部既有断言与顺序：停机期间员工登录、启动、对话，以及四个接口的两组结果。

**同级面**：

- 15.3：在同一个 client 模块里加输入区范围控件，同样借用 host 路由取库列表。
- 15.4：检索工具在 host 半区直接调用代理，不经过浏览器路由。

**宽度**：host 路由、client 面板、两个测试文件和本机通道用例，预计超过 400 行，开 PR 时打 `diff-limit-exempt`（创建 PR 之后再加标签，并确认 `opened` 那次的 diff 守卫有没有被重跑覆盖）。`plugins/` 不是关键路径；`images/dsh-user/Dockerfile` 只 COPY 四个文件，host 与 client 各保持单文件，所以 Dockerfile 不变（镜像内容随插件变化）。

Evidence (15.2 左侧栏「知识库」面板，#419):

**改动点**：

- `plugins/knowledge-base/index.js`：
  - 导出 `inject`；
  - 可用性判断、页面全局、两条路由、查询串解析、到平台的请求与回应校验和映射。
- `plugins/knowledge-base/client.js`：面板入口、主区页面和状态机。
- `index.test.js`、`client.test.js`：client 测试用 jsdom 加 `react-test-renderer`，照 `platform-nav` 的写法。
- `types.d.ts`、`client.types.d.ts`、`package.json`（`dsh.client.inject`）、`README.md`。
- 本机通道用例：`platform/test/platform-stack.stack.test.ts`。浏览器操作新写在 `platform/test/knowledge-panel-stack-fixture.ts`，复用 `stack-browser-fixture.ts` 的登录、证据收集和截图写法；不依赖 Docker 的纯函数配一个集成测试。
- 截图目录照现有的 `reports/stack/<runId>`。
- `AGENTS.md`、`docs/LOCAL_STACK.md` 由 orchestrator 改。

**测试**：

- 单元测试（`pnpm test`），覆盖率逐文件 80%。
  - host：
    - 可用性矩阵（地址有或无 × 令牌合法、缺失或畸形）决定是否注册路由，以及页面全局的取值；
    - 两条路由的查询串合法与非法情况：非法时没有上游请求；
    - 上游请求的地址、方法、`Authorization` 和 `redirect` 选项；
    - 平台回应的每一种映射：`ok` 透传，平台自己的 `not-configured` 等原样传出，3xx、401、500、超出上限、非 JSON、形状不合法都是 `upstream-error`，传输失败是 `unavailable`，超时是 `timeout`；
    - 请求中止；日志里没有 keywords 和令牌。
  - client：
    - 只在 `available: true` 时注册面板入口和 `main`，两者的 key 一致；页面全局缺失、不是对象或 `available` 不是 `true` 时什么都不注册（对应 spec「启用状态服从目录」中 forced-off 没有面板，以及不可用实例）；
    - 库列表六种显示（加载中、未配置、失败可重试、空库、无匹配、列表），文案互不相同；重试；刷新会收起展开的库；
    - 展开的库六种显示；筛选回到第 1 页；空白筛选当作清除，超长筛选显示单独提示且不发请求；页码超出末页时退回；翻页边界；
    - 过期回应被丢弃；
    - 只请求 `api/knowledge-base.*`，回应体都被读完。
- 本机通道（`pnpm test:stack`，Playwright Chromium 经网关访问真实种子数据），截图都带面板状态：
  1. **知识库未配置**：在管理员保存模型设置之后、`configureRagflow` 之前，用 `registerDeploymentEmployee` 注册第二个员工，它的容器、卷和网络由该函数登记清理。用 `instanceGatewayFixture` 预先启动它的实例（照 `platform-stack.stack.test.ts:209-216`），打开「知识库」面板，看到「知识库未配置」，没有重试按钮，截图 `kb-not-configured.png`。截图后先结束这个员工的面板浏览器会话（停止观察并关闭浏览器；禁用会主动断开该用户的 WebSocket，开着的页面会产生重连错误），再由管理员 `PUT /_platform/api/admin/users/<id>/status`（`{ status: 'disabled' }`，带 origin 与管理员 cookie），要求回 204：204 只在实例退役完成之后才返回（`platform/src/admin/account-status.ts:72-93`，`instance-service.ts:333`），不需要轮询，非 204 就让用例失败。`runningInstances` 在下一次配置 PUT 时现查（`config-route.ts:160-163`），所以随后的 `configureRagflow` 看到 0。第二个员工的邮箱与 `employee@deployment.example.test` 不同。之后进入 #417 的流程。这样 `ragflow-stack-fixture.ts:604`（`runningInstances: 0`）与 `:708`（`runningInstances: 1`）不用改。不用管理员本人的实例：它会改变这两处计数，资源也没有登记清理。
  2. **失败可重试**：RAGFlow 停机期间，放在 `proxyWhileDown` 之后、`proxyAfterRestore` 之前（恢复在后者里面，`ragflow-stack-fixture.ts:681`）。员工打开面板，库列表是失败可重试；点重试仍然失败。截图 `kb-unavailable.png`。
  3. **恢复后**：在 `proxyAfterRestore` 之后（阈值改动不影响浏览）：
     - 刷新，三个种子库名都在列表中（本机 RAGFlow 里可能还有别的库），截图 `kb-datasets.png`；
     - 展开 `dsh-team-seed-policies`，看到 2 个文件，截图 `kb-files.png`；
     - 文件名筛选 `expense`，看到 1 个文件 `expense-policy.txt`，截图 `kb-filter.png`；
     - 按库名搜索一个随机字符串，看到「无匹配」，截图 `kb-no-match.png`。
  - 浏览器页面资源（#418 交接的 spec 第四处，审查轮 1 补入）：三个面板会话收集同源 200 回应的正文（DSH HTML 文档、全部 javascript 脚本含合并插件脚本、`/api/knowledge-base.*` 回答；不含 `/_platform/` 页面、`text/event-stream` 与重定向），断言其中不含已保存的 RAGFlow 密钥、已保存的 RAGFlow 地址、该员工容器的实例令牌和 `<+3 地址>:<端口>`。阳性对照：至少一个 HTML 含 `__DSH_TEAM_KNOWLEDGE_BASE__`，至少一个脚本含 `data-dsh-team-kb-page`，至少一个面板路由回答。取值只在内存里比较，失败信息只写针的种类和 URL path。
  - 所有面板会话：控制台错误 0、页面错误 0、失败请求 0、外部请求 0。每一步都等 `data-dsh-team-kb-state` 离开「加载中」再做下一步，因为被中止的请求在 Playwright 里算失败请求（`net::ERR_ABORTED`）；关闭浏览器之前先停止观察（照 `stack-browser-fixture.ts:186`）。
  - `stackEvidence` 增加单独的 `panel` 证据对象，只记各步的状态名、库数、文件数和面板截图名；面板截图不并入既有的截图列表（`platform-stack.stack.test.ts:374` 对它做精确比较），名字也不与 `failure.png` 等既有名重复。
  - 种子库每个只有 2 个文件，真实数据走不到翻页；翻页由单元测试覆盖，PR 里写明。
- 先红后绿：新的单元断言先失败，stack 中的面板步骤也先失败（面板不存在），再实现。

**命令**：

- `pnpm test`、`pnpm check`
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`（清理已确认）

**交接**：

- 15.3：范围控件同样通过 `api/knowledge-base.datasets` 取库列表；Session 事件的读写在 client 里做。
- 15.4：检索工具在 host 半区复用本 issue 的平台请求函数，增加 `POST retrieval`。

Risk packs (15.3 输入区检索范围控件与提交快照，#420): fixture level expanded（与 issue 建议一致：插件第一次写 Session 状态，并为 15.4 的子 Agent 继承定下快照形状）。检索工具是 15.4（#421）；本 issue 不发检索请求。selected：

- **Public API**（DSH 0.2.1-rc.2 发行版接口，编排者从本机用户镜像只读提取发行包核对，R = 发行包的 `@deepseek-ai/` 目录）：
  - 存储落点（用户 2026-11-05 裁定，改写 design 决定 4 与任务 15.3 的「`ignorable: true` 的 Session 事件」）：
    - 不用插件记录：发行文档禁止 DSH 之外的插件调用 `appendPluginRecord`（`R/dsh-session/README.md:70`，`R/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` 的 Do not append 一条）；插件从 `/opt/dsh-team/knowledge-base/` 也解析不到 `@deepseek-ai/dsh-session`；`Session.append` 不能设 `ignorable`，写新类型会让 Session 无法重开（`R/dsh-session-persistence/lib/index.js:171-184`）。
    - 改用命令：host 注册 `/kb-scope` 命令；`CommandRuntime.execute` 在处理函数前后追加 `command/run`（`{ commandId, name, args, source }`，`recordInput` 保持默认 true 才记 `args`）与 `command/done`（`{ commandId, kind, text? }`）（`R/dsh-commands/lib/index.js:327-400`）。两者是已知事件类型，正常持久化，不进模型可见面（`R/dsh-commands/lib/types/types.d.ts:93-100`，`R/dsh-session/lib/index.js:157-163`）。命令执行没有忙碌检查，运行中的一轮里也立即追加；冷 Session 由控制器先恢复（`R/dsh-api-session-controller/lib/index.js:189-230`）。
  - 命令（编排者钉死）：
    - `name: 'kb-scope'`，`description: '设置本 Session 的知识库检索范围（由输入区控件调用）'`，`input: { hint: '<json>' }`，不接受附件，`definitionId` 用插件包名。
    - 参数是一行 JSON：`{"datasetIds":null}`（全选，之后新建的库也包括在内）或 `{"datasetIds":[...]}`（0..1000 个互不相同的 32 位小写 hex；`[]` 是取消全选）。`rawInput`/`args` 是命令名之后的原样输入（可能带前导空白），去掉首尾空白后交给 `JSON.parse`。其他形状、多余键、重复 ID、超过 40000 个 UTF-8 字节返回 `{ kind: 'error', text: '知识库范围参数无效' }`，不回显输入。
    - 成功返回 `{ kind: 'success', text }`，`text` 是固定的中文摘要（「知识库范围：全部」「知识库范围：不检索」「知识库范围：N 个」）。
    - 员工手动输入 `/kb-scope …` 等同于点控件，同样校验；命令出现在 `/` 菜单里（`CommandDescriptor` 没有隐藏字段，`R/dsh-commands/lib/types/types.d.ts:55-64`），作为已知残余写进 README。
  - 投影（编排者钉死，照 `R/dsh-plan-mode/lib/index.js:65-122` 的折叠方式）：`ctx.sessionProjections.register({ key: 'kbScope', stateVersion: 1, stateSchema, init, apply, wire: { viewSchema, view } })`。
    - `stateSchema`/`viewSchema` 只需要 `parse(value)`（`R/dsh-session-projection/lib/index.js:254-304,421-432` 只调用 `.parse` 并使用它的返回值）；插件没有 zod，手写校验对象：`parse` 返回经过校验的输入，校验失败抛错。
    - 状态 `{ child, selection, running, turn }`：
      - `init(header)`：`child` 为 `header.origin === 'subagent'`（与控制器 `hasApiSessionSubagentOwner` 的判断一致，`R/dsh-subagent/lib/index.js:352`；员工自己 fork 出的 Session 也带 `parentSession` 但没有 `origin`，不算子 Session，`R/dsh-session/lib/index.js:2017`），`selection: null`，`running: null`，`turn: null`；
      - `command/run` 且 `name === 'kb-scope'`：`args` 能解析为合法参数时 `running = { commandId, selection }`，否则 `running = null`；
      - `command/done` 且 `commandId === running?.commandId`：`kind === 'success'` 时 `selection = running.selection`；无论成败 `running = null`；
      - `turn/start`：`turn = { turn: event.data.turn, scope: selection }`；
      - 其余事件返回同一个 state 引用。
    - 折叠是纯函数：每个 `command/run` 都重新校验 `args`（旧日志或手写的坏参数不改变 `selection`），只有配对成功的命令生效；只有 `command/run` 没有 `command/done`（崩溃）时不生效。
    - wire 视图 `{ child, selection, turn }`，给 client 和本机通道读取。
    - 没有记录的 Session 为 `selection: null`，即新 Session 默认全选（D10）；`[]` 与 `null` 可区分。
  - 快照时点（用户 2026-11-05 裁定）：`turn/start` 时折叠。运行中的一轮里改范围，`command/run` 的 seq 在该轮 `turn/start` 之后，只影响下一轮；空闲时提交立刻开轮；在上一轮运行中排队的提交，取该轮真正开始时的选择（已知残余，写进 README 与 PR Risk）。
  - host 注册放在 `ctx.inject(['sessionProjections', 'commands'], …)` 里，并且只在插件可用（#419 的条件）时注册；缺这两个服务时面板照常工作。
- **Client 半区**（输入区控件）：
  - 槽位 `conversation.input.left`，条目 `{ name: 'knowledge-base-scope', id: 'knowledge-base-scope', order: 100 }`（`list`、`scope: 'session'`，`R/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:311-315`，渲染于 `client.js:19072`）。条目收到标准 Session 工具集 `sessionId`、`useProjection` 等（`R/dsh-cordis-client-runner/lib/client.js:3401-3456`）。
  - 控件只读 `useProjection('kbScope')`，不另存选择；`child` 为 true（子 Agent 的 Session）或投影缺失时不渲染。
  - 写入经 `ctx.remote.commands.execute(sessionId, '/kb-scope ' + JSON.stringify({ datasetIds }), [])`（`R/dsh-commands/lib/typert.remote-client.d.ts:12`，返回 `RemoteResult<CommandExecution | undefined>`；用法同 `R/dsh-client-ui-plan/lib/client.js:704-708`）。`ok: false`、`value === undefined`、`result.kind === 'error'` 都显示「范围保存失败，请重试」；写入进行中禁用控件（一个同步的进行中标志），不做乐观更新，界面以投影回推的值为准。
  - client 运行时 `inject` 加 `remote.commands`。`package.json` 的 `dsh.client.inject` 照 `dsh-client-ui-plan` 的先例加 `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`（`package.json` 已在 Dockerfile 的 COPY 列表中，不碰关键路径）。
  - 控件外观：一个按钮，文字按投影显示「知识库：全部」「知识库：不检索」「知识库：N 个」（N 为 `selection` 中的 ID 数）。点开后是一个弹层：
    - 「全选」写 `null`，「取消全选」写 `[]`；
    - 库列表经 `api/knowledge-base.datasets`（复用 #419 的请求与状态：加载中、知识库未配置、失败可重试、空库、列表），每个库一个复选框；
    - `selection` 为 `null` 时全部勾选；取消某一库时写入当前列出的全部 ID 去掉这一个；在 ID 列表上勾选或取消时增删这一个，保持原顺序、追加到末尾；
    - `selection` 里不在当前列表中的 ID（库已删除）保留不动，由 15.4 的 `excluded` 报告；
    - 状态元素带 `data-dsh-team-kb-scope` 属性，单元测试和浏览器用例按它定位。
  - 对话记录里的命令行：注册 `conversation.chat.commandview`，`key: 'kb-scope'`，渲染 `null`（`R/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:360-367`，同 key 替换命令渲染器）。外层 `div.callRow` 仍在（`R/dsh-client-ui-chat/lib/client.js:6504`），本机通道截图检查没有多余的可见行；如果有，报告，不改 DSH。
  - 面板（#419）与控件互不影响：浏览不读写范围（spec「浏览不改变范围」）。
  - 结构约束与 #419 相同：host、client 各保持单文件，800 行上限；如果必须拆文件就会改到关键路径 `images/dsh-user/Dockerfile`，这时停下来报告。
- **Concurrency / shared state**：
  - 选择只在 Session 日志里；client 不缓存，Session 切换时由 `useProjection` 跟随（槽位是 `scope: 'session'`）。
  - 两个 Session 的选择互不影响；同一 Session 的两个浏览器标签页都从投影读取。
  - 快速连续点击由进行中标志串行化；命令按到达顺序追加，最后一条成功的生效。
- **Auth / permissions / secrets**：
  - 命令参数只含库 ID；不含 RAGFlow 地址、密钥、实例令牌或检索参数（spec「实例内找不到 RAGFlow 密钥」的 Session 数据部分）。
  - 子 Agent 的 Session 由控制器拒绝命令（`R/dsh-api-session-controller/lib/index.js:128-133,225`）；控件在子 Session 不渲染。
- **Legacy compatibility**：
  - 已有 Session 没有 `kb-scope` 记录，读作全选。
  - `stateVersion: 1`；以后改折叠语义要升版本，投影缓存会重新折叠（`R/dsh-session-projection/lib/types/index.d.ts`）。
  - fork 复制事件前缀，范围随之继承；fork 出的 Session 照常显示控件。写进 README。
  - 空白 Session 复用（已知残余，写进 README 与 PR Risk）：DSH 把没有 `turn/start` 的 Session 算作空白（`R/dsh-api-session-controller/lib/index.js:493`），「新建」和登录落地会复用空白 Session（`R/dsh-client-ui-workspace/lib/client.js:1406-1427`），投影看不到这次复用。员工在新 Session 里改了范围但还没提交，再点「新建」时会回到这个 Session，看到的是自己改过的范围而不是「全部」。

not selected：

- Migration / Schema：没有平台数据库、设置或 HTTP 契约变化。
- Resource limits：命令参数上限约 35 KB（1000 个 ID）；不新增网络请求，库列表复用 #419 的路由。

**不变量**：

- 新 Session 默认全选；`[]` 与全选可区分。
- 某一轮的 `turn.scope` 等于 `command/done`（`kind: success`）在该轮 `turn/start` 之前的最后一条 `kb-scope` 命令的选择；之后的修改只改 `selection`。
- 范围不进模型上下文；确定性 provider 收到的消息里没有范围或命令。
- 浏览面板不改变范围。

**Must preserve**：

- #419 的面板、路由、页面全局和全部测试；本机通道 #417、#419 的全部既有断言与顺序。
- 启动模块清单与 managed-policy 中 loader 条目的断言不变。
- `deployment-model-wire.ts` 被 `test:deploy` 共用：新增的保持能力只在配置里出现保持标记时启用，其他用法的行为不变。

**同级面**：

- 15.4：检索工具只在当前 Session 头部 `origin === 'subagent'` 时沿 `parentSession` 上溯，直到头部不再是子 Agent 为止，那就是根 Session（`ctx.agents.get`，冷 Session 用 `ctx.sessions.get`，同 `plugins/permission-tiers/index.js` 的 `initializeChild`）；员工 fork 出的 Session 是自己的根，读 `ctx.sessionProjections.stateOf(root, 'kbScope').turn.scope`：`null` 为全部库，`[]` 不发请求。读取时核对 `turn.turn` 等于根 Session 当前打开的一轮。

Evidence (15.3 输入区检索范围控件与提交快照，#420):

**改动点**：

- `plugins/knowledge-base/index.js`：投影定义（导出纯函数 `scopeProjection` 或同等形式供单元测试）、`kb-scope` 命令与参数校验、`ctx.inject(['sessionProjections', 'commands'], …)` 注册。
- `plugins/knowledge-base/client.js`：输入区控件、弹层、命令渲染器替换。
- `index.test.js`、`client.test.js` 与新建的 `client-scope.test.js`（`client.test.js` 已 658 行，范围控件的测试放在新文件里，守住 800 行上限）、`types.d.ts`/`client.types.d.ts`、`README.md`（范围的存储与快照语义、排队提交的残余、`/kb-scope` 出现在 `/` 菜单、fork 继承）。
- `platform/test/deployment-model-wire.ts`：可选的配置项 `hold`（非机密 nonce），不出现时行为不变：
  - 只保持第一个「消息含 `hold`、提供了工具、还没有工具结果」的请求（与 `scriptedCall` 同一谓词，标题请求和工具结果轮不保持），只保持一次；
  - `POST /release` 释放全部已挂起请求并解除保持；`/health` 增加 `held`（当前挂起数）；
  - 释放与读取都经 `privatePlatformRead` 在平台容器内发出，与 `PROVIDER_HEALTH` 同一条路；
  - 可选配置项 `forbidden`（字符串数组，非机密）：任何请求的消息含其中任一字符串时计入 `/health` 的 `forbiddenRequests`。
- 本机通道：`platform/test/platform-stack.stack.test.ts` 加范围步骤；浏览器操作写在 `platform/test/knowledge-scope-stack-fixture.ts`（或扩展 `knowledge-panel-stack-fixture.ts`），复用 `workbenchSession` 与 #419 的证据写法；纯函数配集成测试。
- `AGENTS.md`、`docs/LOCAL_STACK.md` 由 orchestrator 改。

**测试**：

- 单元测试（`pnpm test`），覆盖率逐文件 80%。
  - host：
    - 折叠矩阵：无记录为 `null`；成功命令对生效；失败的 `command/done`、坏参数、不配对的 `commandId`、只有 `command/run`、其他命令名都不生效；`turn/start` 快照当时的 `selection`；`turn/start` 之后的命令只改 `selection` 不改 `turn`；连续两轮各自快照；`init` 的 `child`；无关事件返回同一引用；
    - schema 对象的 `parse` 接受合法状态与视图、拒绝畸形值；
    - 命令处理函数：合法 `null`/`[]`/列表成功，各种非法参数返回固定错误且不回显；
    - 插件不可用或缺服务时不注册命令和投影。
  - client：
    - 投影缺失或 `child` 时不渲染；三种按钮文字；
    - 弹层的库列表状态复用；全选、取消全选、从全选取消一个、在列表上增删一个时写出的命令行；
    - 进行中禁用，三种失败显示同一提示；成功后不做乐观更新；
    - 不在列表中的已选 ID 保留；
    - 命令渲染器替换返回 `null`。
- 本机通道（`pnpm test:stack`，Playwright Chromium 经网关，确定性 provider），放在 #419 恢复后的面板步骤之后：
  1. **新 Session 默认全选**：员工新建 Session 1，控件显示「知识库：全部」，`session/projections` 的 `kbScope` 为 `selection: null`。截图 `scope-default.png`。
  2. **提交后修改不影响进行中的任务**：在 Session 1 只选 `dsh-team-seed-policies`；提交一条带 `hold` 标记的消息，等 `/health` 的 `held` ≥ 1（证明该轮已经 `turn/start`）；任务运行期间把范围改成另一个种子库；`POST /release`，等该轮结束。核对：该轮 `turn.scope` 为第一个库、`selection` 为第二个库；原生历史里第二条 `kb-scope` 的 `command/run` 在该轮 `turn/start` 之后（独立证据）；再提交一条普通消息，新一轮的 `turn.scope` 为第二个库。截图 `scope-running.png`。
  3. **两个 Session 互相独立**：新建 Session 2，控件显示「知识库：全部」；Session 2 先发一条普通消息（让它不再是空白 Session，出现在侧栏），再取消全选，显示「知识库：不检索」；切回 Session 1 仍是第二个库。Session 2 已非空白之后再点「新建」得到 Session 3，控件显示「知识库：全部」。
     - **浏览不改变范围**：在 Session 1 打开「知识库」面板，展开并按文件名筛选一个未选中的种子库，回到 Session 1，核对按钮文字和投影的 `selection` 都没变。
  4. **刷新与重开后恢复**：刷新页面，Session 1、Session 2 各自恢复；关闭浏览器、用新的浏览器上下文重新登录，再次核对；管理员重启该员工实例（既有重启接口，等待就绪）后再核对一次。截图 `scope-restored.png`。
  - 对话记录里没有命令行：`[data-chat-flow]` 内的文本不含 `kb-scope` 和「知识库范围」（DOM 断言），截图供人工核对空的 `callRow` 是否可见。
  - 范围不进模型上下文：provider 配置的 `forbidden` 为 `kb-scope`、「知识库范围」和三个种子库 ID（compose 启动前从 RAGFlow 种子数据读出，非机密），`forbiddenRequests` 断言为 0。
  - Session 定位：DSH 没有 URL 路由，确定性 provider 让 Session 标题相同；侧栏行用 `[data-row-key="session:<id>"]` 取 id 并点击切换，当前 Session 由 `aria-selected="true"` 判断（`R/dsh-client-ui-workspace/lib/client.js:2275`）。
  - 投影读取：经网关用 `mappedSessionRpc(base, <员工 cookie>)`（`platform/test/owned-completion-fixture.ts`）调用 `session/projections`，`kind === 'sequenced'` 时取 `values.kbScope`；返回 `null` 或 `migration-required` 时该步失败。原生历史用同文件的 `sessionEvents`。
  - 位置：范围步骤放在 `restoredPanel` 之后、`duringRagflowOutage` 回调之内（RAGFlow 已恢复，弹层能取到库列表）；实例重启用既有 `/_platform/api/admin/instances/<id>/restart`，就绪用 `instanceGatewayFixture` 的等待。
  - 所有范围会话：控制台错误 0、页面错误 0、失败请求 0、外部请求 0；沿用 #419 的页面资源秘密扫描。
  - `stackEvidence` 增加单独的 `scope` 对象，只记各步的按钮文字、选择的库数、快照的库数和截图名。
- 先红后绿：新的单元断言先失败，stack 中的范围步骤也先失败（控件不存在），再实现。

**命令**：

- `pnpm test`、`pnpm check`
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`（清理已确认）

**宽度**：host 投影与命令、client 控件、单元测试、provider 保持能力和本机通道步骤，预计超过 400 行，开 PR 时打 `diff-limit-exempt`。`plugins/` 与 `platform/test/` 不是关键路径；host、client 各保持单文件，Dockerfile 不变。

**交接**：

- 15.4：按上面「同级面」读取根 Session 的 `turn.scope`；`excluded` 报告已删除的库。

Risk packs (15.4 知识库检索工具与来源展示，#421): fixture level expanded（与 issue 建议一致：Agent 第一次经插件取得上游数据，涉及子 Agent 继承根 Session 的本轮范围和员工可见的来源展示）。范围的存储与快照由 #420 交付；本 issue 只读快照，不改快照语义。selected：

- **Public API**（DSH 0.2.1-rc.2 发行版接口，编排者从本机用户镜像只读提取发行包核对，R = 发行包的 `@deepseek-ai/` 目录）：
  - 工具注册：`ctx.tools.register(definition)`（`R/dsh-tools/lib/types/index.d.ts:632-637`）；定义为 `{ name, description, parameters, output: { schema, render, presentationMeta? }, execute, timeoutMs?, isConcurrencySafe?, presentCall?, presentResult? }`（`:106-115`），`execute(args, exec)` 的 `exec` 带 `callId`、`agent`、`signal`（`:216-247`）。仓库内先例：`plugins/office-agents/docx-construction.js:191-263`。
  - 注册放在既有的 `ctx.inject(['sessionProjections', 'commands'], …)` 旁，新增 `ctx.inject(['tools', 'sessionProjections', 'agents'], …)`，只在插件可用（#419 的条件）时注册；缺服务时面板与范围控件照常工作。全局注册：子 Agent 继承全局工具（`R/dsh-tools/lib/types/index.d.ts:632-668`），`tool-subagent` 不接受 `toolFilter`（`R/dsh-tool-subagent/lib/index.js:355`），综合办公与公文与材料写作都能看到该工具，`plugins/office-agents` 不改。
  - 工具名 `knowledge_base_search`（编排者钉死）；`parameters` 恰为 `{ question: string }`，`additionalProperties: false`；`question` 在 `execute` 内按代理的规则校验（非空白、含 U+0085 的空白判断与 #419 相同，≤4096 UTF-8 字节），不合法时不发请求，返回 `invalid-question`。
  - 结果不抛错：所有结局都返回封闭集合的值，由 `render` 给模型中文文本。不注册 client 侧的 `tool.call.toolview`：发行版 Web 客户端不消费 host 的 `presentCall`/`presentResult`（`R/dsh-tools/README.zh.md:95`、`R/dsh-client-ui-tool/README.zh.md:54`），员工看到的是通用 `GenericToolCard`（标题「工具调用」，摘要 `knowledge_base_search · <问题>`），展开该行后输出区显示 `tool/result` 的文本，即 `render` 给模型的同一段文本（`R/dsh-client-ui-tool/lib/client.js:320`）。所以不实现 `presentResult`（PR #535 审查第 1 轮发现后删除）。
  - 形状（编排者钉死）：`execute` 返回值与 `output.schema` 为 `{ result, chunks?, excluded? }`，`chunks` 为 `[{ content, documentName, datasetName, positions? }]`，`excluded` 为剔除的数量（整数，不放 ID）。`output.presentationMeta(args, value)` 给出 `{ result, title, excluded, chunks }`（同样不含 ID），持久化为 `tool/result` 的 `meta`；Web 客户端不渲染它，本机通道从原生历史读取它；`meta` 会随 Session 发到浏览器，「不含库 ID」的检查也覆盖原生历史里的 `meta`。
  - 工具名、description 和参数描述里不出现 `kb-scope`、「知识库范围」与任何库 ID：工具是全局的，它的定义随每个模型请求的 `tools[]` 发给 provider，而 #420 的 `forbidden` 扫描整个请求体；单元测试断言这一点。
  - `exec.agent` 缺失时返回 `scope-unavailable`；`exec.signal` 中止时返回 `unavailable`。DSH Web 组成里没有找到 `dsh-tool-call-timeout-policy`，`timeoutMs` 可能不生效，期限以插件内部的两次 25 秒为准。
  - `permission-tiers` 只拦截 `write`、`edit`、`bash`、`run_code`、`build_docx`（`plugins/permission-tiers/index.js:16`），新工具不进入该集合，任何权限档位都不需要审批。
- **范围解析**（编排者钉死）：
  - 根 Session：从 `exec.agent.session` 开始，只在头部 `origin === 'subagent'` 时经 `ctx.agents.get(header.parentSession)?.session` 看父 Session；员工 fork 出的 Session 是自己的根。孙子 Agent 复制父 Agent 的记录（见下一条），所以只有父 Session 是根的子 Agent 才读根，无需逐层上溯（PR #535 审查后删去原来的 16 层上限）。
  - 根 Session 自己调用时：快照是 `ctx.sessionProjections.stateOf(root, 'kbScope')?.turn`。根 Session 的 agent 在本轮内调用工具，`kbScope.turn` 必然是本轮，不另做轮次核对（#420 交接中的核对由此满足）。
  - 子 Agent 调用时：委派是异步的，父轮可能已结束、员工可能已经改了范围并开始了新的一轮，所以不能读根 Session 的最新快照（spec「该任务的所有检索只针对库1」「子 Agent MUST NOT 扩大范围」）。host 半区监听 `agent/created`：新建的 agent 头部 `origin === 'subagent'` 时按 `source`（`'startup' | 'resume' | 'clear' | 'compact'`，`R/dsh-agent/lib/types/runtime-types.d.ts:105`）处理：`startup` 记下创建那一刻根 Session 的 `kbScope.turn`；`resume` 也记下根 Session 当前一轮（恢复是员工或父 Agent 发起的新任务，README 与不变量写明）；`compact`/`clear` 不覆盖已有记录，记录已被删掉时检索返回 `scope-unavailable`。记下的是（孙子 Agent，即父 Session 自身 `origin === 'subagent'` 的 Agent，不论 `startup` 还是 `resume` 都复制父 Agent 的记录，父 Agent 没有记录时为 `scope-unavailable`；只有父 Session 是根的子 Agent 在 `resume` 时才读根 Session 当前一轮。PR #535 审查第 1 轮：否则后台继续运行的子 Agent 冷恢复其孙子时会取到根 Session 更宽的新范围，违反「子 Agent MUST NOT 扩大范围」），按子 Session ID 存在插件内存里，`agent/disposed` 时删除。子 Agent 检索用这份记录。实现前核对 `agent/created` 的载荷与触发时机（发行包 `R/dsh-agent`、`R/dsh-subagent/lib/index.js:344-400`），以及它在子 Agent 第一次调用工具之前触发。
  - 没有记录（没有活着的父 Agent 时恢复的子 Agent，例如实例重启后；插件晚于子 Agent 加载）、孙子 Agent 的父 Agent 没有记录、父 Session 不在内存中、投影缺失、`turn` 为 `null`、读取投影抛错：返回 `scope-unavailable`，不发请求（不扩大范围）。
  - `scope` 为 `[]`：不发请求，返回 `no-scope`。
  - `scope` 为 `null`：先用 #419 的平台请求函数 `GET …/ragflow/datasets` 取全部库，得到空列表时返回 `no-datasets`（不发检索，空 `datasetIds` 是 `invalid-request`）；列表失败时返回该失败取值。
  - 否则直接用 `scope` 中的 ID。
  - 然后 `POST …/ragflow/retrieval`，请求体恰为 `{ question, datasetIds }`；平台请求函数新增 POST 变体（`content-type: application/json`，`redirect: 'manual'`，Bearer 实例令牌），单次期限 25 秒，回应上限 8 MiB；`exec.signal` 与期限合并。工具 `timeoutMs` 为 60 秒（列表加检索两次调用）。
- **结果与提示**（编排者钉死的封闭集合，每个 `result` 的模型文本与 meta 标题互不相同，单元测试断言两两不同）：
  - `ok`：标题「知识库检索：N 条结果」；每个片段显示 `content`、文件名、所属知识库，`positions` 有值时原样显示为「位置：…」（不推导页码）；`excluded` 非空时另加一行「有 K 个已选知识库已不可用，已跳过」。
  - `no-results`：「知识库中没有找到相关内容」；同样附 `excluded` 提示。
  - `no-scope`：「本轮没有选择知识库，未检索」（spec「取消全部后不检索」）。
  - `no-datasets`：「平台上还没有任何知识库，未检索」（范围为全选、但平台上没有任何库；与员工取消全部的 `no-scope` 区分）。
  - `scope-unavailable`：「无法确定本轮的检索范围，未检索」。
  - `invalid-question`：「检索问题为空或过长，未检索」。
  - 代理取值：`invalid-request`「检索请求无效」、`not-configured`「知识库未配置，请联系管理员」、`timeout`「知识库检索超时，请稍后重试」、`unavailable`「知识库暂时不可用，请稍后重试」、`upstream-error`「知识库返回了异常结果，请稍后重试」。
  - 模型文本与卡片里只有库名和文件名，不出现库 ID、令牌、平台地址、`kb-scope` 或「知识库范围」字样（本机通道 provider 的 `forbidden` 扫描整个请求体，包括工具结果）。
  - 回应校验沿用 #419 的严格形状校验：`ok` 的每个片段都要有字符串 `content`、`documentName`、`datasetName`，`positions` 若有则为非空的 5 数字元组数组；代理回应的 `excluded` 为字符串数组（工具返回值里的 `excluded` 是数量）；其他形状一律 `upstream-error`。
- **Auth / permissions / secrets**：令牌只在 host 半区；日志只写固定文本和 `result`，不写问题、片段、库 ID 或平台地址。
- **Error handling**：任何异常（网络、解析、平台非 200）都映射成封闭集合，工具不抛错，对话可以继续（spec「对话可以继续」）。
- **Resource limits**：片段数由平台的 `retrievalTopK`（≤100）决定；回应上限 8 MiB；单次调用 25 秒、整次工具 60 秒。

not selected：

- Migration / Schema：平台代理与 HTTP 契约不变（「全部库」由插件先列表再检索，不给代理加新模式）。
- Concurrency / shared state：工具只读快照，不写 Session。

**不变量**：

- 根的子 Agent 的检索范围等于它被创建（`startup`）或恢复（`resume`）时根 Session 那一轮的快照；更深的子 Agent 在创建与恢复时都复制委派它的父 Agent 的记录，所以范围不会比父 Agent 更宽；之后根 Session 的修改与新一轮都不影响它们；拿不到这份快照时不检索，不扩大范围。
- `[]` 不发任何请求；`null` 不把空列表发给检索。
- 每种结局的提示互不相同；知识库不可用时工具返回提示，对话继续。

**Must preserve**：

- #419 的面板路由与平台请求函数的既有行为（GET 变体不变）、#420 的命令、投影和控件，以及两者的全部测试。
- 本机通道 #417、#419、#420 的全部既有断言与顺序；`deployment-model-wire.ts` 不配置新脚本时行为不变（`test:deploy` 共用）。

**同级面**：

- 16.x 以后与知识库无关；本 issue 完成后第 15 组结束。

Evidence (15.4 知识库检索工具与来源展示，#421):

**改动点**：

- `plugins/knowledge-base/index.js`：工具定义、根 Session 解析、POST 变体、结果映射与中文文本；`types.d.ts`；`README.md`（工具名、范围解析、异步委派下的快照、结局文本、模型只看到库名）。
- 单元测试：新建 `index-search.test.js`（`index.test.js` 与 `index-scope.test.js` 已接近 800 行上限）。
- `platform/test/deployment-model-wire.ts`：可选配置 `delegation: { childMarker, question }`，不出现时行为不变（`/health` 只在配置了 `delegation` 时才多出 `delegations`、`searches`，同 `held` 的写法）。委派的两条谓词在 `scriptedCall` 与 `hold` 之前判断，并且都要求消息含 `childMarker`，所以 #417 的 write 步骤和 #420 各 Session 的首轮不受影响：
  - 父请求（消息含 `childMarker`、提供了 `subagent` 工具、还没有工具结果）→ 调用 `subagent`，`{ description, prompt: '<childMarker> …' }`（参数形状见 `R/dsh-tool-subagent/lib/index.js:392-398`，省略 `agent_preset` 时用综合办公的默认 `office-writer`）；
  - 子请求（提供了 `knowledge_base_search`、没有提供 `subagent`、消息含 `childMarker`、还没有工具结果）→ 调用 `knowledge_base_search`，`{ question }`；
  - 其余请求照旧回固定文本；`/health` 增加 `delegations`、`searches` 计数。
- 本机通道：浏览器操作写在 `platform/test/knowledge-search-stack-fixture.ts`，纯函数配集成测试；`platform/test/platform-stack.stack.test.ts` 在 #420 的范围步骤之后加检索步骤。
- `AGENTS.md`、`docs/LOCAL_STACK.md` 由 orchestrator 改。

**测试**：

- 单元测试（`pnpm test`），覆盖率逐文件 80%：
  - 根解析：根自身；一层、两层子 Agent；fork（有 `parentSession` 无 `origin`）是自己的根；父不在内存、投影缺失、`turn` 为 `null` 都是 `scope-unavailable`；17 层链条逐层传递同一记录；
  - 范围：`[]` 不发任何请求；`null` 先列表再检索，空列表 `no-datasets` 且不检索，列表失败传出失败取值；ID 列表直接检索；请求体恰为 `{ question, datasetIds }`、方法、`Authorization`、`content-type`、`redirect`；
  - 子 Agent 的快照：`compact`/`clear` 重新 announce 后范围不变（或在记录已删时为 `scope-unavailable`）；根 Session 第 N 轮创建子 Agent 后，根 Session 改成更宽的范围并进入第 N+1 轮，子 Agent 仍用第 N 轮的范围；孙子 Agent 继承同一记录（`startup` 与 `resume` 都是；根 Session 之后改宽、孙子 Agent 以 `resume` 重新 announce 时仍用父 Agent 的记录；父 Agent 没有记录时 `scope-unavailable`）；`sessionProjections.stateOf` 抛错时返回 `scope-unavailable`，模型文本里没有 `Error:`；结果文本中文件名与库名里的换行被替换，不能伪造条目；`agent/disposed` 后记录删除；没有记录时 `scope-unavailable`；
  - 结局：11 种结局（插件 6 种加代理 5 种）的模型文本两两不同、meta 标题两两不同；工具名与描述不含 `kb-scope`、「知识库范围」；`excluded` 提示；`positions` 只在有值时显示；文本与 meta 不含库 ID、令牌、平台地址；回应形状不合法为 `upstream-error`；超时、传输失败、中止；
  - `question` 校验：空白、超 4096 字节不发请求；
  - 插件不可用或缺 `tools`/`agents` 时不注册工具。
- 本机通道（`pnpm test:stack`，Playwright Chromium 经网关，确定性 provider），放在 #420 的范围步骤之后，同一员工：
  - 正对照（放在既有的 `proxyAfterRestore` 里，不在检索步骤中执行）：
    - `proxyAfterRestore` 里已有的全库检索记下所属知识库名的集合，要求其中至少有一个不是 `dsh-team-seed-policies`；这样「范围没有扩大」才有区分力。
    - 单库正对照（用户决定 2026-11-05）：第 3、4 次本机运行实测，真实 rc2 对 `QUESTION`「报销需要提交哪些材料」只检索 policies 库时，默认参数下是 `no-results`（库里 2 个文档、2 个 chunk 都已解析，embedding 与其他库相同），所以检索步骤改用专门的 `SEARCH_QUESTION`「在琥珀报销台报销需要上传哪些材料」（含种子文件 `expense-policy.txt` 独有的「琥珀报销台」）。`proxyAfterRestore` 在严格阈值 PUT 之前，以默认参数对 `[policies]` 检索一次 `SEARCH_QUESTION`：要求 `ok`、`excluded: []`、至少 1 个片段，所有片段都是种子片段，来源库恰为 `[dsh-team-seed-policies]`。每次运行的付费检索因此为 5 次（`proxyAfterRestore` 4 次，子 Agent 1 次）。
    - 任一正对照失败就停下报告。`QUESTION` 和阈值不变（`proxyAfterRestore` 的既有断言共用它们）。
  0. **恢复检索参数**：`proxyAfterRestore` 把相似度阈值设成了 1（`ragflow-stack-fixture.ts:733-740`），检索步骤前由管理员 PUT `DEFAULT_RETRIEVAL`，要求 200。`delegation.question` 用 `SEARCH_QUESTION`（见上方单库正对照）。
  1. **子 Agent 用根 Session 的范围**：新建 Session（综合办公），在输入区以员工身份输入 `/kb-scope {"datasetIds":["<dsh-team-seed-policies 的 ID>","<32 个 0>"]}`（伪造的 ID 模拟已删除的库，不写 RAGFlow，同 #417 的 `MISSING_ID`）（输入框的前导 `/` 走命令路径，`R/dsh-client-ui-commands/lib/client.js:1624-1666`），确认控件显示「知识库：2 个」、投影 `selection` 恰为这两个 ID、`command/done` 成功且没有新的 `turn/start`；然后发一条带 `childMarker` 的消息。provider 让综合办公调用 `subagent`，子 Agent（公文与材料写作）调用 `knowledge_base_search`。
  2. **核对**（经网关读原生历史，`mappedSessionRpc` + `sessionEvents`）：
     - 子 Session ID 从根 Session 的 `subagent` 工具结果文本 `started subagent <id>` 解析（根 Session 的 `tool/result` 不持久化返回值）；
     - `sessionEvents` 增加地址参数，用 `{ kind: 'subagent', parentSessionId, childSessionId, mode }` 读子 Session（控制器拒绝用 `kind: 'session'` 读子 Agent，`R/dsh-api-session-controller/lib/index.js:1690-1693`）；不复制新 helper；地址校验通过即证明了 `origin` 与父 Session；
     - 子 Session 中恰有一次 `knowledge_base_search` 的 `tool/call` 与成功的 `tool/result`；
     - 工具结果文本含「知识库检索：」与「有 1 个已选知识库已不可用，已跳过」，所有片段的所属知识库都是 `dsh-team-seed-policies`（范围没有扩大到另外两个种子库）；
     - 结果文本与 `meta` 都不含任何库 ID（三个种子库 ID 与伪造 ID）；provider 的 `forbiddenRequests` 仍为 0，`delegations`、`searches` 各为 1；
     - 检索卡片在子 Session 里（`tool/result` 追加到执行工具的 agent 的 Session，`R/dsh-agent-loop/lib/index.js:691-706`）：浏览器进入子 Session（沿用 `platform/test/permission-browser-fixture.mjs` 的 `openChild` 做法），先展开该轮折叠的步骤行（发行版 `TurnProcessNodeView` 的 `button[data-turn-process]`）和其中的步骤组标题「已调用工具」（`ProcessGroupHeader` 的 `button[data-process-activity][aria-controls]`），各只点一次、不来回切换；子 Session 视图里恰有一张可见的 `[data-tool="knowledge_base_search"]` 卡片（`elementFromPoint` 命中卡片内部），再点开这一行一次，断言展开后的输出文本含「知识库检索：N 条结果」（N 等于原生历史的片段数）、剔除提示「有 1 个已选知识库已不可用，已跳过」和「所属知识库：dsh-team-seed-policies」，然后截图 `search-sources.png`。片段、文件名与所属知识库同时以原生历史里该次 `tool/result` 的 meta 为准（上面「核对」已断言）。用户决定：2026-11-06 一度放宽为只证明卡片可见（当时报告的原因只是「文案校验未通过」）；PR #535 审查查明根因是 Web 客户端不用 `presentResult`、要点开工具行才显示 `render` 文本，用户 2026-11-06 决定恢复内容校验。
  - 每一步写明等待上限，耗时记进证据。
  - 检索会话：控制台错误 0、页面错误 0、失败请求 0、外部请求 0；沿用页面资源秘密扫描。
  - `stackEvidence` 增加单独的 `search` 对象，只记结局、片段数、所属知识库名集合、剔除数和截图名。
  - 每次运行共 5 次付费检索（`proxyAfterRestore` 4 次，子 Agent 1 次；见上方 2026-11-05 的单库正对照决定，AGENTS.md 同步）。
- 先红后绿：新的单元断言先失败；stack 中的检索步骤先失败（工具不存在），再实现。

**命令**：

- `pnpm test`、`pnpm check`
- 本机 exact-head 的 `pnpm test:stack`，并贴证据评论
- VPS exact-head 的 `pnpm test:docker` 与 `pnpm test:deploy`（清理已确认）

**宽度**：工具与单元测试、provider 脚本和本机通道步骤，预计超过 400 行，开 PR 时打 `diff-limit-exempt`。`plugins/` 与 `platform/test/` 不是关键路径；host 保持单文件，Dockerfile 不变。如果必须拆文件就会改到关键路径 `images/dsh-user/Dockerfile`，这时停下来报告。

**交接**：第 15 组完成；19.x 的阶段验收复用本机通道的检索步骤。

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

Risk packs (16.1 compose 服务与 JWT 变量，#422): fixture level expanded（与 issue 建议一致：新的部署组件和 compose 必填输入）。平台本任务不读取 `DOCUMENT_SERVER_*`（16.2a），编排器不接入（16.3），`docs/DEPLOY.md` 归 16.4。selected：

- **Config（compose 与示例文件）**：
  - `deploy/compose.yml` 新增服务 `documentserver`：`image: onlyoffice/documentserver:9.4.0`，`container_name: dsh-team-documentserver`（字面量），不写 `ports`，不改网络（与平台同在 compose 默认网络，不设 `gw_priority`），不写 `restart`（与平台一致）。`environment` 恰为 `JWT_ENABLED: "true"`、`JWT_SECRET: ${DOCUMENT_SERVER_JWT_SECRET:?Set DOCUMENT_SERVER_JWT_SECRET for the bundled Document Server}`、`ALLOW_PRIVATE_IP_ADDRESS: "true"`。字体：`volumes` 一项 `type: bind`、`source: ./assets/fonts`、`target: /usr/share/fonts/truetype/custom`、`read_only: true`、`bind.create_host_path: false`。不新增字体目录变量：`assets/fonts/` 是仓库已约定的运营方字体目录（`docs/IMPLEMENTATION_PLAN.md` §6「由离线交付包单独携带」、D13、`verify/phase0/up-office.sh` 的同一挂载点），相对路径按 `--project-directory`（仓库根）解析；目录不存在时 compose 启动失败而不是自动创建空目录。
  - `platform` 服务的 `environment` 增加 `DOCUMENT_SERVER_CONTAINER_NAME: dsh-team-documentserver`（字面量，同 `PLATFORM_CONTAINER_NAME`）和 `DOCUMENT_SERVER_JWT_SECRET: ${DOCUMENT_SERVER_JWT_SECRET:?…}`（同一变量、同一提示文案）。提示文案不含「冒号加空格」，以免 `check-config.mjs` 的 `scalar()` 把它切成键值。
  - `.env.example` 在 `DEPLOY_DOCKER_GID=` 之后新增注释和有效赋值 `DOCUMENT_SERVER_JWT_SECRET=`（空值，不放密钥或占位值）；注释写明：交付的 compose 把同一个值传给自带 Document Server 和平台，compose 部署必须填写一个随机长值，留空或未设置时 compose 在创建任何容器前失败；compose 部署还需要仓库根下的运营方字体目录 `assets/fonts/`（缺失时 Document Server 容器创建失败）。示例文件不新增 `DOCUMENT_SERVER_CONTAINER_NAME`（16.2a 随平台读取一起加）。
- **Config（配置清单核对）**：`scripts/check-config.mjs` 的 compose 插值扫描同时收集 `DOCUMENT_SERVER_[A-Z0-9_]+`，按前缀分别与示例文件中的 `DEPLOY_*`、`DOCUMENT_SERVER_*` 有效赋值双向比较（未列出 → `undocumented <name>`，未消费 → `unconsumed <name>`）；字面量容器名不是插值，不计入。成功输出改为 `Configuration inventories match: PLATFORM_*, DEPLOY_* and DOCUMENT_SERVER_*`。`scripts/test-guardrails.sh` 在现有两组 `DEPLOY_*` 拒绝用例旁新增两条：示例文件追加 `DOCUMENT_SERVER_UNUSED=sentinel` → `unconsumed DOCUMENT_SERVER_UNUSED`；compose 追加 `x-inventory: ${DOCUMENT_SERVER_UNDOCUMENTED:?}` → `undocumented DOCUMENT_SERVER_UNDOCUMENTED`。平台读取侧仍只接受 `PLATFORM_*`（16.2a 才扩展）。
- **Auth / permissions / secrets（测试用 JWT）**：
  - `platform/test/deployment-compose-fixture.ts` 的 `writeComposeConfiguration` 是两条通道（`test:deploy` 与本机 `test:stack`）唯一的 env 写入点：默认在解析 `.env.example` 后注入本次调用新生成的 `randomBytes(32).toString('hex')` 作为 `DOCUMENT_SERVER_JWT_SECRET`，并把它随返回值交给调用方（只在内存里）；`startDeployment` 把它挂到 `Deployment` 接口的新字段上，正例由此取得夹具值；新增可选输入 `documentServerJwt: 'empty' | 'unset'` 只供下面的拒绝用例使用：`'empty'` 保留示例的空值行，`'unset'` 在写文件前从环境对象中删除该键（写出的 `compose.env` 里没有这一行）。
  - 值只出现在 0600 的 `compose.env` 和两个容器的环境里；不进入日志、报告、证据、断言消息或 PR。任何 matcher（`toEqual`、`toContain`、`arrayContaining`、`toMatchObject` 等）都不得接收 `Config.Env` 数组或原值，因为失败输出会打印整个实参：先把 Env 投影成只含布尔值和 SHA-256 摘要的对象（例如 `{ jwtEnabled, allowPrivate, containerName, jwtSha256 }`），再对投影断言。
- **Public API / Legacy（`test:deploy` 替身与断言）**：
  - VPS 上 `documentserver` 由夹具覆盖文件换成替身：`image` 为本次调用已捕获的平台镜像 ID（自有、已存在，不额外构建、拉取或登记镜像），`entrypoint: ["node", "-e", "setInterval(() => {}, 1 << 30)"]`，字体卷以同一 `target` 覆盖为本次运行私有目录下新建的空目录（compose 按 `target` 合并服务卷；覆盖项显式重写 `type: bind`、`read_only: true`、`bind.create_host_path: false`，不依赖合并继承字段）。替身与平台一样带 `dsh-team.test-run=<runId>` 标签。`writeComposeConfiguration` 新增可选输入 `documentServer?: { image: string; fontsDir: string }` 写这些覆盖；本机通道不传，用真实镜像和仓库 `assets/fonts`。两条通道的所有权覆盖都给 `documentserver` 加运行标签。
  - 固定名准入：两条通道在创建前都确认 `dsh-team-documentserver` 不存在（`isAbsentResource`，与平台同一判定，错误 `Document Server container already exists or absence is unproven; refusing deployment`），并在 `compose up` 前把它登记为 `container` 资源；退休沿用账本的精确名与标签核对。部署夹具不新增 setup 阶段名（`deployment-setup-evidence.ts` 的阶段是封闭集合，两个 `deployment-setup-*` 集成测试 `toEqual` 比对完整阶段表）：Document Server 的准入并入既有 `fixed-name-admission`，登记并入既有 `resource-registration`。
  - 新文件 `platform/test/deployment-document-server.docker.test.ts`（`pnpm test:deploy` 的脚本改为依次运行 `deployment.docker.test.ts` 与该文件；docker 项目 `fileParallelism: false`，完整 `test:docker` 自动发现）：
    - 正例（`withDeployment` + `start()`）：`dsh-team-documentserver` 运行中、带本次运行标签、`HostConfig.PortBindings` 为空且 `NetworkSettings.Ports` 没有宿主绑定；字体挂载 `Destination=/usr/share/fonts/truetype/custom`、`RW=false`；环境中 `JWT_ENABLED=true`、`ALLOW_PRIVATE_IP_ADDRESS=true`，`JWT_SECRET` 的摘要等于夹具值的摘要；平台环境中 `DOCUMENT_SERVER_CONTAINER_NAME=dsh-team-documentserver`，`DOCUMENT_SERVER_JWT_SECRET` 的摘要等于夹具值的摘要；平台健康检查照常 200（平台不读这两项）。
    - 拒绝例（同一个 `withDeployment`，不调用 `start()`、不构建平台镜像）：对 `'unset'` 与 `'empty'` 各写一份配置并执行与正例相同的 `compose up -d --no-build --pull never`；先按正例同样的顺序对两个固定名做 `isAbsentResource` 准入，再登记两个固定名容器和项目网络；断言退出非零、stderr 含 `DOCUMENT_SERVER_JWT_SECRET`；`'unset'` 时另断言写出的 env 文件没有该键；之后 `dsh-team-platform`、`dsh-team-documentserver`、项目网络都 `inspect` 404，且带本次运行标签和该 compose 项目标签的容器清单为空。`platformImage` 用一个不存在的本次运行自有标签名（插值意外通过时也只能在镜像缺失处失败，登记的资源由退休清理）。
  - Docker-free：`deployment-setup-*` 的假 Docker 序列测试随新增的准入、登记步骤更新；新增一例「`dsh-team-documentserver` 已存在 → 在构建前拒绝、不删除、不收养」。新增 `writeComposeConfiguration` 的 Docker-free 测试（新文件 `platform/test/deployment-compose-fixture.integration.test.ts`，临时目录）：`compose.env` 为 0600；默认 JWT 是 64 位小写 hex 且两次调用不同、并与返回值一致；`'unset'` 时文件没有该键行，`'empty'` 时保留空值行；所有权覆盖给 `documentserver` 加运行标签；传入 `documentServer` 时覆盖的 `image`、`entrypoint` 与字体卷结构正确，不传时不改 `image` 与卷。测试断言同样不把 JWT 原值交给 matcher。
- **Resource limits / File IO（本机通道）**：
  - 真实镜像（arm64，约 1.3 GB，声明 `VOLUME` `/usr/share/fonts/truetype/custom`、`/var/lib/onlyoffice`、`/var/log/onlyoffice`、`/var/www/onlyoffice/Data`）在 macOS arm64 上随 compose 启动；`scripts/test-stack-prerequisites.mjs` 在创建任何资源前新增两项检查：`docker image inspect onlyoffice/documentserver:9.4.0` 成功（否则 `Document Server image onlyoffice/documentserver:9.4.0 missing; docker pull it first`），`<repositoryRoot>/assets/fonts` 是目录（按仓库根解析，不按 cwd；否则 `assets/fonts directory missing`）；不自动拉取。两项加进 `StackFacts` typedef，在 `scripts/test-stack.mjs` 的惰性 `gathered` 列表中排在 `buildx` 之后、python/chromium 与 RAGFlow version 之前；测试在 `platform/test/test-stack.integration.test.ts` 的前提用例中补齐（缺镜像、缺目录各一例，均在创建资源前失败）。内存：Docker Desktop 门槛仍是既有的 14 GiB，Document Server 只启动不使用；若本机运行因内存失败，如实报告，不调门槛。
  - 真实镜像声明了 `VOLUME`，compose 会为它创建匿名卷。`platform/test/docker-cleanup.ts` 的精确容器退休改为 `container rm --force --volumes`：只删除该容器的匿名卷，命名卷照旧是独立的账本目标；`docker-cleanup.integration.test.ts`（约 `:429`）与 `test-stack.integration.test.ts`（约 `:518` 的 `'container rm --force dsh-team-platform'`）两处精确命令期望随之更新。`platform-stack.stack.test.ts` 在 `compose up` 后断言该容器运行中、`Config.Image` 为 `onlyoffice/documentserver:9.4.0`、没有宿主端口绑定（沿用 `deployment.docker.test.ts:596-606` 的判定：配置的 `HostConfig.PortBindings` 为 `{}`，`NetworkSettings.Ports` 的每个有效绑定都是 null——镜像 `EXPOSE 80/443` 会留下 null 项），并记下该容器 `Mounts` 中 `Type=volume` 的卷名，交给外层；`runUserImage` 返回时 `finish()` 已在 vitest 进程内完成规范的账本退休（`user-image-fixture.ts:535-536`，`--volumes` 随容器删除匿名卷），`it` 随后逐个 `volume inspect` 这些卷断言 404。不新增第二条退休路径；`scripts/test-stack.mjs` 的进程外日志退休仍只是兜底。其余步骤不变（不等待 Document Server 就绪，不访问它）。
- **Documentation**（编排者同 PR 改）：AGENTS.md「Compose deployment verification」写明 compose 同时起 `dsh-team-documentserver`（9.4.0、JWT 来自必填 `DOCUMENT_SERVER_JWT_SECRET`、`assets/fonts` 只读、无宿主端口）、`.env` 须填写该值、固定名准入覆盖两个名字、`test:deploy` 用平台镜像替身和两个新用例；「Test overrides supply only captured image/owned resource identities, never a substitute platform」一句写明 Document Server 替身（本次捕获的平台镜像加空转入口）是允许的例外；「Final inventories include the fixed platform name …」加上 `dsh-team-documentserver`；`pnpm test:deploy` 的描述改为两个文件；验证矩阵「Compose deployment」与「Local full stack」两行补上对应证据；`lint:config` 说明补一句 compose 插值也覆盖 `DOCUMENT_SERVER_*`（三类改写归 16.2a）。`docs/LOCAL_STACK.md` §1 前提加镜像与字体目录、§6 清理行加「匿名卷随容器删除，运行前后全部卷清单相同」。`constraints.yaml` 的 `lint:config` 描述，以及 `verification` 中 `compose_deployment`、`local_stack` 两条 evidence 与验证矩阵同步。

not selected：Schema（无迁移、无接口，`schemas/openapi.json` 不变）、Concurrency（沿用部署锁与串行 docker 项目）、Release（无新依赖；镜像按 D11 的 9.4.0 标签）、Error handling（失败全部来自 compose 自身的 `:?` 与缺失绑定源，平台不新增错误路径）。无关键路径文件（不改 `platform/src/orchestrator/`、`images/`）。

Governing invariant：交付的 compose 只有在 `.env` 给出非空 `DOCUMENT_SERVER_JWT_SECRET` 时才创建任何容器，且该值同时、原样到达 Document Server 和平台；测试用的值每次新生成、从不离开 0600 文件和容器环境。

PR 范围说明：`docker-cleanup.ts` 一个标志、`test-stack-prerequisites.mjs`/`test-stack.mjs` 的两项前提与新的 Docker-free 夹具测试超出 issue 列出的模块，但都是本变更不泄漏资源、不在资源创建后才失败的直接需要；PR 描述写明理由，超过 400 行时加 `diff-limit-exempt`。

Sibling surfaces：`deployment-observer-fixture.ts` 的暴露清单（按 compose 项目标签自动覆盖替身：无发布、无 socket 绑定）、`deployment-fixture.ts` 的 `recreateDeployment`（再次 `compose up` 时替身不变）、TLS 覆盖（追加服务）、`scripts/test-stack.mjs` 的账本退休与运行后标签清单、`platform/test/test-stack.integration.test.ts`（前提用例与 `:518` 的退休命令）、`docker-cleanup.integration.test.ts`。

Evidence：`pnpm lint:config`、`pnpm test:guardrails`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（新文件两例在两次运行中都出现，清理已确认）；本机 exact-head `pnpm test:stack`（运行前先 `docker pull onlyoffice/documentserver:9.4.0`，证据评论含 Document Server 容器断言与运行前后全部卷清单相同）。

Risk packs (16.2a 平台启动读取并校验 Document Server 配置，#423): fixture level expanded（与 issue 建议一致：新的启动配置契约，其中一项是密钥）。本任务只读取和校验；编排器使用这两项属于 16.3，外部 Document Server 设置属于 16.2b。selected：

- **Config（读取与三态校验，`platform/src/config.ts`）**：
  - `PlatformConfig` 新增必填字段 `documentServer: { readonly containerName: string; readonly jwtSecret: string } | null`；`null` 表示自带 Document Server 未配置（Office 不可用）。`loadConfig` 在现有字段之后计算它（示例中其他取值合法，所以原样载入时第一个错误就是 Document Server 这一项）。
  - 「存在」按 `!== undefined` 判断；「为空」按 `=== ''` 判断。两项都用字面量读取（`env.DOCUMENT_SERVER_CONTAINER_NAME`、`env.DOCUMENT_SERVER_JWT_SECRET`），不经变量下标，否则 `lint:config` 的字面量检查会拒绝。规则按下面顺序，第一条命中即抛错，不回显任何取值：
    1. 两项都不存在 → `null`。
    2. 存在且为空的项 → `<NAME> must not be empty`；两项都存在且都为空时，一条消息同时列出两者：`DOCUMENT_SERVER_CONTAINER_NAME and DOCUMENT_SERVER_JWT_SECRET must not be empty`。空值不当作未配置。
    3. 只存在一项（非空）→ `DOCUMENT_SERVER_JWT_SECRET is required when DOCUMENT_SERVER_CONTAINER_NAME is set`，或反过来 `DOCUMENT_SERVER_CONTAINER_NAME is required when DOCUMENT_SERVER_JWT_SECRET is set`。
    4. 两项都非空：容器名沿用 `PLATFORM_CONTAINER_NAME` 的同一条 Docker 容器名规则（把现有 `parsePlatformContainerName` 改为带变量名参数的单一实现，两处共用，不复制正则），失败消息 `DOCUMENT_SERVER_CONTAINER_NAME must be a Docker container name, not an ID or path`；JWT 不做其他格式限制，原样保存（不 trim）。
  - 平台不为容器名提供默认值。`main.ts` 现有的「`loadConfig` 抛错即在监听前退出」路径不变，不新增启动步骤。
- **Auth / permissions / secrets（JWT）**：
  - `platform/src/app.ts` 的 `LOG_REDACT_PATHS` 按现有先例新增 `jwtSecret` 与 `*.jwtSecret`；`app.test.ts` 的顶层与嵌套脱敏用例各加一个 `jwtSecret` 标记，`toMatchObject` 的期望与随后遍历标记、断言日志不含这些值的循环（约 `:159-178`）都加上这两个标记。
  - 所有错误消息只含变量名；测试对每个失败用例断言消息不含所给取值（用带标记的取值，如 `jwt-marker-…`、`name-marker-…`）。
- **Config（示例文件与清单）**：
  - `.env.example` 在 `DOCUMENT_SERVER_JWT_SECRET=` 之前新增有效赋值 `DOCUMENT_SERVER_CONTAINER_NAME=dsh-team-documentserver`，注释写明取值与交付 compose 的字面量相同、compose 固定它而不读这一行；JWT 的注释改为「平台和 compose 都读取」。文件开头的复制说明新增一段：不经 compose 的本地运行（`pnpm dev`、`pnpm dev:bg`、`pnpm start`）原样复制会因空 JWT 在监听前失败，必须二选一——删去这两行（Office 不可用），或两项都填非空值。
  - `scripts/check-config.mjs`：`platformReads()` 同时接受配置模块中字面量的 `DOCUMENT_SERVER_*` 读取（非字面量或其他前缀仍报 `config.ts inventory requires literal PLATFORM_* or DOCUMENT_SERVER_* environment reads`）；`DOCUMENT_SERVER_*` 的已消费集合是平台读取与 compose 插值的并集，与示例文件双向比较；`PLATFORM_*` 只比平台读取，`DEPLOY_*` 只比 compose 插值。`scripts/test-guardrails.sh` 的动态读取用例的期望子串随消息更新，并新增一条「`config.ts` 字面量读取未列出的 `DOCUMENT_SERVER_UNDOCUMENTED` → `undocumented DOCUMENT_SERVER_UNDOCUMENTED`」。
- **Error handling / Legacy compatibility（入口）**：
  - 测试、e2e、UI 入口自己构造环境，不新增变量，落在「两项都不存在」，行为不变。阶段 1 留下的 `.env` 没有这两行，行为不变。
  - 交付的 compose 传入字面量容器名和非空 JWT（16.1），平台从此在 compose 部署里读到「已配置」；`test:deploy`、`test:stack` 不改行为，作为端到端证据。`platform/test/deployment-document-server.docker.test.ts` 中「The platform does not read either value yet」一句注释同 PR 改为「平台读到两项已配置并照常启动」。
- **测试**：
  - `platform/src/config.test.ts`：两项都不存在 → `documentServer: null`；都给非空值 → 原样返回，其中 JWT 用带首尾空格的标记，断言 `jwtSecret` 一字不差（不 trim）；只有容器名、只有 JWT、容器名为空、JWT 为空、两项都为空、只有一项且为空、容器名不合法（路径、64 位 hex ID）→ 每个失败用例都用 `toThrow('<固定的完整消息>')` 断言消息全文（几条消息同时含两个变量名，只断言含变量名区分不了规则），另断言消息不含所给取值；读取仓库真实 `.env.example`（`parseEnv`）：原样载入抛出完整消息 `DOCUMENT_SERVER_JWT_SECRET must not be empty`；删去两个键后 `documentServer` 为 `null`，并且除 `documentServer` 外所有字段都与「同一示例、JWT 填一个非空标记值」的载入结果相同。集成用例的 stderr 只断言含对应变量、不含取值，消息契约归单元测试。
  - `platform/test/subnet-startup.integration.test.ts`（或同目录新的 `document-server-startup.integration.test.ts`，复用 `observeStartup`）：真实源码进程在只有容器名、只有 JWT、容器名为空、JWT 为空、两项都为空时 `health` 为 `null`、退出码大于 0、stderr 含对应变量且不含所给取值；两项都不存在、两项都非空时照常提供 health 200。
  - 现有直接构造 `PlatformConfig` 字面量的测试补 `documentServer: null`（只改到通过类型检查为止）。
- **Documentation**（编排者同 PR 改）：AGENTS.md Environment 中 `lint:config` 一条改为三类（平台读取的 `PLATFORM_*`；只给 compose 的 `DEPLOY_*` 插值；平台读取与 compose 插值共用的 `DOCUMENT_SERVER_*`，其中 `DOCUMENT_SERVER_CONTAINER_NAME` 只计平台读取，`DOCUMENT_SERVER_JWT_SECRET` 两边都计）；「Copy it to `.env`」与本地运行说明写明不经 compose 时删去两行或两项都填，原样复制会在监听前失败；Compose 一节的「reading and validating both inputs belongs to task16.2a」改为实际行为。`constraints.yaml` 的 `configuration_inventory.description` 写入第三类。

not selected：Schema（无迁移、无接口，`schemas/openapi.json` 不变）、Concurrency、Resource limits、File IO（只读环境）、Release（无新依赖）、Public API（无路由变化）。无关键路径文件（不改 `platform/src/orchestrator/`）。

Governing invariant：平台进入监听时，Document Server 配置要么两项都不存在（未配置），要么两项都非空且容器名合法；任何错误消息、日志都不含 JWT 或容器名取值。

剩余风险：`DOCUMENT_SERVER_*` 按并集比较后，若交付的 compose 去掉 JWT 插值，`lint:config` 不会发现（平台读取仍算作已消费）；由 `deployment-document-server.docker.test.ts` 断言 JWT 到达平台、以及平台启动时拒绝「只有容器名」两处兜住。

Sibling surfaces：`platform/scripts/openapi.ts` 的 `PlatformConfig` 字面量（补 `documentServer: null`）、`platform/src/main.ts`（启动失败路径）、`platform/test/main-startup-fixture.ts`、`deployment-compose-fixture.ts`（compose 传给平台的两项，16.1）、`scripts/test-guardrails.sh` 的配置清单用例。

Evidence：`pnpm test`（config/app 单元）、`pnpm test:integration` 的启动用例、`pnpm lint:config`、`pnpm test:guardrails`、`pnpm lint:agents`、`pnpm check`；VPS exact-head `pnpm test:docker` 与 `pnpm test:deploy`（compose 部署下平台读到已配置并照常启动）；本机 exact-head `pnpm test:stack`。

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
