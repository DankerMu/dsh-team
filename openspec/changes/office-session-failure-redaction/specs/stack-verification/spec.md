## ADDED Requirements

### Requirement: Stack workbench failures carry no document key or query

本机全栈车道的浏览器会话失败，在 vitest 会打印的任何位置，都 SHALL NOT 出现文档 key 或 URL 查询串。这里的位置包括：

- 错误消息；
- 全部自有属性；
- 编辑器、改写和提示车道中失败匹配器的 diff。

失败消息 SHALL 仍然给出会话标签、计数和经过脱敏的失败原因，并且保持可读。仓库 SHALL 只保留一份脱敏实现。`officeEditorLine` 与 `officeRewriteLine` SHALL 只包含计数和经过该实现脱敏的列表。

#### Scenario: Office 会话因 Document Server socket 错误失败

- **WHEN** 编辑器、改写或提示车道的会话失败，并且会话的 console 错误、失败请求和 ≥400 响应中带有 `/doc/<key>/c/` 路径和带查询串的 URL
- **THEN** 抛出的错误的消息和全部自有属性中都不出现该 key 和查询串
- **AND** 消息仍然给出会话标签、计数和可读的脱敏失败原因

#### Scenario: 失败诊断保持可读

- **WHEN** 失败原因中含有 `#id` 定位器、焦点描述或 `ERR_*` 网络错误码
- **THEN** 脱敏后这些内容仍然保留
