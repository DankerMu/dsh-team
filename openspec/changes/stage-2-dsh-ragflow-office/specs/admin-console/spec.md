## ADDED Requirements

### Requirement: RAGFlow 连接配置页

后台 MUST 提供 RAGFlow 地址和密钥的编辑页，接口为 `GET/PUT /_platform/api/admin/ragflow-config`，保存写入 `ragflow-config.updated` 审计。密钥 MUST 只保存在平台，接口和页面 MUST 只显示“已配置”状态，MUST NOT 回显密钥原文。保存 MUST 立即生效：平台代理此后的每次请求都使用新配置，不需要重启实例。

#### Scenario: 保存后立即生效

- **WHEN** 管理员把 RAGFlow 地址改为另一套可用的服务并保存，随后员工在已运行的实例里刷新知识库列表
- **THEN** 员工看到新服务的知识库，实例没有被重启

#### Scenario: 密钥只显示已配置

- **WHEN** 管理员填写密钥保存后再次打开页面，或读取配置接口
- **THEN** 只看到“已配置”，回应和页面中没有密钥原文；留空密钥输入保留已存密钥，空白值被拒绝

#### Scenario: 测试连接

- **WHEN** 管理员点击“测试连接”，即请求 `POST /_platform/api/admin/ragflow-config/test`
- **THEN** 平台只调用 RAGFlow 的版本查询接口，不写审计，结果为 `ok`，或与代理相同的失败取值之一：`not-configured`（未配置或密钥被拒）、`unavailable`（地址不可达）、`timeout`、`upstream-error`（返回异常），页面为每个取值显示不同的中文说明；按响应体中的业务代码判定成败，HTTP 200 加非零业务代码不算成功
- **AND** 回应、日志和审计不含密钥、上游回应体或完整地址

#### Scenario: 未配置时员工侧明确提示

- **WHEN** 尚未配置 RAGFlow 时员工打开知识库面板
- **THEN** 代理返回 `not-configured`，面板显示“知识库未配置”，不显示空列表

### Requirement: 检索参数配置

后台 MUST 提供检索参数的编辑：返回片段数、相似度阈值、关键词权重和是否启用重排序。接口为 `GET/PUT /_platform/api/admin/retrieval-config`，保存写入 `retrieval-config.updated` 审计。这些参数 MUST 只能由管理员修改，MUST 在平台代理处应用，保存后立即对之后的检索生效；员工和插件都不能调整。

#### Scenario: 参数校验

- **WHEN** 管理员把返回片段数设为 0、把相似度阈值设为超出 0 到 1 的值，或提交非数字
- **THEN** 平台拒绝保存并指出取值范围，原参数不变

#### Scenario: 修改后下一次检索生效

- **WHEN** 管理员把返回片段数从 8 改为 3 并保存，随后员工发起一次检索
- **THEN** 该次检索最多返回 3 个片段，实例没有被重启

#### Scenario: 员工请求不能覆盖参数

- **WHEN** 实例发给平台代理的检索请求里附带了返回片段数或阈值字段
- **THEN** 平台拒绝为 `invalid-request`，不访问 RAGFlow；管理员配置的参数不变

### Requirement: 插件目录页

后台 MUST 列出镜像预装的全部插件和插件包，接口为 `GET/PUT /_platform/api/admin/plugin-catalog`，保存写入 `plugin-catalog.updated` 审计。受管必启项 MUST 显示为“强制开”且不可修改。每个可管理项 MUST 可设为“员工自选”“强制开”或“强制关”之一（机器取值 `employee`、`forced-on`、`forced-off`）。“员工自选”时启用状态的默认值随镜像，员工可以自己开关；“强制开”和“强制关”经受管配置下发，员工侧显示为锁定。Office 不可用时，ONLYOFFICE 一项 MUST 显示其在实例中停用的原因。修改 MUST 在实例下次启动时生效，页面 MUST 写明这一点。

#### Scenario: 列表与镜像目录一致

- **WHEN** 管理员打开插件目录页
- **THEN** 列出的条目与镜像随附的目录文件一致，每项显示中文名、当前状态和镜像默认值

#### Scenario: 强制关闭后下次启动生效

- **WHEN** 管理员把某个预装插件设为“强制关”，某员工随后重启实例
- **THEN** 该员工插件页里这一项显示为关闭且不可切换；重启前已运行的其他实例不受影响，直到它们下次启动

#### Scenario: 非法状态被拒绝

- **WHEN** 提交的条目不在目录中，状态不是三种之一，或把受管必启项设为 `forced-on` 以外的状态
- **THEN** 平台返回 400，原设置和审计不变

### Requirement: 插件安装源与仓库探测

后台 MUST 允许管理员把插件安装源列表和是否开启仓库探测作为一个保存单元配置，接口为 `GET/PUT /_platform/api/admin/plugin-sources`，保存写入 `plugin-sources.updated` 审计。初始值 MUST 等于 DSH 0.2.1-rc.2 的默认值（默认公共源列表、探测开启）。两项经受管配置下发，在实例下次启动时生效。

#### Scenario: 内网部署关闭探测并填写内网源

- **WHEN** 管理员填入一个内网安装源、关闭仓库探测并保存，员工随后重启实例
- **THEN** 员工插件页安装插件时只使用该安装源，DSH 不向默认公共仓库发起探测

#### Scenario: 初始值等于 DSH 默认

- **WHEN** 全新部署的管理员第一次打开安装源配置
- **THEN** 页面显示 DSH 的默认公共源列表，仓库探测为开启

#### Scenario: 安装源地址校验

- **WHEN** 管理员提交非 http/https 地址、空列表项或空列表
- **THEN** 平台拒绝保存并指出出错的项，原设置和审计不变

### Requirement: 联网工具开关

后台 MUST 提供联网搜索和抓取工具的开关，作为单独的保存单元，默认关闭；接口为 `GET/PUT /_platform/api/admin/web-tools`，保存写入 `web-tools.updated` 审计。开关经受管配置下发，在实例下次启动时生效。

#### Scenario: 联网工具默认关闭

- **WHEN** 全新部署未修改开关时员工查看 Agent 可用工具
- **THEN** 没有联网搜索和抓取工具；管理员打开开关后员工重启实例，这两个工具出现

### Requirement: Document Server 配置页

后台 MUST 显示当前使用的是自带 Document Server 还是外部 Document Server；自带时显示部署配置是否齐全（容器名和 JWT 来自部署配置，地址由每个实例的布局决定），未配置时显示 Office 不可用。管理员 MUST 能填写外部 Document Server 的地址和 JWT 切换过去，或切回自带。接口为 `GET/PUT /_platform/api/admin/document-server`，保存写入 `document-server-config.updated` 审计。JWT MUST 只显示“已配置”。修改在实例下次启动时生效。

#### Scenario: 切换到外部 Document Server

- **WHEN** 管理员填写外部地址和 JWT 并保存，员工随后重启实例
- **THEN** 该实例的 Office 配置指向外部地址，平台不再把自带 Document Server 接入该实例网络

#### Scenario: 切回自带

- **WHEN** 管理员选择切回自带并保存
- **THEN** 外部地址和 JWT 被清除，之后启动的实例使用部署配置中的自带 Document Server

#### Scenario: 自带未配置时显示 Office 不可用

- **WHEN** 部署配置中没有 Document Server 的容器名和 JWT，管理员打开 Office 页
- **THEN** 页面显示当前为自带模式且未配置、Office 不可用，并允许填写外部 Document Server

#### Scenario: JWT 不回显

- **WHEN** 管理员保存后再次打开页面或读取配置接口
- **THEN** 只看到“已配置”，回应中没有 JWT 原文；部署配置中的自带 JWT 也不在页面出现

### Requirement: 新增配置页沿用后台变更约定

本阶段新增的各配置写接口 MUST 与模型配置、运行参数采用同一套约定：只有当前有效管理员可调用，读完请求体后在保存事务内重新校验管理员会话，配置与审计在同一事务内提交，审计失败则整体回滚；未知字段被拒绝；错误信息不含原始存储错误或凭据。各页面 MUST 区分加载中、空、请求失败状态，提交期间阻止重复或交叉提交，401 回到登录页，403 显示无权限且不显示数据。

#### Scenario: 提交期间被降权

- **WHEN** 管理员保存任一新增配置时，请求体收取期间账号被降权
- **THEN** 保存被拒绝，配置和审计都不变

#### Scenario: 审计失败回滚

- **WHEN** 保存任一新增配置时审计写入失败
- **THEN** 接口返回安全失败，配置保持保存前的值

#### Scenario: 页面布局与浏览器验证

- **WHEN** 管理员在真实浏览器以宽屏和窄屏打开各新增配置页
- **THEN** 页面使用既有后台侧栏导航和玻璃面板布局，无横向滚动，控制台无错误，截图留存
