## Purpose

员工在工作台内在线编辑 DOCX、XLSX、PPTX 并写回原文件，旧格式只读预览，文件区可下载；Document Server 随交付部署并只经实例网络访问，文件取用和保存回调都绑定到正确的用户和文件。

## ADDED Requirements

### Requirement: Office 文件在线编辑并写回原文件

员工在文件区打开 DOCX、XLSX、PPTX 时，MUST 进入 Document Server 编辑器。保存后 MUST 写回员工工作目录中的原文件，不产生副本；之后 Agent 读取该文件 MUST 得到保存后的内容。

#### Scenario: 编辑 DOCX 后 Agent 读到最新内容

- **WHEN** 员工在编辑器中给 `报告.docx` 加一段文字并保存，然后让 Agent 读取该文件
- **THEN** 工作目录中原文件已更新，Agent 读到新加的文字

#### Scenario: XLSX 和 PPTX 同样写回

- **WHEN** 员工分别编辑并保存一个 XLSX 和一个 PPTX
- **THEN** 两个原文件都被更新，可以重新打开并看到修改

### Requirement: 文档标识和回调绑定到正确的用户和文件

每个编辑会话的文档标识、取文件地址和保存回调 MUST 绑定到发起编辑的实例和文件。两个用户的同名文件 MUST 互不串写。取文件令牌 MUST 由每个实例单独的密钥签发，缺少该密钥时 MUST 拒绝签发和校验。文档标识 MUST 由同一个每实例密钥对原标识输入做 HMAC 得到，知道实例地址和文件路径的人 MUST NOT 能推算；回调和编辑器打开 MUST 只接受本实例密钥派生的标识。

#### Scenario: 同名文件互不串写

- **WHEN** 员工 A 和 B 同时编辑各自工作目录中的 `计划.docx` 并保存
- **THEN** 两人的文件各自只包含自己的修改

#### Scenario: 伪造的取文件令牌被拒

- **WHEN** 员工 B 用公开常量或 B 自己实例的密钥，为 A 实例的文件构造取文件令牌，并让 Document Server 去取
- **THEN** A 实例拒绝该请求，A 的文件内容没有被读出

#### Scenario: 跨实例回调被拒

- **WHEN** 员工 B 向 A 实例的保存回调地址提交一个 B 的文档标识
- **THEN** A 实例拒绝该回调，A 的任何文件都没有被改写

#### Scenario: 猜测的文档标识被拒

- **WHEN** 员工 B 已知 A 实例的地址和某文件路径，以推算或猜测的文档标识向 A 的保存回调提交内容，或让编辑器以该标识打开 A 的文件
- **THEN** A 实例拒绝两种请求，A 的文件没有被改写或读出

#### Scenario: 密钥缺失时拒绝

- **WHEN** 实例启动时没有注入文件令牌密钥，随后直接请求该实例的取文件接口，或在界面打开 Office 文件
- **THEN** 取文件接口拒绝任何令牌，打开失败并给出明确提示，不使用任何默认密钥

### Requirement: Office 不可用时的退路

本次启动 Office 不可用时（自带 Document Server 未配置、容器缺失或身份不符、published-loopback 方式），ONLYOFFICE 插件 MUST NOT 在该实例中启用。员工打开 DOCX、XLSX、PPTX MUST 得到同一文件的只读预览，而不是空白页或无提示的失败；实例的其他功能 MUST 照常可用。

#### Scenario: 未配置 Document Server 时打开 DOCX

- **WHEN** 部署没有配置 Document Server，员工从文件区打开一个 DOCX
- **THEN** 员工看到该文件的只读预览，没有编辑器和保存入口，原文件不变，聊天和文件操作照常可用

### Requirement: 人机同时写入的提示

编辑器界面 MUST 显示提示：「请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。」系统 MUST NOT 加锁或合并，后写入的覆盖先写入的。

#### Scenario: 打开编辑器时可见提示

- **WHEN** 员工打开任意 Office 文件进行编辑
- **THEN** 编辑器界面中可以看到上述提示原文

### Requirement: 没有 Session 时的提示

编辑器要求当前有 Session。员工在没有选中 Session 时打开 Office 文件，MUST 看到中文提示说明需要先进入或新建一个 Session，而不是空白页或无提示的失败。

#### Scenario: 无 Session 打开 Office 文件

- **WHEN** 员工在没有任何 Session 的新实例中，从文件区打开一个 DOCX
- **THEN** 界面显示需要先新建或进入 Session 的中文提示，原文件不变

### Requirement: 编辑器打开时 Agent 改文件的表现

编辑器打开期间 Agent 改写同一文件时，系统的表现 MUST 被验证并写入员工文档：编辑器是否刷新到 Agent 写入的内容，或员工需要重新打开。无论哪种表现，员工随后保存时 MUST 遵守后写覆盖的规则，不产生副本。

#### Scenario: Agent 写入后员工可以看到新内容

- **WHEN** 员工打开 `总结.docx` 后，Agent 改写该文件，员工按文档说明刷新或重新打开编辑器
- **THEN** 编辑器显示 Agent 写入的内容

### Requirement: 旧格式只读预览与满员退路

DOC、XLS、PPT MUST 只能只读预览，不能编辑。Document Server 达到连接上限时，员工 MUST 看到明确的提示，并且可以退回到同一文件的只读预览。预览 MUST 在员工自己的实例内完成转换，不访问外部服务。

#### Scenario: 旧格式只读

- **WHEN** 员工在真实浏览器中分别打开 `旧报表.xls`、一个 DOC 和一个 PPT
- **THEN** 每个都显示只读预览，没有编辑和保存入口，原文件不变

#### Scenario: 满员时有提示和退路

- **WHEN** Document Server 已达到连接上限，员工再打开一个 DOCX
- **THEN** 员工看到「编辑服务已满」类的明确提示，并能查看该文件的只读预览

### Requirement: 文件区下载

文件区 MUST 提供下载入口，员工可以把工作目录中的单个文件或选中的多个文件打包下载。

#### Scenario: 打包下载

- **WHEN** 员工在文件区选中两个文件并选择打包下载
- **THEN** 浏览器得到一个包含这两个文件的压缩包，内容与工作目录中的文件一致

### Requirement: HTML 预览保持沙箱

HTML 文件预览 MUST 在受限沙箱中渲染。「关闭 HTML 预览沙箱」设置 MUST 由受管配置钉为关闭，员工不能修改。

#### Scenario: 员工不能关闭沙箱

- **WHEN** 员工在设置中查找 HTML 预览沙箱相关的开关
- **THEN** 该设置显示为受管锁定，状态为沙箱开启

### Requirement: Office 配置由受管配置决定

ONLYOFFICE 插件实际使用的 Document Server 地址、JWT 和实例地址 MUST 来自受管覆盖层，员工在自己 profile 中的改写 MUST NOT 生效。

#### Scenario: 员工改写 Office 配置不生效

- **WHEN** 员工在自己的 profile 中改写 ONLYOFFICE 插件的 Document Server 地址和 JWT 后重启实例
- **THEN** 实例实际使用的仍是覆盖层下发的地址和 JWT，编辑和保存照常

### Requirement: Document Server 字体与可达性

自带的 Document Server MUST 加载运营方提供的字体目录（只读挂载）。Document Server MUST 只经员工实例网络与实例通信，MUST NOT 发布宿主端口。员工浏览器 MUST 经平台网关和员工自己的实例同源加载编辑器，不直接访问 Document Server。

#### Scenario: 中文字体可用

- **WHEN** 员工打开一个使用运营方字体的 DOCX
- **THEN** 编辑器的字体列表包含该字体，文档按该字体显示

#### Scenario: 没有宿主端口

- **WHEN** 检查 Document Server 容器的端口发布
- **THEN** 没有任何宿主端口发布
