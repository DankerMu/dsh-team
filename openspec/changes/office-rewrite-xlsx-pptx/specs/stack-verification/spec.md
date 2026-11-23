## ADDED Requirements

### Requirement: Office 改写车道覆盖 XLSX 与 PPTX

本机全栈 Office 改写车道除两个 DOCX 情形外，还 MUST 各有一个 XLSX、一个 PPTX 的干净改写情形：

- 初始文件取自 Document Server 自带的空白模板；
- Agent 的 `bash` 只用 Python 标准库 `zipfile` 原地改写其中一个 XML 部件，不改用户镜像；
- 断言的事实与 DOCX 干净情形一致：提示条、刷新次数、改写后/保存后/关闭后文件里各方的 nonce、`/data/work` 条目、允许的错误和 forgotten 副本；
- 锚点找不到或出现不止一次时，改写 MUST 以非零退出，且文件字节不变。

#### Scenario: 打开的 XLSX 被 Agent 改写

- **WHEN** 员工打开空白模板复制出的 `干净改写.xlsx`，Agent 改写它，员工随后键入并保存
- **THEN** 编辑器刷新一次，没有提示条；改写后文件只有 Agent 的 nonce，保存后和关闭后两方的 nonce 都在，`/data/work` 没有副本

#### Scenario: 打开的 PPTX 被 Agent 改写

- **WHEN** 员工打开空白模板复制出的 `干净改写.pptx`，Agent 改写它，员工随后键入并保存
- **THEN** 事实与 XLSX 情形、DOCX 干净情形相同

#### Scenario: 改写锚点不唯一

- **WHEN** 要改写的部件里锚点不存在或出现两次
- **THEN** 改写脚本非零退出，文件字节不变
