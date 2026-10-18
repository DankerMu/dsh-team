## ADDED Requirements

### Requirement: 模型配置写入口拒绝未知条目字段

平台的 `PUT /_platform/api/admin/model-config` MUST 仅允许每个模型条目包含 `name` 和可选 `contextWindow`，与发布的请求schema一致。任一条目的未知字段 MUST 导致安全400，设置行和审计行均不变；顶层未知字段仍 MUST 被拒绝。合法字段的类型、值域、默认模型约束、密钥保护、授权和响应投影 MUST 保持原有规则。共享存储读取 MUST 保持对历史额外条目字段的投影兼容，不因本HTTP策略新增拒绝或自动改写历史行。

#### Scenario: 拼错字段拒绝整个配置且无副作用

- **WHEN** 当前管理员提交模型 `{name:"alpha",contextwindow:500000}`，或后续模型条目含未知字段，即使同时包含合法contextWindow
- **THEN** 返回不回显输入的400，原设置、密钥和完整审计记录不变
- **AND** 使用正确contextWindow的合法请求仍保存并准确返回该值，未知顶层字段仍400

#### Scenario: 旧存储额外字段保持可读而不扩大回应

- **WHEN** 已有模型设置的已知字段合法，但包含额外条目字段，管理员读取配置
- **THEN** 读取成功且模型回应仅含合法name/contextWindow，不泄露额外字段或密钥，原设置行与审计行均不变
