## MODIFIED Requirements

### Requirement: 原生隔离验证诊断不泄露输入或放宽判据

真实Yolo隔离验收 MUST 保留唯一原生调用及指定bash命令完全相等、turn关联、callId类型和调用时序判据。预期命令身份拒绝 MUST 仅提供本地计算的固定布尔分类，MUST NOT 输出输入命令、工具名、身份值、对话或未知错误内容；分类不构成历史失败根因证明。

唯一调用数判据失败（`permission-turn-call-count`）时，detail MUST 依次给出 `afterSeq` 之后 turn/start 和 tool/call 的数量、同一窗口内 `turn/end` 的固定结束分类，以及 `assistant/message` 的数量。结束分类 MUST 取自封闭集合 `completed|error|aborted|blocked|max-tokens|other|multiple|absent`：恰好一个 `turn/end` 时按其 `reason.kind` 映射，未列出的取值归为 `other`；没有 `turn/end` 为 `absent`，多于一个为 `multiple`。这些统计不按 turn id 过滤。detail MUST NOT 输出原始取值、错误码、错误消息、取消原因或其他事件内容。`provider-attempt` 检查 MUST 仍在调用数检查之前执行，判据本身不变。

#### Scenario: 指定命令或关联条件不匹配

- **WHEN** 完整原生记录中的turn、工具、指定命令、callId类型或调用顺序至少一项不符合原判据
- **THEN** 原`permission-intended-bash`拒绝保持，detail仅给出固定顺序的五个布尔结果，组合失败也不丢失分类
- **AND** 有效bash/write证据和原始其他错误路径不变，外来伪造错误不能提供诊断字段

#### Scenario: 模型结束回合但没有调用工具

- **WHEN** 第二组探针的回合以 `completed` 结束，有一条 assistant 消息，没有 tool/call
- **THEN** 验收以 `permission-turn-call-count` 失败，detail 为 `turn-start:1,tool-call:0,turn-end:completed,assistant-message:1`，不含任何事件内容

#### Scenario: 结束原因携带错误或取消内容

- **WHEN** `turn/end` 原因为 `error`（带错误码和消息）或 `aborted`（带 hook 原因字符串），没有 tool/call
- **THEN** detail 只给出 `turn-end:error` 或 `turn-end:aborted` 和计数，错误码、错误消息和 hook 原因都不出现

#### Scenario: 结束事件缺失、重复或未知

- **WHEN** 窗口内没有 `turn/end`、有两个 `turn/end`，或其 kind 不在封闭集合中、缺少原因或原因不是对象
- **THEN** detail 分别给出 `turn-end:absent`、`turn-end:multiple` 或 `turn-end:other`，失败码仍为 `permission-turn-call-count`
