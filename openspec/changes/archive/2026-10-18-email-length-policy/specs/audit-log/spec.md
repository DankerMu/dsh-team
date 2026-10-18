## MODIFIED Requirements

### Requirement: 封闭事件写入边界

写入函数 MUST 仅接受以下事件标识：`account.registered`、`login.succeeded`、`login.failed`、`logout.succeeded`、`password.changed`、`account.disabled`、`account.enabled`、`password.reset`、`admin.created`、`admin.promoted`、`model-config.updated`、`runtime-config.updated`、`instance.restarted`、`instance.config-reset`、`instance.created`、`instance.started`、`instance.ready`、`instance.stopped`、`instance.start-failed`。函数 MUST 保留调用方提供的毫秒时间戳和身份/对象/来源元数据，省略的可选元数据存为 NULL。操作者和对象邮箱各自 MUST 不超过254个Unicode码点；任一超界 MUST 在插入前安全拒绝，不能截断、替换或静默省略。元数据由业务调用方选择，不是原始请求载荷；写入函数不承担任意元数据的秘密识别，也不新增邮箱格式或规范化规则。

#### Scenario: 每种事件保留元数据

- **WHEN** 逐一写入上述十九种事件，提供时间戳、合规长度的操作者和对象邮箱、对象标识和来源地址，停止事件提供合法原因
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

#### Scenario: 超界邮箱拒绝且调用方事务回滚

- **WHEN** 操作者或对象邮箱为255个码点，或NUL之后的字符使其超界
- **THEN** 写入失败且错误不回显输入，无新增审计行，所属事务内其他写入回滚
- **AND** 恰好254个码点（含补充平面字符）的元数据原样写入，缺省及空字符串语义不变

## ADDED Requirements

### Requirement: 历史超界审计证据保留

平台 MUST 保留已有超界审计邮箱原文，并支持不按邮箱以及按事件、时间查询这些记录。历史审计超界 MUST NOT 单独导致平台拒绝启动。HTTP邮箱筛选仍限定原始查询值最多254个Unicode码点，再去首尾空白并转小写进行精确匹配；超界筛选 MUST 返回安全400，不截断或假装匹配原记录。离线更正账号邮箱 MUST NOT 自动重写历史审计身份。

#### Scenario: 历史证据可浏览但不伪造邮箱匹配

- **WHEN** 历史审计包含一个超界邮箱，管理员按事件与时间查询，随后用完整超界邮箱及其合规前缀筛选
- **THEN** 事件与时间查询返回完整历史邮箱且数据不变，完整超界筛选返回400，前缀筛选不匹配该历史邮箱
- **AND** 恰好254个码点的补充平面邮箱筛选仍可精确匹配操作者或对象，无重复记录
