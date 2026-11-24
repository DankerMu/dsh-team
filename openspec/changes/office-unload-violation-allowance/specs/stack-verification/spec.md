## ADDED Requirements

### Requirement: Document Server 的 unload 违规按来源放行

本机全栈车道的浏览器会话中，控制台消息 `Permissions policy violation: unload is not allowed in this document.` SHALL 只在同时满足以下三个条件时放行：

- 来源在平台自身的 origin 上；
- 路径是 Document Server 9.4.0 挂载点下已实测的脚本之一：三个编辑器的 `Main.js`、`sdkjs/cell/sdk-all.js`、`sdkjs-plugins/v1/plugins.js`；
- 行号是该脚本已实测的行号。

放行的报告 SHALL NOT 计入 `consoleErrors`，SHALL 以 `<脚本路径>:<行号>` 记入该会话的 `unloadViolations`，不限次数。其他来源、行号或版本的同文本消息 SHALL 仍计入 `consoleErrors`，由各车道原有的精确白名单拒绝。这是用户在 #671 的决定（2026-11-23）。

#### Scenario: 已实测来源的违规被放行并记录

- **WHEN** Document Server 9.4.0 的 DOCX 编辑器在 `documenteditor/main/app/controller/Main.js` 的已实测行号上报告这条违规
- **THEN** 该会话的 `consoleErrors` 不含它
- **AND** `unloadViolations` 记录它的来源

#### Scenario: 未知来源的同文本违规被拒绝

- **WHEN** 同一文本来自其他脚本、其他行号、其他版本或其他 origin
- **THEN** 它计入 `consoleErrors`，车道原有的白名单使车道失败

#### Scenario: Chromium 153 下没有放行

- **WHEN** 浏览器不报告这条违规
- **THEN** 每个会话的 `unloadViolations` 为空，车道行为与之前一致
