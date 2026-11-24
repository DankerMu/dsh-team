## ADDED Requirements

### Requirement: Office 全栈车道检验用另一实例密钥算出的 key

本机全栈 Office 车道 MUST 在员工 B 的实例内，用 B 自己的每实例密钥，为员工 A 的文件算出 key；只要这个 key 被接受，车道 MUST 失败。如果所有实例共用同一个密钥，每一项这样的检验 MUST 失败。

#### Scenario: 跨实例 key 的 Command Service 查询

- **WHEN** A 和 B 都在编辑同名 DOCX，车道向 Command Service 查询 B 的密钥为 A 的文件算出的 key
- **THEN** 这个 key 与 A 的 key 不同，Command Service 回答未知 key；如果 A 和 B 的密钥相同，这项检验失败

#### Scenario: 跨实例 key 的保存回调

- **WHEN** 隔离车道用 B 的密钥为 A 的文件算出的 key，向 A 发送保存回调
- **THEN** A 把它当作未知 key；如果 A 和 B 的密钥相同，这项检验失败
