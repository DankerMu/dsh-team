## MODIFIED Requirements

### Requirement: 记录的事件范围

平台 MUST 记录以下事件：注册、登录成功、登录失败、登出、改密码；管理员禁用、启用、重置密码、创建或提升管理员、修改模型配置、修改运行参数、修改 RAGFlow 连接配置、修改检索参数、修改插件目录、修改插件安装源与仓库探测、修改联网工具开关、修改 Document Server 配置、重启实例、重置实例配置；实例的创建、启动、就绪、停止（含原因：空闲、管理员、禁用、出错）和启动失败。

#### Scenario: 一次登录留下一条记录

- **WHEN** 员工登录成功
- **THEN** 审计里新增一条记录，含时间、该员工、事件类型“登录成功”和来源地址

#### Scenario: 代理之后记录真实来源

- **WHEN** 平台在受信代理之后，员工登录成功
- **THEN** 审计记录的来源地址是员工的地址，不是代理的地址

#### Scenario: 空闲回收留下原因

- **WHEN** 实例因空闲被停止
- **THEN** 审计里新增一条“实例停止”，原因为“空闲”

#### Scenario: 管理操作记录操作者和对象

- **WHEN** 管理员禁用一个员工
- **THEN** 审计记录里操作者是该管理员，对象是被禁用的员工

#### Scenario: 部署操作链完整覆盖事件

- **WHEN** 在自有真实Compose上执行19.6操作链，并通过HTTP、部署TTY和真实实例生命周期补齐重启、重置、空闲回收及其他声明事件
- **THEN** 完整原始审计中阶段 1 的十九种事件均存在，操作者、对象标识和邮箱准确，自动生命周期与终端管理的无平台操作者明确为NULL
- **AND** 停止原因覆盖空闲、管理员、禁用、出错；不直接插入审计、不伪造时钟或修改生产期限
- **AND** 所有原有及新增凭据和标记内容均不出现在完整审计与平台日志中，自有资源清理完成

#### Scenario: 新增配置修改各留一条记录

- **WHEN** 管理员依次保存 RAGFlow 连接配置、检索参数、插件目录、插件安装源与仓库探测、联网工具开关和 Document Server 配置
- **THEN** 审计里各新增一条对应事件，操作者为该管理员，对象为空
- **AND** 审计中不出现 RAGFlow 密钥、Document Server JWT 密钥或安装源地址中的凭据

### Requirement: 封闭事件写入边界

写入函数 MUST 仅接受以下事件标识：`account.registered`、`login.succeeded`、`login.failed`、`logout.succeeded`、`password.changed`、`account.disabled`、`account.enabled`、`password.reset`、`admin.created`、`admin.promoted`、`model-config.updated`、`runtime-config.updated`、`ragflow-config.updated`、`retrieval-config.updated`、`plugin-catalog.updated`、`plugin-sources.updated`、`web-tools.updated`、`document-server-config.updated`、`instance.restarted`、`instance.config-reset`、`instance.created`、`instance.started`、`instance.ready`、`instance.stopped`、`instance.start-failed`。函数 MUST 保留调用方提供的毫秒时间戳和身份/对象/来源元数据，省略的可选元数据存为 NULL。操作者和对象邮箱各自 MUST 不超过254个Unicode码点；任一超界 MUST 在插入前安全拒绝，不能截断、替换或静默省略。元数据由业务调用方选择，不是原始请求载荷；写入函数不承担任意元数据的秘密识别，也不新增邮箱格式或规范化规则。

#### Scenario: 每种事件保留元数据

- **WHEN** 逐一写入上述二十五种事件，提供时间戳、合规长度的操作者和对象邮箱、对象标识和来源地址，停止事件提供合法原因
- **THEN** 每次新增一行，事件和所提供的元数据准确保留；另一次省略可选元数据的写入将对应列存为 NULL

#### Scenario: 未知事件不产生记录

- **WHEN** 写入未列出的事件，包括 `toString`、`constructor` 或 `__proto__`
- **THEN** 写入失败且行数不变，错误不回显输入

#### Scenario: 细节先投影再序列化

- **WHEN** 写入细节包含 `password`、`token`、`cookie`、`apiKey`、凭据或内容载荷的事件
- **THEN** 持久化 JSON 中这些字段和值均不存在；没有允许细节字段的事件保存空对象，丢弃字段的嵌套值不被遍历

#### Scenario: 停止原因是唯一允许的细节

- **WHEN** 分别写入原因 `idle`、`admin`、`disabled`、`error` 的 `instance.stopped` 事件，并混入额外字段
- **THEN** 持久化 JSON 只保留对应 `reason`
- **AND** 缺失原因、非法字符串、对象或数组原因均导致写入失败，行数不变且错误不回显输入

#### Scenario: 启动失败只保留可选的封闭失败码

- **WHEN** 写入带失败码 `profile-incompatible` 并混入额外字段的 `instance.start-failed` 事件，以及不带细节的同一事件
- **THEN** 前者持久化 JSON 只保留 `code`，后者保存空对象；`instance.stopped` 的停止原因仍必填且校验不变
- **AND** 失败码为其他字符串、null、对象或数组时写入失败，行数不变且错误不回显输入

#### Scenario: 超界邮箱拒绝且调用方事务回滚

- **WHEN** 操作者或对象邮箱为255个码点，或NUL之后的字符使其超界
- **THEN** 写入失败且错误不回显输入，无新增审计行，所属事务内其他写入回滚
- **AND** 恰好254个码点（含补充平面字符）的元数据原样写入，缺省及空字符串语义不变

### Requirement: 管理员审计HTTP查询边界

平台 MUST 通过 `GET /_platform/api/admin/audit-events` 提供当前管理员专用查询，复用审计查询函数。回应 MUST 为 `{items,page,pageSize}`，页码默认1、页大小默认50且最多100；查询支持 `eventType,email,from,to`，时间使用包含端点的安全整数毫秒。HTTP邮箱筛选 MUST 去首尾空白并转小写后作精确匹配；未知条件和倒置时间范围返回空列表。非法分页、时间或不安全偏移 MUST 返回不回显输入的400。每条只返回既有审计元数据与闭合details对象，details只允许经过既有校验的停止reason和启动失败code（仅`profile-incompatible`）；存储/解析失败 MUST 安全500且不泄露原文。查询 MUST NOT 修改审计记录或引入审计写接口。

#### Scenario: 当前权限先于查询参数

- **WHEN** 未登录者或员工携带非法分页请求审计查询，或已有管理员会话的角色被降为员工
- **THEN** 未登录者401、员工403，不能通过参数错误或旧角色取得记录

#### Scenario: 筛选分页与安全详情经真实HTTP保持

- **WHEN** 管理员查询混合操作者/对象/事件/时间记录并翻页，包括同毫秒记录、双重邮箱匹配和停止事件
- **THEN** 结果保持筛选交集、邮箱OR不重复、包含时间端点和稳定倒序，每项只有允许元数据和安全reason或code，无内容或凭据字段，全部审计行不变

#### Scenario: 启动失败码经HTTP如实返回

- **WHEN** 管理员查询含`{"code":"profile-incompatible"}`细节和`{}`细节的`instance.start-failed`记录
- **THEN** 前者details为`{"code":"profile-incompatible"}`，后者为空对象；存储中非法的code导致安全500且不回显原文
