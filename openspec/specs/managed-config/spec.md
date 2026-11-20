# managed-config Specification

## Purpose

受管覆盖层是平台为每个实例生成、用户改不了的 DSH 配置。它统一模型、默认权限档、界面语言，并去掉联网工具。

## Requirements

### Requirement: 模型由管理员统一配置

管理员 MUST 能配置模型地址、密钥、可用模型清单和默认模型。清单里的每个模型 MUST 可以带一个上下文窗口大小。员工在实例里 MUST 只能看到并切换已配置的模型，不需要自己填任何密钥。

#### Scenario: 员工无需配置即可对话

- **WHEN** 管理员配置好模型后，新员工注册登录并发送一条需要写文件的任务
- **THEN** 任务用默认模型完成，文件真实出现在工作目录，员工全程没有输入过密钥
- **AND** 验收先确认唯一目标文件不存在，再独立读取该员工工作目录内文件的完整预期内容；测试驱动不得代替 Agent 创建文件，模型替身或完成文本不能代替真实工具调用

#### Scenario: 真实模型验收缺少密钥

- **WHEN** 执行 `pnpm test:model` 时没有非空 `DMXAPI_KEY`
- **THEN** 命令在创建 Docker 或浏览器资源之前非零退出并指出缺少 `DMXAPI_KEY`，不得跳过或回退到替身

#### Scenario: 受信任 CI 执行真实模型验收

- **WHEN** 操作者授权 CI 对确定的完整提交执行真实模型验收
- **THEN** CI 必须实际在 giap-vps 执行该提交的 `pnpm test:model`，模型密钥保留在 VPS，结果绑定提交与本次执行
- **AND** 非授权工作流、提交、过期身份或重放不得启动候选代码；成功、失败、取消和超时均须回收本次执行授权并核验清理，不能以人工发布证据替代 CI 执行
- **AND** CI 在发送执行身份前必须校验操作者预先信任的 VPS 主机密钥；候选进程被强制终止也必须独立停止并清理本次已登记资源和临时秘密文件，保留无关资源；未使用授权到期亦须失效并撤销

#### Scenario: 模型选择器只有已配置的模型

- **WHEN** 管理员配置了两个模型，员工打开模型选择器
- **THEN** 只看到这两个模型，默认选中管理员指定的默认模型

#### Scenario: 默认模型必须在清单内

- **WHEN** 管理员把默认模型设为清单里没有的名称
- **THEN** 平台拒绝保存并指出默认模型不在清单内

#### Scenario: 模型的上下文窗口

- **WHEN** 管理员为某个模型配置上下文窗口 500000 并重启实例
- **THEN** 实例里该模型生效的上下文窗口是 500000；没有配置上下文窗口的模型使用 DSH 的默认值

### Requirement: 模型未配置时不启动实例

模型地址、密钥、模型清单、默认模型任一项未配置时，平台 MUST NOT 启动任何实例，并 MUST NOT 把这种情况记为实例出错。

#### Scenario: 全新部署尚未配置模型

- **WHEN** 管理员尚未配置模型时员工打开工作台
- **THEN** 没有容器被创建，员工看到“管理员尚未完成模型配置”；管理员仍能登录后台完成配置，配置完成后员工重试即可启动

#### Scenario: 缺少任一模型配置项不生成文档

- **WHEN** 纯生成函数的模型地址、实际密钥可用性、模型清单或默认模型任一项缺失
- **THEN** 返回`outcome: unconfigured`且不含覆盖层文档，而不是空文档或实例错误
- **AND** 非空的密钥环境变量名不能代替实际密钥存在的显式事实；完整配置返回`outcome: configured`及原有完整覆盖层

### Requirement: 员工不能覆盖受管配置

员工在自己实例里做的任何设置修改 MUST NOT 改变受管覆盖层规定的值。

#### Scenario: 员工改默认模型或另加模型地址

- **WHEN** 员工在实例的设置里把默认模型改成别的，或添加另一个模型地址，然后实例重启
- **THEN** 生效的默认模型和可用模型仍然是管理员配置的

#### Scenario: 用户新增预设后重新生成受管策略

- **WHEN** 联网工具开关关闭时，用户持久化另一模型地址/默认模型，并新增带重命名嵌套联网组件的非默认预设，然后平台重新收集组成、生成覆盖层并重启实例
- **THEN** 实际生效地址/模型清单/默认模型仍为管理员值，每个实际预设都被完整覆盖且不含联网工具，其他插件及表达式语义保留
- **AND** 重启复用原状态，不以忽略用户文件、新建空状态或仅检查生成文本代替真实生效验证

#### Scenario: 用户可写插件副本不是策略权威

- **WHEN** 用户改写自己的中文插件patch副本，再生成覆盖层并重启
- **THEN** 覆盖层仍取自可信canonical artifact，实际中文/无公告策略保持，模型选择和通用设置仍可用

#### Scenario: 员工改写强制的插件状态和 Office 配置

- **WHEN** 员工在自己的 profile 中打开一个强制关的预装插件、关闭一个受管必启项、改写 ONLYOFFICE 插件的 Document Server 地址或 JWT、或改写插件安装源，然后实例重启
- **THEN** 实际生效的值仍是覆盖层规定的值

### Requirement: 模型不可用时明确报错

配置的模型不可用时，实例 MUST 向员工报错，MUST NOT 改用任何其他模型或地址。

#### Scenario: 模型地址不可达

- **WHEN** 模型地址不可达时员工发送一条消息
- **THEN** 员工看到明确的错误，没有任何请求发往别的模型地址

#### Scenario: 不可达受管模型不回退到员工地址

- **WHEN** 员工配置了一个可达的其他模型地址，受管覆盖层指定的模型地址拒绝连接，且员工在实际Session提交一条消息
- **THEN** 该消息对应的回合终止并向员工显示明确的模型连接错误，不能以启动、凭据或请求格式失败替代
- **AND** 已独立证明可达的员工地址在该尝试完成前没有收到模型请求，不以不可达的替身或提前结束观察证明零请求

### Requirement: 配置变更在下次启动时生效

受管配置的变更 MUST 在实例下次启动时生效，MUST NOT 打断正在运行的实例。管理员 MUST 能通过重启实例让变更立即生效。经覆盖层下发的设置包括模型、默认权限档、联网工具开关、预装插件的强制状态、插件安装源和仓库探测、Office 配置；它们都遵循本要求。RAGFlow 连接和检索参数不经覆盖层下发，不受本要求约束。

#### Scenario: 改模型清单

- **WHEN** 管理员在清单里增加一个模型，此时员工的实例正在运行
- **THEN** 该员工的模型选择器不变且任务不被打断；管理员重启该实例后，选择器里出现新增的模型

#### Scenario: 改插件目录或安装源

- **WHEN** 管理员把一个预装插件改为强制关，或修改安装源，此时员工的实例正在运行
- **THEN** 运行中的实例不变且任务不被打断；该实例下次启动后按新设置生效

#### Scenario: 保存回应中的运行实例快照

- **WHEN** 管理员成功保存模型配置或运行参数
- **THEN** 写接口在原安全配置回应中增加非负整数 `runningInstances`，表示本次保存时仍保持其启动配置的运行中实例数；启动中、已停止、出错和未创建的实例不计入
- **AND** 该值是保存时快照，不是持续更新的配置差异统计；相同内容再次保存也返回当次运行数，读取接口保持原契约
- **AND** 保存失败时不得返回成功快照或留下部分配置/审计；容量和空闲参数已有的即时读取行为不改变

### Requirement: 默认权限档由管理员设定

新 Session 的默认权限档 MUST 取自管理员的设定，初始值为 Yolo。

#### Scenario: 初始默认档

- **WHEN** 未改动设定时员工新建一个 Session
- **THEN** 该 Session 的权限档是 Yolo

#### Scenario: 管理员改默认档

- **WHEN** 管理员把默认档改为人工批准并重启实例，员工新建一个 Session
- **THEN** 该 Session 的权限档是人工批准

#### Scenario: 管理员选择 Auto 默认档

- **WHEN** 管理员把默认档改为 Auto 并重启实例，员工新建一个 Session
- **THEN** 该 Session 的权限档是 Auto，后续写文件或执行命令真实进入模型审查门禁
- **AND** 不能以发行版拒绝的 `defaultPreset: auto` 或没有执行门禁的标签替代

#### Scenario: 默认档变更保留既有 Session

- **WHEN** 管理员改变默认档并重启，员工恢复已有独立权限选择的 Session
- **THEN** 已有 Session 仍保留原选择，之后的新 Session 使用新默认
- **AND** 员工修改实例内默认设置不能覆盖管理员的默认档

### Requirement: 覆盖层整份生成

平台 MUST 以整份替换的方式写入覆盖层，写入中途失败 MUST NOT 留下不完整的文件。

#### Scenario: 写入被中断

- **WHEN** 生成覆盖层的过程在写入中途被终止
- **THEN** 实例下次启动读到的是上一份完整的覆盖层，或启动被平台阻止并报错，而不是一份残缺的文件

#### Scenario: 并发发布完整只读覆盖层

- **WHEN** 两次写入并发为同一合法用户发布不同完整文档
- **THEN** 目标最终是其中一份完整文档且权限为0444，观察不到混合内容，正常结束后各自临时文件均清理

#### Scenario: 用户标识不可成为路径输入

- **WHEN** 用户标识不是12位小写ASCII字母数字，例如含`../`
- **THEN** 写入在任何文件系统操作（包括只读检查）之前拒绝，既有覆盖层和其他用户文件不变

#### Scenario: 失败不破坏旧版本或链接目标

- **WHEN** 临时文件已写入部分内容后发生错误，或最终原子改名失败
- **THEN** 旧目标内容和权限不变，调用失败并清理本次拥有的临时文件
- **AND** 成功替换一个指向外部文件的目标符号链接时，只替换该目录项，不改写链接指向的文件

### Requirement: 密钥不出现在界面和日志里

模型密钥 MUST NOT 出现在任何返回给浏览器的内容里，也 MUST NOT 出现在平台日志和审计记录里。

#### Scenario: 后台读取模型配置

- **WHEN** 管理员打开模型配置页
- **THEN** 密钥栏只显示“已设置”或“未设置”，页面收到的数据里没有密钥原文

#### Scenario: 保存密钥后查日志

- **WHEN** 管理员保存新的密钥后，查看平台日志和审计记录
- **THEN** 其中没有该密钥的原文

#### Scenario: 模型配置接口的安全读写

- **WHEN** 当前管理员通过模型配置接口保存地址、密钥、模型清单和清单内的默认模型
- **THEN** 设置与不含密钥的审计原子提交，读取回应仅返回地址、模型清单、默认模型和密钥是否已设置；保存回应另含保存时的 `runningInstances` 运行实例数快照
- **AND** 省略密钥字段保留旧密钥，提交新的非空密钥替换旧密钥，空密钥被拒绝；回应不包含密钥的前缀或后缀

#### Scenario: 收取请求体期间管理员权限失效

- **WHEN** 请求已通过入口鉴权，但请求体收取完成前会话被撤销或管理员被降权
- **THEN** 提交前重新检查当前身份并返回401或403，不修改模型设置或写入成功审计

#### Scenario: 模型配置审计失败

- **WHEN** 模型配置写入的审计记录无法保存
- **THEN** 整次保存失败且原设置保留，回应和日志不包含请求密钥或底层异常内容

### Requirement: 纯生成受管覆盖层

生成函数 MUST 仅依据显式输入生成一个完整覆盖层文档，不执行文件、数据库或环境变量访问。模型密钥 MUST 仅由环境变量名引用。调用方 MUST 提供完整的预设组成、可信的 canonical 中文插件 patch 数据，以及每个强制态可管理 bundle 的 canonical patch 与其在组成中的出现情况；生成器 MUST NOT 自行复制另一套插件 patch 或读取用户可写文件作为策略。显式输入还包括：实例子网、上游方式（网络或 published-loopback）、联网工具开关、预装插件目录及各项的类别和管理员状态、插件安装源和仓库探测开关、本次启动的 Office 可用性与 Office 配置、平台端口。

#### Scenario: 模型和权限配置序列化

- **WHEN** 输入两个模型，其中一个指定contextWindow，并提供默认模型和管理员的`defaultPermissionTier`
- **THEN** 输出只有指定provider/模型及正确默认值，未指定的contextWindow字段保持缺省，且没有密钥原文；权限表来自平台唯一映射，`approval`、`auto`、`yolo`分别选择`approval`、`auto-review`、`danger-full-access`，同时生成完整三档表和权限插件必需依赖
- **AND** 生成器仍是纯函数；废弃的任意DSH权限表输入与orchestrator启动输入、全部生产/测试调用方一起移除，不保留透传旁路

#### Scenario: 每个输入预设移除联网工具

- **WHEN** 联网工具开关关闭，完整输入预设含任意标识及嵌套group中的DSH联网工具组件
- **THEN** 所有这些组件从输出预设组成中移除，其他插件、顺序和预设元数据保留，输入不被修改
- **AND** canonical中文插件patch随同一文档交付，不以无效locale配置键替代

#### Scenario: 相同输入得到相同文档

- **WHEN** 以完全相同的显式输入调用两次生成函数
- **THEN** 两次输出逐字节相同，且不访问文件、数据库或环境变量

### Requirement: Trusted retirement distinguishes observation failure from canonical host cleanup

The trusted operator SHALL distinguish transport/observation failure, host cleanup status and model execution status. Retirement MAY obtain one bounded canonical receipt for the same currently owned invocation when the initial observer did not produce a valid receipt. It SHALL NOT turn missing, malformed, unreachable, foreign or cleanup-failed evidence into cleanup success, retry model execution, extend existing deadlines or widen resource authority. The historical cause of an unclassified observation failure SHALL remain unknown.

#### Scenario: Failed observer precedes successful finalization

- **WHEN** the initial observer fails and the same owned invocation subsequently has a valid canonical receipt confirming completed host cleanup
- **THEN** recovery reads that canonical receipt through the bounded read-only path rather than reusing synthetic observer failure as the host result
- **AND** the failed observation remains independently recorded, while whole-invocation cleanup still requires all existing credential and ownership conditions

#### Scenario: Execution failure is independent of host cleanup

- **WHEN** a valid receipt confirms host cleanup but records nonzero execution exit
- **THEN** cleanup may complete and the exact owned admission lock may retire without converting failed model execution into success
- **AND** a valid receipt reporting cleanup failure still blocks retirement even if execution succeeded

#### Scenario: Observer process exit precedes complete stdout

- **WHEN** an observer exits while its bounded stdout still has pending receipt bytes
- **THEN** parsing waits for stream settlement and never treats a partial buffer at process exit as the complete receipt
- **AND** transport, output-bound, stream and parse failures retain explicit safe observation facts without storing raw output

#### Scenario: Canonical evidence remains unknown or invalid

- **WHEN** the bounded canonical read fails, is missing, exceeds its limit or has an invalid cleanup/exit/failure envelope
- **THEN** cleanup remains unconfirmed and the invocation's admission lock is retained
- **AND** there is no loop of receipt retries or new execution admission

#### Scenario: Current authority does not match

- **WHEN** current invocation ownership is foreign or cannot be confirmed, or the active lock belongs to another invocation
- **THEN** retirement does not remove that foreign or unconfirmed lock or derive cleanup authority from an old observer result

#### Scenario: Diagnostic custody

- **WHEN** observation and recovery receipts are retained after success or failure
- **THEN** only bounded classifications, process status/signal, elapsed time, byte counts, configured bounds and validated cleanup projections are persisted
- **AND** credentials, authorization contents, arbitrary error text and raw process output never enter diagnostics

### Requirement: Restricted model worker retains safe preparation phase evidence

The restricted real-model worker SHALL publish, before each of its admission, checkout, install, build and driver phases begins, a private atomic receipt naming that phase, and SHALL record when the phase ends whether it completed or failed together with only closed-set facts: exit status, signal and a failure category. The worker's execution result SHALL carry the last phase and category without changing its existing exit status semantics. These receipts SHALL NOT contain raw command output, arguments, environment, error text, credentials or proxy values, and SHALL NOT change admission, deadlines, cleanup, owner receipt parsing or provider authorization.

#### Scenario: Preparation command fails

- **WHEN** a checkout, install or build command exits nonzero, is signalled, times out, exceeds its output bound or fails to spawn
- **THEN** the phase receipt names that phase with state failed and the matching closed-set category, exit status and signal
- **AND** the execution result keeps exit status 1 and names the same phase and category

#### Scenario: Phase is interrupted after entry

- **WHEN** the worker is terminated while a phase is running
- **THEN** the retained phase receipt still names the entered phase, without claiming completion or failure category

#### Scenario: Diagnostic output never leaks

- **WHEN** a preparation command's arguments, stdout, stderr or thrown error contain a marker value
- **THEN** no phase, execution or final receipt contains that marker

#### Scenario: Existing receipt consumers remain compatible

- **WHEN** finalization and the trusted owner read execution and final receipts with or without phase facts
- **THEN** a valid receipt yields the same host cleanup and execution status as before, the final receipt keeps exactly its existing fields, and execution failure is never rewritten by cleanup success

#### Scenario: Malformed execution result fails closed

- **WHEN** finalization finds an execution result that is missing, not a private regular file, oversized, malformed or has an exit status outside 0..255
- **THEN** the final receipt records exit status 1 instead of throwing or copying the invalid value, and host cleanup status is still reported independently

### Requirement: Restricted model worker selects SHA-bound operator-uploaded images

The restricted real-model worker SHALL look for an operator-staged image mapping only at the host-local path named by the exact approved reviewed SHA, `~/.config/dsh-team/verification-images/<sha>.json`. When no entry exists there, the worker SHALL leave `DSH_TEAM_VERIFICATION_IMAGES` unset so native image acquisition is unchanged. When any entry exists, the worker SHALL pass that path as `DSH_TEAM_VERIFICATION_IMAGES` to the `pnpm test:model` driver child only, leaving content validation to the existing verification-image adapter, which fails closed without native fallback. The selection SHALL NOT reach checkout, install or build environments, SSH/systemd arguments, GitHub secrets, or phase, execution and final receipts. If the presence check itself fails for a reason other than absence, the driver phase SHALL fail before spawning the driver.

#### Scenario: Mapping staged for the approved SHA

- **WHEN** a mapping file exists at the approved SHA's host-local path
- **THEN** the driver's `pnpm test:model` environment contains exactly that path as `DSH_TEAM_VERIFICATION_IMAGES`
- **AND** checkout, install and build environments and all worker receipts do not contain it

#### Scenario: No mapping for the approved SHA

- **WHEN** the directory is absent or holds mappings only for other SHAs
- **THEN** the driver environment carries no `DSH_TEAM_VERIFICATION_IMAGES` and native acquisition runs as before

#### Scenario: Unsafe entry is not resolved by the worker

- **WHEN** the approved SHA's path is a symlink, directory or file with unsafe permissions
- **THEN** the worker passes the path unchanged and the existing adapter rejects it without native fallback

#### Scenario: Presence check fails

- **WHEN** checking the approved SHA's path fails for a reason other than absence
- **THEN** the driver phase is recorded as failed with category `unknown` and `pnpm test:model` is not started

### Requirement: 受管覆盖层启用平台入口插件

受管覆盖层 MUST 为每个员工实例插入并启用 `/opt/dsh-team/platform-nav/index.js`，其 `config` 恰为 `{ admin, pluginCatalog }`：`admin` 是生成覆盖层时该账号是否为管理员；`pluginCatalog` 以目录项包名为键、按目录文件顺序列出每个状态为 `forced-on` 或 `forced-off` 的目录项及其状态（受管必启项恒为 `forced-on`，`employee` 项不出现）。其他受管行及其顺序不变；实例启动后浏览器收到的启动模块清单 MUST 恰好包含该插件。平台入口插件 MUST 把这两个值发布给它的客户端半边，客户端半边据此在员工插件页把强制项显示为锁定（见 plugin-catalog「员工插件页每个预装项都有开关」）。

#### Scenario: 实例加载平台入口插件

- **WHEN** 员工实例按受管覆盖层启动并在真实浏览器中打开工作台
- **THEN** 启动模块清单与预期精确一致且包含 `@dsh-team/platform-nav`，侧栏底部出现平台入口，原有插件和受管设置不变
- **AND** 员工账号的覆盖层 `config.admin` 为 false，管理员账号为 true；直接打开 DSH 的验证通道仍无控制台错误

#### Scenario: 目录强制状态随平台入口行下发

- **WHEN** 目录设置为默认（三个受管必启项、办公 Agent bundle 为 `employee`），以及办公 Agent bundle 改为 `forced-off`
- **THEN** 前者的 `config.pluginCatalog` 恰为三个必启项包名各对 `forced-on`，后者在目录顺序上多出办公 Agent 包名对 `forced-off`；相同输入逐字节相同

### Requirement: 工作台页面资源压缩传输

受管覆盖层 MUST 为每个员工实例开启 DSH 自带 Web 服务的 gzip 压缩（`webserver` 行 `compression: gzip`，等级与阈值沿用 DSH 默认），不修改 DSH 源码。浏览器声明支持 gzip 时，经平台网关取得的工作台脚本 MUST 以 gzip 编码传输且解压后内容与未压缩响应一致；未声明时 MUST 得到未压缩内容。事件流和 WebSocket MUST 不受影响。

#### Scenario: 大脚本压缩传输

- **WHEN** 已登录员工的浏览器带 `Accept-Encoding: gzip` 经平台网关请求工作台首页引用的合并插件脚本
- **THEN** 响应带 `Content-Encoding: gzip`，解压后字节与带 `Accept-Encoding: identity` 请求同一地址得到的未压缩响应完全一致

#### Scenario: 事件流不压缩

- **WHEN** 浏览器经平台网关打开 `/plugins/events`
- **THEN** 响应为 `text/event-stream` 且没有 `Content-Encoding`，首个事件帧可直接解析为模块图

### Requirement: 实例 Web 服务监听实例固定地址

受管覆盖层的 `webserver` 行 MUST 把监听地址写为该实例在自己 /28 子网内的固定员工容器地址（子网基址 +2），端口保持 3080。覆盖层 MUST NOT 写入 `0.0.0.0`、`::` 或其他通配地址，因为 DSH 0.2.1-rc.2 拒绝通配监听地址。开发用的 published-loopback 模式同样写该实例自建 bridge 内的固定地址。

#### Scenario: 生成的监听地址是实例固定地址

- **WHEN** 生成函数收到编排器按该实例 /28 子网布局求出的员工容器固定地址（基址 +2）
- **THEN** 输出的 `webserver` 行 `host` 等于该地址，端口为 3080，文档中没有任何通配监听地址

#### Scenario: 非法地址输入被拒绝

- **WHEN** 生成函数收到的地址不是规范点分 IPv4、是通配地址，或不是任何对齐 /28 的基址 +2
- **THEN** 生成失败且不产出覆盖层文档，而不是退回通配地址

#### Scenario: 实例按固定地址启动

- **WHEN** 员工实例在 DSH 0.2.1-rc.2 上按该覆盖层启动
- **THEN** DSH Web 在固定地址的 3080 端口就绪，启动令牌行中的地址就是该固定地址，平台据此完成令牌交换

### Requirement: 联网工具默认关闭并由管理员开关控制

平台 MUST 提供一个管理员设置的联网工具开关，初始值为关闭。开关关闭时，每个实例里的每个预设，包括员工新增或改名的预设和嵌套 group，MUST NOT 包含联网搜索和网页抓取工具。开关打开时，覆盖层 MUST NOT 再移除这两个工具，各预设按其自身组成保留它们。开关的变化按“配置变更在下次启动时生效”生效。

#### Scenario: 默认没有联网工具

- **WHEN** 管理员从未改动联网工具开关，员工在任一预设下要求 Agent 搜索网页或抓取一个网址
- **THEN** Agent 实际生效的工具里没有这两项，无法执行

#### Scenario: 员工改名的联网工具也被去掉

- **WHEN** 开关关闭，员工在自己的 profile 中新增一个非默认预设，其嵌套 group 里含有改了 id 的联网工具组件，平台随后重新生成覆盖层并重启实例
- **THEN** 该预设实际生效时不含联网工具，其他插件和顺序保留

#### Scenario: 管理员为联网部署打开

- **WHEN** 管理员打开联网工具开关并重启某员工实例
- **THEN** 该实例里组成中带有联网工具的预设实际生效时包含这两项；未重启的实例保持原状

#### Scenario: 生成器按开关处理联网工具

- **WHEN** 输入的预设在顶层和嵌套 group 中以任意 id 含有联网工具组件，分别以开关关闭和打开调用生成函数
- **THEN** 关闭时输出预设中这些组件全部移除，打开时全部保留；两种情况下其他插件、顺序和预设元数据都保留，输入不被修改

### Requirement: 插件安装入口保留且安装源由管理员配置

覆盖层 MUST NOT 从任何预设中移除 DSH 插件管理工具，MUST NOT 钉死插件页的仓库探测。安装源列表和仓库探测开关始终受管：覆盖层 MUST 总是按管理员保存的值写出这两项。设置的初始值 MUST 等于 DSH 0.2.1-rc.2 的默认值（默认公共源列表、探测开启）；内网部署由管理员改为内网镜像或关闭探测。

#### Scenario: Agent 保留插件管理工具

- **WHEN** 员工在默认预设下要求 Agent 列出已安装的插件包
- **THEN** 实际生效的预设工具里有 `plugin_manager`，Agent 能执行该操作

#### Scenario: 内网部署指向内网安装源并关闭探测

- **WHEN** 管理员把安装源设为一个内网 npm 镜像地址、关闭仓库探测，然后员工实例重启
- **THEN** 该实例生效的插件安装源只有这个内网地址，插件页不主动探测公共仓库

#### Scenario: 生成器总是写出安装源和探测开关

- **WHEN** 分别以“初始设置（DSH 默认源、探测开启）”和“两个内网安装源、探测关闭”调用生成函数
- **THEN** 前者输出的安装源列表等于 DSH 默认源列表、仓库探测为开启；后者输出恰好包含这两个安装源（顺序不变）且仓库探测为关闭；两种情况下输出都含这两项，预设中的插件管理工具都保留

#### Scenario: 安装源写入 DSH 的两个配置键

- **WHEN** 以安装源列表 `[A, B, C]` 调用生成函数
- **THEN** 输出对插件管理器宿主行写入 `registry: A`、`fallbackRegistries: [B, C]`，对插件页行写入 `registryProbeEnabled`；两行都是整配置替换，值原样写出不做规范化；空列表被拒绝

### Requirement: 预装插件的强制状态经覆盖层下发

插件目录中的每一项属于两类之一。受管必启项（平台入口、权限档、中文界面、Office 提示）MUST 总是由覆盖层写为启用。可管理项按管理员设定的三态写入：`forced-on` 写为启用，`forced-off` 写为停用，`employee` MUST NOT 写入任何启用状态，由员工 profile 中来自镜像的默认值和员工自己的选择决定。ONLYOFFICE 插件例外：本次启动 Office 不可用时，覆盖层 MUST 把它写为停用，不论其目录状态。目录之外的插件 MUST NOT 被覆盖层写入启用状态。

#### Scenario: 强制关的插件员工打不开

- **WHEN** 管理员把一个可管理的预装插件设为 `forced-off` 并重启员工实例，员工在插件页尝试打开它
- **THEN** 该插件在实例里实际处于停用状态，重启实例后仍是停用

#### Scenario: 员工自选保留员工的选择

- **WHEN** 某预装插件为 `employee`，员工把它关掉并重启实例
- **THEN** 它仍是关闭；另一个从未改动它的员工看到的是镜像默认状态

#### Scenario: 生成器只写强制项和必启项

- **WHEN** 输入目录中有一个受管必启项，以及三个可管理项分别为 `employee`、`forced-on`、`forced-off`
- **THEN** 输出对必启项和 `forced-on` 项写为启用、对 `forced-off` 项写为停用，对 `employee` 项不写任何启用状态

#### Scenario: Office 不可用时 ONLYOFFICE 停用

- **WHEN** ONLYOFFICE 的目录状态为 `employee` 或 `forced-on`，而本次启动 Office 不可用
- **THEN** 输出把 ONLYOFFICE 写为停用，其他目录项的输出不变

#### Scenario: 强制开的 bundle 已被员工取消勾选

- **WHEN** 某可管理 bundle 为 `forced-on`，而观测到的组成中没有它规范 patch 插入的任何一行
- **THEN** 输出按原顺序写出该 bundle 规范 patch 的全部行，其中的预设条目经与观测预设相同的联网工具规则处理；若组成中只出现其中一部分行，读取器拒绝该组成，实例不启动

#### Scenario: profile 里目标不存在的行不阻止启动

- **WHEN** 员工 profile 或 home patch 里有一行，应用到该行时其 id 在此前的 bundle、profile、home 行组成中不存在（例如经 DSH 插件管理写出、指向覆盖层插入行的停用行），实例下次启动
- **THEN** 组成读取器按 DSH 语义跳过该行，实例照常启动，覆盖层状态不变；bundle 层的任何告警，以及 profile/home 层的 name mismatch、`patch insert` 目标不存在或不是 group、缺 id，以及 id 不是字符串的行，读取器仍拒绝该组成，实例不启动

#### Scenario: 强制关的 bundle 覆盖了默认预设

- **WHEN** 某可管理 bundle 为 `forced-off`，其规范 patch 把预设注册表的默认预设改为它自己的预设，分别以它在观测组成中存在和缺席调用生成函数
- **THEN** 两种情况输出相同：对它插入的每一行写为停用、这些预设不再整行写出，并把预设注册表的默认预设还原为 DSH 发行默认 `standard`，使员工运行中勾选它时这些行立即生效；规范 patch 若覆盖了别的行，生成器拒绝

#### Scenario: 必启项状态异常或强制项无法激活

- **WHEN** 输入目录中某受管必启项的状态不是 `forced-on`，或某可管理项处于强制态而其规范 patch 没有任何行
- **THEN** 生成函数抛出错误，不产出覆盖层

### Requirement: Office 插件配置经覆盖层下发

本次启动 Office 可用时，覆盖层 MUST 为 ONLYOFFICE 侧栏插件写入以下配置：

- Document Server 地址：使用自带 Document Server 时为该实例子网内的 Document Server 固定地址（基址 +4），使用外部 Document Server 时为管理员配置的地址；
- 实例内部地址：该实例的固定员工容器地址加 3080 端口；
- 对外地址：平台对外地址；
- Document Server 的 JWT 密钥。

Office 可用是指：使用外部 Document Server 且地址和 JWT 已配置；或使用自带 Document Server、部署配置齐全、且本次启动已把它接入该实例网络。其他情况（自带未配置、容器不存在或身份不符、published-loopback 方式）MUST 视为不可用：覆盖层 MUST NOT 写出任何 Office 配置，ONLYOFFICE 插件在该实例中不启用，模型、权限和其他受管行保持完整。

#### Scenario: 自带 Document Server

- **WHEN** 部署使用自带 Document Server，且本次启动已把它接入实例网络，平台为该实例生成覆盖层
- **THEN** ONLYOFFICE 插件的 Document Server 地址是该实例子网基址 +4，内部地址是基址 +2 的 3080 端口，对外地址等于平台对外地址，JWT 与部署配置一致

#### Scenario: 外部 Document Server

- **WHEN** 管理员改用外部 Document Server 地址和 JWT，并重启员工实例
- **THEN** 该实例的 ONLYOFFICE 插件使用管理员配置的地址和 JWT；未重启的实例保持原配置

#### Scenario: Office 不可用

- **WHEN** 既没有自带 Document Server 的配置，也没有外部 Document Server 的配置；或自带 Document Server 本次没有接入；或实例以 published-loopback 方式启动
- **THEN** 生成的覆盖层中没有 Office 配置，ONLYOFFICE 插件不启用，模型、权限和其他受管行保持完整

### Requirement: 知识库插件取得平台地址

覆盖层 MUST 只给知识库插件一个平台地址：该实例子网内平台的固定地址（基址 +3）加平台监听端口。知识库插件的启用状态 MUST 完全服从插件目录的三态，覆盖层 MUST NOT 另行启用它。published-loopback 方式下覆盖层 MUST NOT 给出平台地址，知识库在该实例不可用。覆盖层 MUST NOT 包含 RAGFlow 地址、RAGFlow 密钥或检索参数。

#### Scenario: 覆盖层中的知识库配置

- **WHEN** 平台以网络方式为某实例生成覆盖层
- **THEN** 知识库插件的配置只有平台地址且等于该实例子网基址 +3 加平台端口；文档中没有 RAGFlow 地址、密钥或检索参数

#### Scenario: 启用状态服从目录

- **WHEN** 知识库的目录状态分别为 `employee`、`forced-on`、`forced-off` 时生成覆盖层
- **THEN** 前者不写启用状态，后两者分别写为启用和停用；三种情况下平台地址配置相同

#### Scenario: 回环方式不给平台地址

- **WHEN** 平台以 published-loopback 方式为某实例生成覆盖层
- **THEN** 覆盖层中没有知识库的平台地址

### Requirement: 受管模型密钥优先于员工凭据

对受管模型，实例 MUST 始终使用平台注入的模型密钥。员工在自己状态目录的凭据文件里为同一模型地址或 provider 写入的任何密钥 MUST NOT 生效，即使 DSH 0.2.1-rc.2 中凭据文件的优先级高于环境变量。

#### Scenario: 员工在凭据文件中写入别的密钥

- **WHEN** 员工在自己的凭据文件中为受管 provider 写入另一个密钥，重启实例后发送一条消息
- **THEN** 一个确定性的自有模型服务观察到的 Authorization 头对应平台密钥，而不是员工写入的密钥
- **AND** 该验证在真实 Docker 中用真实 DSH 运行，不以检查生成文本代替

### Requirement: 受管行为在 DSH 0.2.1-rc.2 上保持

DSH 升级到 0.2.1-rc.2 后，本能力既有的受管行为 MUST 保持不变，包括：模型清单和默认模型、模型未配置不启动、员工不能覆盖、模型不可用不回退、默认权限档、整份写入、密钥不外露、平台入口插件和页面资源压缩。DSH 0.2.1 新增的预设行和 bundle MUST 与覆盖层逐项核对，确认不会绕过上述受管值。

#### Scenario: 升级后全量重跑

- **WHEN** 对 DSH 升级的精确提交执行完整的 `pnpm test:docker` 和 `pnpm test:deploy`，并经单独授权执行 `pnpm test:model`
- **THEN** 本能力的既有验收全部通过，没有被跳过或放宽的用例
