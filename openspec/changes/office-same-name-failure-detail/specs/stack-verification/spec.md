## ADDED Requirements

### Requirement: 同名 DOCX 失败给出每一侧的原因

编辑器车道的同名 DOCX 情形中，A、B 两个编辑会话同时进行。任一侧失败时，抛出错误的消息 SHALL 依次给出每个失败侧的标签（`A` 或 `B`）和该侧经过脱敏的失败原因链，只列出失败的一侧。消息 SHALL NOT 含有文档 key 或 URL 查询串。错误 SHALL 仍是 `AggregateError`，`errors` 保留每个失败侧原始的失败，A 在前。

#### Scenario: 两侧都失败

- **WHEN** A、B 两个编辑会话都因带 `/doc/<key>/c/` 路径和查询串的错误失败
- **THEN** 抛出错误的消息依次给出 `A:` 和 `B:` 各自脱敏后的失败原因
- **AND** 该错误的消息和全部自有属性中都不出现 key 和查询串

#### Scenario: 只有一侧失败

- **WHEN** A 的会话成功，B 的会话失败
- **THEN** 消息只给出 `B:` 和它脱敏后的失败原因
