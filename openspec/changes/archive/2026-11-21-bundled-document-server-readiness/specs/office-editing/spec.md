## ADDED Requirements

### Requirement: Document Server 启动窗口的静态说明

在 Session 中打开 docx、xlsx 或 pptx 的 Office 编辑器时，界面 MUST 在协作提示旁显示固定说明：「Office 服务刚启动或重启后约 2 分钟内，编辑器可能断开；如果断开，请稍后重新打开此文件，未保存的修改可能丢失。」该说明 MUST NOT 改变既有的协作提示和无 Session 提示的文字，也 MUST NOT 出现在无 Session 视图或编辑器未加载的退路视图中。

#### Scenario: 编辑器旁显示启动窗口说明

- **WHEN** 员工在 Session 中打开 docx、xlsx 或 pptx
- **THEN** 编辑器上方同时显示协作提示和启动窗口说明，两段文字与规定一致

#### Scenario: 无 Session 时不显示启动窗口说明

- **WHEN** 标签页没有 Session
- **THEN** 只显示无 Session 提示，不显示编辑器，也不显示启动窗口说明
