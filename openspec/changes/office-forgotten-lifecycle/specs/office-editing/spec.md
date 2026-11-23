## ADDED Requirements

### Requirement: Forgotten 副本的去向有实测并写入文档

本机全栈车道 SHALL 在保存被拒后会话关闭的 Office 用例中，记录该会话的 key 是否在自带 Document Server 的 forgotten 存储里留下副本：

- 「AI 改写正在编辑的文件」的 `clean`、`unsaved` 和 typing 用例；
- forgotten 用例的恢复会话。

证据只含计数和布尔值，SHALL NOT 含 key、JWT 或文件内容。

这些用例成功结束时 SHALL 移除自己留下的副本，并断言该 key 的副本数为 0、列表不再含该 key。计数按 key 统计：其他车道的会话异步关闭，会在任意时刻往存储里落下自己的副本，全局目录数不能作基线。失败时 SHALL 尽力清理，并原样抛出原错误。

员工指南和部署文档 SHALL 与实测一致，写明：

- 副本的位置；
- 副本没有过期；
- 只有运营方能访问；
- 运营方的清理办法，包括 Document Server 匿名卷在一次性清理中的处置。

#### Scenario: AI 改写丢弃了未保存的编辑

- **WHEN** 员工在 ONLYOFFICE 中有未保存的编辑，Agent 改写了同一个 DOCX，编辑器换到改写后的版本
- **THEN** 车道在结算窗口后记录旧 key 的 forgotten 副本是否存在（目录增量和列表布尔值），随后移除它，该 key 的副本数为 0，列表不再含该 key

#### Scenario: forgotten 用例成功结束

- **WHEN** forgotten 用例完成恢复
- **THEN** 用例记录恢复会话关闭后 A 的 key 是否仍有副本，移除后该 key 的副本数为 0

#### Scenario: 用例在已知 key 之后失败

- **WHEN** 改写、typing 或 forgotten 用例在读到会话 key 之后失败
- **THEN** 用例在结算窗口后尽力移除该 key 的副本，并原样抛出原错误，不包装、不改写消息
