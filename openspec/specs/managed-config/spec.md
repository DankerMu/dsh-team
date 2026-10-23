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

- **WHEN** 用户持久化另一模型地址/默认模型，并新增带重命名嵌套联网组件的非默认预设，然后平台重新收集组成、生成覆盖层并重启实例
- **THEN** 实际生效地址/模型清单/默认模型仍为管理员值，每个实际预设都被完整覆盖且不含联网工具，其他插件及表达式语义保留
- **AND** 重启复用原状态，不以忽略用户文件、新建空状态或仅检查生成文本代替真实生效验证

#### Scenario: 用户可写插件副本不是策略权威

- **WHEN** 用户改写自己的中文插件patch副本，再生成覆盖层并重启
- **THEN** 覆盖层仍取自可信canonical artifact，实际中文/无公告策略保持，模型选择和通用设置仍可用

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

受管配置的变更 MUST 在实例下次启动时生效，MUST NOT 打断正在运行的实例。管理员 MUST 能通过重启实例让变更立即生效。

#### Scenario: 改模型清单

- **WHEN** 管理员在清单里增加一个模型，此时员工的实例正在运行
- **THEN** 该员工的模型选择器不变且任务不被打断；管理员重启该实例后，选择器里出现新增的模型

#### Scenario: 保存回应中的运行实例快照

- **WHEN** 管理员成功保存模型配置或运行参数
- **THEN** 写接口在原安全配置回应中增加非负整数 `runningInstances`，表示本次保存时仍保持其启动配置的运行中实例数；启动中、已停止、出错和未创建的实例不计入
- **AND** 该值是保存时快照，不是持续更新的配置差异统计；相同内容再次保存也返回当次运行数，读取接口保持原契约
- **AND** 保存失败时不得返回成功快照或留下部分配置/审计；容量和空闲参数已有的即时读取行为不改变

### Requirement: 去掉联网工具

每个实例里的每个预设 MUST NOT 包含联网搜索和网页抓取工具。

#### Scenario: Agent 没有联网工具

- **WHEN** 员工在任一预设下要求 Agent 搜索网页或抓取一个网址
- **THEN** Agent 的可用工具里没有这两项，无法执行

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

生成函数 MUST 仅依据显式输入生成一个完整覆盖层文档，不执行文件、数据库或环境变量访问。模型密钥 MUST 仅由环境变量名引用。调用方 MUST 提供完整的预设组成和可信的 canonical 中文插件 patch 数据；生成器 MUST NOT 自行复制另一套插件 patch 或读取用户可写文件作为策略。

#### Scenario: 模型和权限配置序列化

- **WHEN** 输入两个模型，其中一个指定contextWindow，并提供默认模型和管理员的`defaultPermissionTier`
- **THEN** 输出只有指定provider/模型及正确默认值，未指定的contextWindow字段保持缺省，且没有密钥原文；权限表来自平台唯一映射，`approval`、`auto`、`yolo`分别选择`approval`、`auto-review`、`danger-full-access`，同时生成完整三档表和权限插件必需依赖
- **AND** 生成器仍是纯函数；废弃的任意DSH权限表输入与orchestrator启动输入、全部生产/测试调用方一起移除，不保留透传旁路

#### Scenario: 每个输入预设移除联网工具

- **WHEN** 完整输入预设含任意标识及嵌套group中的DSH联网工具组件
- **THEN** 所有这些组件从输出预设组成中移除，其他插件、顺序和预设元数据保留，输入不被修改
- **AND** canonical中文插件patch随同一文档交付，不以无效locale配置键替代

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
