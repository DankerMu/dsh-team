## ADDED Requirements

### Requirement: 从对话里的文件链接打开 Office 文件

员工点对话里指向工作目录中 DOCX、XLSX、PPTX 的文件链接时，MUST 和从文件区打开一样进入 Document Server 编辑器。链接给出的会话相对路径 MUST 按该 Session 的工作目录解析，解析后不在工作目录内的路径 MUST 被拒绝。

#### Scenario: 点对话里的 DOCX 链接进入编辑器

- **WHEN** Agent 在 `/data/work` 生成 `工作通知.docx`，员工点回复里的这个文件链接
- **THEN** 编辑器正常打开，不出现「无法获取编辑器配置」，文件内容不变

#### Scenario: 越出工作目录的相对路径被拒绝

- **WHEN** 编辑器配置请求带的路径是 `../其他.docx` 这类解析后位于工作目录之外的相对路径
- **THEN** 请求被拒绝，不生成编辑器配置
