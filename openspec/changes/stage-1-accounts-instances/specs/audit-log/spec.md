# audit-log

## Purpose

记录谁在什么时候做了哪些账号、管理和实例层面的操作，供管理员排查；不记录任何内容和凭据。

## ADDED Requirements

### Requirement: 记录的事件范围

平台 MUST 记录以下事件：注册、登录成功、登录失败、登出、改密码；管理员禁用、启用、重置密码、创建或提升管理员、修改模型配置、修改运行参数、重启实例、重置实例配置；实例的创建、启动、就绪、停止（含原因：空闲、管理员、禁用、出错）和启动失败。

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

### Requirement: 封闭事件写入边界

写入函数 MUST 仅接受以下事件标识：`account.registered`、`login.succeeded`、`login.failed`、`logout.succeeded`、`password.changed`、`account.disabled`、`account.enabled`、`password.reset`、`admin.created`、`admin.promoted`、`model-config.updated`、`runtime-config.updated`、`instance.restarted`、`instance.config-reset`、`instance.created`、`instance.started`、`instance.ready`、`instance.stopped`、`instance.start-failed`。函数 MUST 保留调用方提供的毫秒时间戳和身份/对象/来源元数据，省略的可选元数据存为 NULL。元数据由业务调用方选择，不是原始请求载荷；写入函数不承担任意元数据的秘密识别。

#### Scenario: 每种事件保留元数据

- **WHEN** 逐一写入上述十九种事件，提供时间戳、操作者、对象邮箱、对象标识和来源地址，停止事件提供合法原因
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

### Requirement: 不记录内容和凭据

审计记录和平台日志 MUST NOT 包含密码、平台会话令牌、DSH 启动令牌、DSH cookie、模型密钥，以及任何对话内容和文件内容。

#### Scenario: 登录失败不记录尝试的密码

- **WHEN** 有人用错误密码登录失败
- **THEN** 审计记录里有这次失败和所用的邮箱，没有所尝试的密码

#### Scenario: 全量扫描找不到凭据

- **WHEN** 完成注册、登录、对话、改密码、修改模型配置、禁用账号这一整套操作后，在审计表和平台日志里搜索这些操作中用到的每一个密码、令牌、cookie 和密钥的原文
- **THEN** 一处都找不到

#### Scenario: 对话内容不在审计里

- **WHEN** 员工发送一条包含特定标记字符串的消息后，在审计表和平台日志里搜索该标记
- **THEN** 找不到

### Requirement: 管理员查询审计

管理员 MUST 能在后台按时间倒序查看审计记录，并按事件类型、账号邮箱和时间范围筛选、分页。

#### Scenario: 按账号筛选

- **WHEN** 管理员按某员工的邮箱筛选
- **THEN** 只显示该员工作为操作者或对象的记录

#### Scenario: 员工不能查看审计

- **WHEN** 员工请求审计接口
- **THEN** 返回 403

### Requirement: 审计不可经接口修改

平台 MUST NOT 提供修改或删除审计记录的接口。

#### Scenario: 没有写接口

- **WHEN** 检查平台接口契约
- **THEN** 审计相关的接口只有查询
