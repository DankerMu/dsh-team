## ADDED Requirements

### Requirement: Agent 可以列出本轮范围内的知识库和文件

插件 MUST 提供 Agent 工具 `knowledge_base_list`。

- 不指定库时，它列出本轮检索范围内的知识库名称。
- 指定库名时，它列出该库的文件名，支持文件名关键字和分页。
- 范围的确定方式 MUST 与检索工具相同：子 Agent 使用委派时记录的根 Session 范围，MUST NOT 扩大。
- 范围外的库与不存在的库 MUST 返回相同的结果。
- 结果 MUST 只包含名称，MUST NOT 包含库或文件的 ID。

#### Scenario: 问知识库里有什么

- **WHEN** 本轮范围只选了 `dsh-team-seed-policies`，员工问「知识库里有哪些文件」，Agent 先不带库名调用、再带该库名调用 `knowledge_base_list`
- **THEN** 第一次结果只有 `dsh-team-seed-policies`，第二次结果是该库的两个文件名，总数 2

#### Scenario: 范围外的库不可见

- **WHEN** 本轮范围只选了库 A，Agent 调用 `knowledge_base_list` 并指定库 B 的名称
- **THEN** 结果与指定一个不存在的库名相同，不发出 B 的文件列表请求

#### Scenario: 没有选择知识库

- **WHEN** 本轮取消了全选，Agent 调用 `knowledge_base_list`
- **THEN** 结果为本轮没有选择知识库，不发出任何请求
