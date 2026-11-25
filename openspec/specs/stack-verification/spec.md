# stack-verification Specification

## Purpose

在开发机 arm64 上连接真实 RAGFlow 测试栈和 Document Server 的本机全栈验证通道，以及测试栈种子数据和证据规则；它补充而不替代 giap-vps 的 Docker 门禁。

## Requirements

### Requirement: 本机全栈验证命令

仓库 MUST 提供根脚本 `pnpm test:stack`。它在本机 Docker 上构建当前提交的平台镜像和用户镜像，用交付的 compose 拉起平台和 Document Server，连接已运行的本机 RAGFlow 测试栈，并运行知识库和 Office 的端到端接口与浏览器用例。前提缺失时 MUST 在创建任何资源前失败，不能跳过用例或降级为部分验证：包括非 macOS arm64 主机、本机 Docker 不可用、`docker info` 报告的 MemTotal 低于 14 GiB、私有配置文件缺失或权限不安全、RAGFlow 不可达或版本接口报告的版本不是 `v1.0.0-rc2`。

#### Scenario: 前提缺失时直接失败

- **WHEN** 私有配置文件不存在、本机 RAGFlow 测试栈未运行，或 `docker info` 报告的 MemTotal 低于 14 GiB
- **THEN** 命令以非零状态退出并说明缺失的前提，没有创建任何 Docker 资源

#### Scenario: 全栈用例通过

- **WHEN** 前提齐全，在一个已提交的干净检出上运行 `pnpm test:stack`
- **THEN** 知识库浏览、范围快照、检索来源、错误映射，以及 Office 编辑写回、跨用户攻击拒绝、旧格式预览的用例都在真实服务上执行并通过

### Requirement: 本机浏览器与确定性模型

本机通道的浏览器用例 MUST 使用仓库已钉定版本的 Playwright Chromium，经平台网关驱动真实 DSH。它是本机功能证据通道，MUST NOT 被当作 VPS 上隔离 CfT 浏览器通道的替代，也 MUST NOT 被引用为隔离证据。对话模型 MUST 是测试自有的确定性 provider，由它驱动工具调用、子 Agent 委派和写文件；本机通道 MUST NOT 调用外部模型。

#### Scenario: 浏览器经网关进入真实 DSH

- **WHEN** 本机通道的浏览器用例登录一个员工并打开工作台
- **THEN** 浏览器只访问平台对外地址，经网关加载真实 DSH 页面，截图留存且没有意外的控制台错误

#### Scenario: 不调用外部模型

- **WHEN** 一次 `pnpm test:stack` 运行结束，检查模型请求的去向
- **THEN** 所有模型请求都到达测试自有的确定性 provider，没有发往外部模型服务的请求

#### Scenario: 不作为隔离证据

- **WHEN** 一个 PR 需要隔离证据
- **THEN** 本机通道的结果不能替代 VPS 上 `pnpm test:docker` 的隔离用例

### Requirement: 私有配置与凭据不外泄

RAGFlow 地址、密钥和嵌入模型密钥 MUST 只从开发机上的私有配置文件 `~/.config/dsh-team/stack.json` 读取，该文件 MUST 归当前用户所有且权限为 0600，内容 MUST 是只含 `ragflowUrl`、`ragflowApiKey`、`embeddingApiKey` 三个键的 JSON 对象。`ragflowUrl` MUST 指向字面 loopback 主机（`127.0.0.1` 或 `[::1]`）；其他主机的配置 MUST 被拒绝，这是「只写本机测试栈」的机械保证。凭据 MUST NOT 出现在命令参数、仓库文件、日志、测试报告、截图或证据评论中。

#### Scenario: 权限不安全的配置被拒

- **WHEN** 私有配置文件对组或其他用户可读
- **THEN** 命令在读取内容之前失败，错误信息中没有文件内容

#### Scenario: 非 loopback 地址被拒

- **WHEN** 私有配置中的 `ragflowUrl` 指向 loopback 之外的主机
- **THEN** 命令在任何网络请求和资源创建之前失败，错误信息中没有该地址

#### Scenario: 报告中没有密钥

- **WHEN** 一次运行结束，检查全部输出、报告和截图文本
- **THEN** 其中不包含 RAGFlow 密钥或嵌入模型密钥

### Requirement: 测试栈种子数据规模受控

仓库 MUST 提供只对本机 RAGFlow 测试栈执行的种子脚本，建立固定的少量知识库和小文件，并完成解析。库名和文件名 MUST 由仓库固定给出，供后续用例核对。已存在且解析完成的数据 MUST 被复用，不能重复上传或重新解析。种子脚本 MUST 拒绝对私有配置之外的地址执行写操作。脚本 MUST NOT 指定嵌入模型（由测试栈的租户默认决定），MUST NOT 删除或更新任何已有数据集、文档或 chunk。解析失败时脚本 MUST 以非零状态结束并指出库和文件，不重试、不删除；输出中 MUST NOT 出现地址、密钥、文档或库的标识和响应体。

#### Scenario: 重复运行不重复解析

- **WHEN** 种子脚本第二次运行
- **THEN** 它识别已有的库和文件，不发起新的上传或解析请求

#### Scenario: 只写本机测试栈

- **WHEN** 种子脚本收到一个与私有配置不一致的 RAGFlow 地址
- **THEN** 脚本拒绝执行，不发出任何写请求

#### Scenario: 解析失败如实报告

- **WHEN** 某个种子文件在测试栈里解析失败
- **THEN** 脚本以非零状态结束，错误信息只指出库名和文件名，没有删除、重新上传或停止解析的请求

### Requirement: 本机资源自有并完整清理

本机通道创建的容器、网络、卷和镜像 MUST 使用 `dsh-team` 前缀和本次运行的标签，并在成功、断言失败和中途中断时只按精确所有权清理。它 MUST NOT 删除或修改 RAGFlow 测试栈本身的资源，也 MUST NOT 使用全局或前缀清理。

#### Scenario: 失败后不留自有资源

- **WHEN** 一个用例断言失败后命令结束
- **THEN** 本次运行创建的资源都已删除，RAGFlow 测试栈的容器和数据卷不变

### Requirement: 证据规则

涉及 RAGFlow 或 Office 的 PR 合并前，MUST 在 PR 中贴出该 PR 精确 head 上 `pnpm test:stack` 的证据评论：提交 SHA、命令、退出码、用例计数和清理结果。本机通道 MUST NOT 新增 CI 必需检查，也不改 workflow；giap-vps 的 `test:docker` 和 `test:deploy` 门禁不变。本机 arm64 的结果只作为功能证据，不代表 amd64 生产环境。

#### Scenario: 缺少本机证据不能合并

- **WHEN** 一个修改 `platform/src/ragflow-proxy/` 的 PR 没有对应 head 的本机证据评论
- **THEN** 该 PR 不满足合并条件

### Requirement: Office 全栈车道检验用另一实例密钥算出的 key

本机全栈 Office 车道 MUST 在员工 B 的实例内，用 B 自己的每实例密钥，为员工 A 的文件算出 key；只要这个 key 被接受，车道 MUST 失败。如果所有实例共用同一个密钥，每一项这样的检验 MUST 失败。

#### Scenario: 跨实例 key 的 Command Service 查询

- **WHEN** A 和 B 都在编辑同名 DOCX，车道向 Command Service 查询 B 的密钥为 A 的文件算出的 key
- **THEN** 这个 key 与 A 的 key 不同，Command Service 回答未知 key；如果 A 和 B 的密钥相同，这项检验失败

#### Scenario: 跨实例 key 的保存回调

- **WHEN** 隔离车道用 B 的密钥为 A 的文件算出的 key，向 A 发送保存回调
- **THEN** A 把它当作未知 key；如果 A 和 B 的密钥相同，这项检验失败

### Requirement: Office 空闲车道的保活不归因到编辑器

本机全栈 Office 空闲车道的保持断言证明的是：工作台和其中打开的编辑器一起，在空闲分钟数为 1 时保持实例运行。

- 它 MUST NOT 被表述为「编辑器的连接让实例保活」。
- 这是用户接受的残余（#657 C2，2026-11-23）。实测：只开工作台、不开编辑器，同样保持 210 秒，实例仍在运行，没有空闲停止，期间没有 Document Server 连接。
- 工作台自己的连接已经足以保活：两条 WebSocket（`/api/remote.mux`、`/sidebar/ws`）、一条 SSE（`/plugins/events`），以及约每秒一次的 `/sidebar/api` 请求。

#### Scenario: 只开工作台也保持运行

- **WHEN** 空闲分钟数为 1，员工只开着 DSH 工作台，没有打开编辑器，保持 210 秒
- **THEN** 实例保持运行，没有空闲停止审计，所以车道的保持断言不能区分保活来自编辑器还是工作台

### Requirement: Office 空闲车道恢复运行配置并先查字体

本机全栈 Office 空闲车道 MUST 在结束后把平台运行配置恢复到车道开始前的快照，并读回核对；车道 MUST 先完成字体检查，再修改空闲分钟数。

#### Scenario: 车道结束后运行配置复原

- **WHEN** 空闲车道把空闲分钟数改为 1，完成保活和空闲停止后结束
- **THEN** 读回的运行配置与车道开始前的快照完全一致

#### Scenario: 字体检查失败时不改运行配置

- **WHEN** 编辑器的字体列表缺少运营方字体，字体检查失败
- **THEN** 车道没有写运行配置，恢复函数仍为空操作

### Requirement: Office 车道按路径查注册表 key 只有一份并且格式不符时失败

本机全栈 Office 车道按路径读取插件注册表 key 时 MUST 共用同一份查询。

- 注册表文件尚不存在时，MUST 视为还没写入，返回空列表。
- 文件存在但不可读，或者不符合插件 0.2.0 的格式时，查询 MUST 以非零退出。查询自身的输出只报出失败种类，不带任何 key 或路径。
- 车道 MUST 以该错误失败，不得把它当作 0 个 key。

#### Scenario: 合法注册表

- **WHEN** `registry.json` 合法，含有多个路径的记录
- **THEN** 查询按文件顺序只返回 `entry.path` 等于给定路径的 key

#### Scenario: 注册表尚未写入

- **WHEN** 员工实例里还没有 `registry.json`
- **THEN** 查询返回空列表，车道继续在期限内轮询

#### Scenario: 注册表不可读或格式不符

- **WHEN** 出现以下任一情况：
  - `registry.json` 不可读；
  - 内容不是合法 JSON；
  - `version` 不是 1；
  - `entries` 缺失或不是列表；
  - 某条记录不是对象；
  - 某条记录的 `key` 不是非空字符串；
  - 某条记录的 `entry` 不是对象；
  - 某条记录的 `entry.path` 不是字符串
- **THEN** 查询以非零退出，标准输出为空，自身输出只含失败种类
- **AND** 车道以该错误失败

### Requirement: Office 改写车道的提示条断言有区分力

本机全栈 Office 改写车道的 `clean`、`unsaved` 两个情形：

- MUST 在 Agent 改写后，以会话超时为上界等待正向条件成立（编辑器刷新；`unsaved` 情形还要等「保存未写回文件」出现），并记录实测延迟；
- 正向条件之后，MUST 用固定窗口断言负向条件（不再刷新、不出现其他提示条）；
- `unsaved` 情形 MUST 证明该提示条在员工保存前一刻仍然显示；
- 两个情形 MUST 证明保存后提示条消失，并且在随后的固定窗口内没有任何提示条再出现。

#### Scenario: 提示条在保存前已经消失

- **WHEN** `unsaved` 情形的「保存未写回文件」在窗口内出现，但在员工保存前消失
- **THEN** 车道的事实与期望不符，用例失败

#### Scenario: 保存后提示条又出现

- **WHEN** 保存成功、提示条清掉之后，又有提示条出现
- **THEN** 车道的事实与期望不符，用例失败

#### Scenario: 刷新晚于固定窗口到达

- **WHEN** 编辑器的刷新在 Agent 改写后超过固定窗口、但在会话超时以内到达
- **THEN** 车道等到刷新，记录延迟，用例通过

#### Scenario: 刷新始终没有到达

- **WHEN** 会话超时以内编辑器都没有刷新
- **THEN** 车道记录未到达，事实与期望不符，用例失败

### Requirement: Office 改写车道覆盖 XLSX 与 PPTX

本机全栈 Office 改写车道除两个 DOCX 情形外，还 MUST 各有一个 XLSX、一个 PPTX 的干净改写情形：

- 初始文件取自 Document Server 自带的空白模板；
- Agent 的 `bash` 只用 Python 标准库 `zipfile` 原地改写其中一个 XML 部件，不改用户镜像；
- 断言的事实与 DOCX 干净情形一致：提示条、刷新次数、改写后/保存后/关闭后文件里各方的 nonce、`/data/work` 条目、允许的错误和 forgotten 副本；
- 锚点找不到或出现不止一次时，改写 MUST 以非零退出，且文件字节不变。

#### Scenario: 打开的 XLSX 被 Agent 改写

- **WHEN** 员工打开空白模板复制出的 `干净改写.xlsx`，Agent 改写它，员工随后键入并保存
- **THEN** 编辑器刷新一次，没有提示条；改写后文件只有 Agent 的 nonce，保存后和关闭后两方的 nonce 都在，`/data/work` 没有副本

#### Scenario: 打开的 PPTX 被 Agent 改写

- **WHEN** 员工打开空白模板复制出的 `干净改写.pptx`，Agent 改写它，员工随后键入并保存
- **THEN** 事实与 XLSX 情形、DOCX 干净情形相同

#### Scenario: 改写锚点不唯一

- **WHEN** 要改写的部件里锚点不存在或出现两次
- **THEN** 改写脚本非零退出，文件字节不变

### Requirement: 同名 DOCX 失败给出每一侧的原因

编辑器车道的同名 DOCX 情形中，A、B 两个编辑会话同时进行。任一侧失败时，抛出错误的消息 SHALL 依次给出每个失败侧的标签（`A` 或 `B`）和该侧经过脱敏的失败原因链，只列出失败的一侧。消息 SHALL NOT 含有文档 key 或 URL 查询串。错误 SHALL 仍是 `AggregateError`，`errors` 保留每个失败侧原始的失败，A 在前。

#### Scenario: 两侧都失败

- **WHEN** A、B 两个编辑会话都因带 `/doc/<key>/c/` 路径和查询串的错误失败
- **THEN** 抛出错误的消息依次给出 `A:` 和 `B:` 各自脱敏后的失败原因
- **AND** 该错误的消息和全部自有属性中都不出现 key 和查询串

#### Scenario: 只有一侧失败

- **WHEN** A 的会话成功，B 的会话失败
- **THEN** 消息只给出 `B:` 和它脱敏后的失败原因

### Requirement: Stack workbench failures carry no document key or query

本机全栈车道的浏览器会话失败，在 vitest 会打印的任何位置，都 SHALL NOT 出现文档 key 或 URL 查询串。这里的位置包括：

- 错误消息；
- 全部自有属性；
- 编辑器、改写和提示车道中失败匹配器的 diff。

失败消息 SHALL 仍然给出会话标签、计数和经过脱敏的失败原因，并且保持可读。仓库 SHALL 只保留一份脱敏实现。Office 车道成功 evidence 行中的会话证据 SHALL 只以计数，或经该实现脱敏的列表形式出现。

#### Scenario: Office 会话因 Document Server socket 错误失败

- **WHEN** 编辑器、改写或提示车道的会话失败，并且会话的 console 错误、失败请求和 ≥400 响应中带有 `/doc/<key>/c/` 路径和带查询串的 URL
- **THEN** 抛出的错误的消息和全部自有属性中都不出现该 key 和查询串
- **AND** 消息仍然给出会话标签、计数和可读的脱敏失败原因

#### Scenario: 失败诊断保持可读

- **WHEN** 失败原因中含有 `#id` 定位器、焦点描述或 `ERR_*` 网络错误码
- **THEN** 脱敏后这些内容仍然保留

### Requirement: Office session screenshots mask the save-error notice

本机全栈车道里，会出现「保存未写回文件」提示条的 Office 浏览器会话（改写车道的 `clean`、`unsaved` 和 `typing` 用例，forgotten 车道的 edit 会话），其所有截图（包括失败截图）SHALL 遮罩该提示条。提示条显示的是插件 staleness guard 的原文，带有文档 key，截图像素中 SHALL NOT 留下这段文字。stack fixture 代码中的提示条文本 SHALL 只有一份定义。

#### Scenario: 改写会话截图遮罩提示条

- **WHEN** 改写车道的 `clean` 或 `unsaved` 用例打开编辑会话
- **THEN** 传给会话的截图遮罩里含有「保存未写回文件」提示条文本

#### Scenario: forgotten edit 会话截图遮罩提示条

- **WHEN** forgotten 车道打开刻意让保存被拒的 edit 会话
- **THEN** 传给会话的截图遮罩里含有「保存未写回文件」提示条文本

### Requirement: Document Server 的 unload 违规按来源放行

本机全栈车道的浏览器会话中，控制台消息 `Permissions policy violation: unload is not allowed in this document.` SHALL 只在同时满足以下三个条件时放行：

- 来源在平台自身的 origin 上；
- 路径是 Document Server 9.4.0 挂载点下已实测的脚本之一：三个编辑器的 `Main.js`、`sdkjs/cell/sdk-all.js`、`sdkjs-plugins/v1/plugins.js`；
- 行号是该脚本已实测的行号。

放行的报告 SHALL NOT 计入 `consoleErrors`，SHALL 以 `<脚本路径>:<行号>` 记入该会话的 `unloadViolations`，不限次数。其他来源、行号或版本的同文本消息 SHALL 仍计入 `consoleErrors`，由各车道原有的精确白名单拒绝。这是用户在 #671 的决定（2026-11-23）。

#### Scenario: 已实测来源的违规被放行并记录

- **WHEN** Document Server 9.4.0 的 DOCX 编辑器在 `documenteditor/main/app/controller/Main.js` 的已实测行号上报告这条违规
- **THEN** 该会话的 `consoleErrors` 不含它
- **AND** `unloadViolations` 记录它的来源

#### Scenario: 未知来源的同文本违规被拒绝

- **WHEN** 同一文本来自其他脚本、其他行号、其他版本或其他 origin
- **THEN** 它计入 `consoleErrors`，车道原有的白名单使车道失败

#### Scenario: Chromium 153 下没有放行

- **WHEN** 浏览器不报告这条违规
- **THEN** 每个会话的 `unloadViolations` 为空，车道行为与之前一致

### Requirement: A stack session failure folds each cause once

When an Office stack session failure wraps a stack workbench failure, the cause-chain part of its message SHALL contain each cause's message exactly once.

#### Scenario: A forgotten-lane failure wraps a workbench failure

- **WHEN** an Office forgotten lane failure is built from a workbench failure whose cause is a locator timeout
- **AND** neither the scene nor the evidence lists contain that timeout text
- **THEN** the timeout message appears exactly once in the resulting message

### Requirement: Office stack double failures report every scrubbed cause and hold nothing raw

This requirement covers three cases:

- an Office stack lane fails and its retirement then also fails;
- a stack workbench session fails and its browser close then also fails;
- the browser close alone fails.

In each case the thrown error's message SHALL carry the scrubbed text of every cause, including the members of an aggregate error, with each reason printed once. The thrown error SHALL NOT be an aggregate error. Neither it nor any of its own properties, its cause or its members SHALL hold unscrubbed text. A workbench session failure SHALL remain a workbench failure that keeps its scrubbed evidence lists. One scrub implementation SHALL produce these texts.

#### Scenario: Lane and retirement both fail

- **WHEN** an editor, forgotten, external or idle lane fails with a message containing a document key
- **AND** its retirement also fails with a message containing a document key
- **THEN** the report shows both reasons with the keys redacted
- **AND** no property of the thrown error holds a raw key

#### Scenario: Session and browser close both fail

- **WHEN** a workbench session fails and closing its browser fails too
- **THEN** the error is still a workbench failure with its scrubbed evidence
- **AND** its message shows both scrubbed reasons

#### Scenario: Only the browser close fails

- **WHEN** the session succeeds and closing its browser fails with a document key in its message
- **THEN** the thrown error carries the reason with the key redacted

### Requirement: Stack test child input never raises an uncaught pipe error

Integration tests that write input to a child process SHALL tolerate the child exiting without reading. An `EPIPE` on stdin SHALL be ignored, and any other stdin error SHALL fail the test.

#### Scenario: The child exits without reading

- **WHEN** a child process exits before reading a large input
- **THEN** no uncaught error is raised and the test file's run exits 0

### Requirement: Masked Office sessions require a Chinese UI

An Office stack session that masks the save-error notice SHALL wait on the DSH page, before its body runs, until the document language is Chinese. If the language never becomes Chinese, the session SHALL fail with a named reason and SHALL take no screenshot of the DSH page, failure screenshot included.

#### Scenario: Non-Chinese UI

- **WHEN** a masked session's DSH page keeps a non-Chinese document language
- **THEN** the session fails with a named reason and takes no screenshot of the DSH page

### Requirement: The forgotten lane's evidence lists its allowed unload sources

The forgotten lane's success evidence SHALL include the scrubbed allowed `unload` violation sources of its edit and recover sessions, so they reach the stack evidence line.

#### Scenario: Allowed violation in the forgotten lane

- **WHEN** a forgotten-lane session records an allowed unload violation
- **THEN** its `<script path>:<line>` source appears in the lane's evidence under that session

### Requirement: The stack case timeout covers every serial opening wait

The local full-stack ledger SHALL count every execution of the Office editor opening and typing helpers at the bounds of their serial waits, including each caller's `loaded` hook, multiplied by its execution count. The case timeout SHALL include that sum. A stalled opening wait SHALL therefore fail with its own label before the case timeout, and the RAGFlow restore SHALL still run. Other lane waits stay in the ledger's margin.

#### Scenario: Every opening wait runs to its bound

- **WHEN** every serial wait of every Office editor opening and typing execution runs until just under its bound
- **THEN** the case timeout has not yet fired

### Requirement: The typing rewrite case holds a quiet window

After its notices clear, the Office rewrite lane's typing case SHALL first read its notice facts, including the notice times and the latch since typing began, then re-arm the notice latch and observe a fixed quiet window, as the clean and unsaved cases do. A notice appearing in that window SHALL fail the case.

#### Scenario: A notice returns after the clear

- **WHEN** a notice appears within the quiet window after the typing case's notices cleared
- **THEN** the case's facts differ from the expectation and the case fails

### Requirement: The forgotten-store diagnostic tolerates a vanishing entry

The forgotten-store shape diagnostic SHALL treat an entry that disappears between listing and inspection as absent, report the remaining entries, and SHALL NOT fail because of that disappearance. Other inspection errors SHALL still fail it.

#### Scenario: An entry vanishes mid-scan

- **WHEN** a store entry is deleted after the store is listed and before it is inspected
- **THEN** the diagnostic succeeds and reports the other entries
