## ADDED Requirements

### Requirement: 知识库文件只读预览

员工在「知识库」面板点击文件名时，面板 MUST 显示该文件解析后的内容。

- 内容按顺序以纯文本显示，超过一页时可以翻页。
- 预览 MUST 区分加载中、无内容、失败可重试、知识库未配置。
- 预览 MUST NOT 提供编辑、上传或下载原件的入口。
- 预览 MUST NOT 改变检索范围。
- 「返回列表」MUST 回到原来的列表状态。

#### Scenario: 预览一个文件

- **WHEN** 员工在 `dsh-team-seed-policies` 中点击 `expense-policy.txt`
- **THEN** 面板显示该文件名和它解析后的文本内容，没有编辑或下载入口

#### Scenario: 内容按纯文本显示

- **WHEN** 某个分块的文本是 `<b>x</b>`
- **THEN** 预览原样显示这几个字符，不把它当作 HTML

#### Scenario: RAGFlow 中断时预览失败可重试

- **WHEN** RAGFlow 不可用时员工打开预览
- **THEN** 面板显示失败可重试，工作台其他功能照常
