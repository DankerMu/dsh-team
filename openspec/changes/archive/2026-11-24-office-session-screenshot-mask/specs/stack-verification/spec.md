## ADDED Requirements

### Requirement: Office session screenshots mask the save-error notice

本机全栈车道里，会出现「保存未写回文件」提示条的 Office 浏览器会话（改写车道的 `clean`、`unsaved` 和 `typing` 用例，forgotten 车道的 edit 会话），其所有截图（包括失败截图）SHALL 遮罩该提示条。提示条显示的是插件 staleness guard 的原文，带有文档 key，截图像素中 SHALL NOT 留下这段文字。stack fixture 代码中的提示条文本 SHALL 只有一份定义。

#### Scenario: 改写会话截图遮罩提示条

- **WHEN** 改写车道的 `clean` 或 `unsaved` 用例打开编辑会话
- **THEN** 传给会话的截图遮罩里含有「保存未写回文件」提示条文本

#### Scenario: forgotten edit 会话截图遮罩提示条

- **WHEN** forgotten 车道打开刻意让保存被拒的 edit 会话
- **THEN** 传给会话的截图遮罩里含有「保存未写回文件」提示条文本
